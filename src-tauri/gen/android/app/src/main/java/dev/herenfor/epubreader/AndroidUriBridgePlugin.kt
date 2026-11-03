package dev.herenfor.epubreader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray

@InvokeArg
class OpenReadOnlyArgs {
    lateinit var uri: String
}

@InvokeArg
class WriteTextArgs {
    lateinit var uri: String
    lateinit var text: String
}

@InvokeArg
class WriteStagedFileArgs {
    lateinit var uri: String
    lateinit var sourcePath: String
    lateinit var jobId: String
}

@InvokeArg
class CancelWriteArgs {
    lateinit var jobId: String
    var cancelled: Boolean = true
}

@InvokeArg
class QueryTreeDirectoryArgs {
    lateinit var treeUri: String
    var parentDocumentId: String? = null
}

/**
 * App-local Android content-URI bridge.
 *
 * Read requests open an `AssetFileDescriptor` on a private worker and hand the
 * detached fd plus range metadata to Rust. Text writes keep the descriptor in
 * Kotlin and use `AutoCloseOutputStream`, so close errors are reported before
 * the command resolves.
 */
@TauriPlugin
class AndroidUriBridgePlugin(private val activity: Activity) : Plugin(activity) {
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "android-uri-bridge").apply { isDaemon = true }
    }
    private val cancelledWrites = ConcurrentHashMap<String, Boolean>()
    private var pendingTreePick: Invoke? = null
    private var pendingDocumentPick = false
    private var persistTreePick = false

    @Command
    fun pickLinkDocuments(invoke: Invoke) {
        activity.runOnUiThread {
            if (pendingDocumentPick || pendingTreePick != null) {
                invoke.reject("document picker is already active")
                return@runOnUiThread
            }
            pendingDocumentPick = true
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }
                startActivityForResult(invoke, intent, "linkDocumentsResult")
            } catch (error: Exception) {
                pendingDocumentPick = false
                invoke.reject(error.message ?: "unable to open document picker")
            }
        }
    }

    @ActivityCallback
    fun linkDocumentsResult(invoke: Invoke, result: ActivityResult) {
        pendingDocumentPick = false
        val intent = result.data
        val uris = linkedSetOf<Uri>()
        if (result.resultCode == Activity.RESULT_OK && intent != null) {
            intent.data?.let { uris.add(it) }
            intent.clipData?.let { clips ->
                for (i in 0 until clips.itemCount) clips.getItemAt(i).uri?.let { uris.add(it) }
            }
        }
        // The import job will retain a grant only when it owns a successful
        // binding. Returning from the picker alone never persists permission.
        ioExecutor.execute {
            val documents = JSONArray()
            for (uri in uris) {
                if (uri.scheme != "content") continue
                documents.put(JSObject().apply {
                    put("uri", uri.toString())
                    queryDisplayName(uri)?.let { put("fileName", it) }
                })
            }
            postResponse { invoke.resolve(JSObject().apply { put("documents", documents) }) }
        }
    }

    @Command
    fun pickDirectoryTree(invoke: Invoke) = startTreePicker(invoke, false)

    @Command
    fun pickWatchedDirectory(invoke: Invoke) = startTreePicker(invoke, true)

    @Command
    fun releaseWatchedDirectory(invoke: Invoke) {
        val uri = Uri.parse(invoke.parseArgs(OpenReadOnlyArgs::class.java).uri)
        try {
            activity.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            invoke.resolve(JSObject())
        } catch (_: SecurityException) {
            // Already revoked.
            invoke.resolve(JSObject())
        }
    }

    private fun startTreePicker(invoke: Invoke, persist: Boolean) {
        activity.runOnUiThread {
            if (pendingTreePick != null || pendingDocumentPick) {
                invoke.reject("directory picker is already active")
                return@runOnUiThread
            }
            pendingTreePick = invoke
            persistTreePick = persist
            try {
                // Plugins load after Activity.onStart: use Tauri's existing
                // activity-result registry instead of registering a launcher here.
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
                }
                startActivityForResult(invoke, intent, "directoryTreeResult")
            } catch (error: Exception) {
                pendingTreePick = null
                invoke.reject(error.message ?: "unable to open directory picker")
            }
        }
    }

    @ActivityCallback
    fun directoryTreeResult(invoke: Invoke, result: ActivityResult) {
        pendingTreePick = null
        val response = JSObject()
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { uri ->
                if (persistTreePick) {
                    try {
                        activity.contentResolver.takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    } catch (error: SecurityException) {
                        invoke.reject(error.message ?: "unable to retain directory permission")
                        return
                    }
                }
                response.put("uri", uri.toString())
            }
        }
        invoke.resolve(response)
    }

    @Command
    fun queryTreeDirectory(invoke: Invoke) {
        val args = invoke.parseArgs(QueryTreeDirectoryArgs::class.java)
        ioExecutor.execute {
            queryTreeDirectoryOnWorker(invoke, args.treeUri, args.parentDocumentId)
        }
    }

    @Command
    fun openReadOnly(invoke: Invoke) {
        val args = invoke.parseArgs(OpenReadOnlyArgs::class.java)
        ioExecutor.execute {
            openReadOnlyOnWorker(invoke, args.uri)
        }
    }

    private fun openReadOnlyOnWorker(invoke: Invoke, uri: String) {
        var rawFd = -1
        try {
            val parsedUri = Uri.parse(uri)
            val displayName = queryDisplayName(parsedUri)
            val afd = activity.contentResolver.openAssetFileDescriptor(
                parsedUri,
                "r"
            ) ?: throw IOException("content provider returned no file descriptor")
            try {
                val pfd = afd.parcelFileDescriptor
                    ?: throw IOException("content provider returned no parcel file descriptor")
                val startOffset = afd.startOffset
                val declaredLength = afd.declaredLength
                rawFd = pfd.detachFd()

                val result = JSObject().apply {
                    put("fd", rawFd)
                    put("startOffset", startOffset)
                    put("declaredLength", declaredLength)
                    if (displayName != null) put("displayName", displayName)
                }
                postResponse { invoke.resolve(result) }
                // `resolve` has been posted and now owns the fd. Do not close it
                // here, otherwise Rust could receive a closed descriptor.
                rawFd = -1
            } finally {
                try {
                    afd.close()
                } catch (_: Throwable) {
                    // The fd was detached above; a close failure must not leak
                    // Rust's ownership or turn a successful open into a reject.
                }
            }
        } catch (error: Throwable) {
            if (rawFd >= 0) {
                closeRawFd(rawFd)
            }
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            postResponse { invoke.reject(message) }
        }
    }

    // Display names are metadata, not URI paths. Some providers omit the
    // column; that must not prevent an otherwise readable document import.
    private fun queryDisplayName(uri: Uri): String? = try {
        val column = DocumentsContract.Document.COLUMN_DISPLAY_NAME
        activity.contentResolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(column)
            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
        }
    } catch (_: Exception) {
        null
    }

    @Command
    fun writeText(invoke: Invoke) {
        val args = invoke.parseArgs(WriteTextArgs::class.java)
        ioExecutor.execute {
            writeTextOnWorker(invoke, args.uri, args.text)
        }
    }

    private fun writeTextOnWorker(invoke: Invoke, uri: String, text: String) {
        try {
            val bytes = text.toByteArray(Charsets.UTF_8)
            val pfd = activity.contentResolver.openFileDescriptor(Uri.parse(uri), "wt")
                ?: throw IOException("content provider returned no write descriptor")
            // AutoCloseOutputStream owns the fd and close errors must propagate
            // before the invoke is resolved as successful.
            ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { output ->
                output.write(bytes)
            }
            postResponse { invoke.resolve(JSObject()) }
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            postResponse { invoke.reject(message) }
        }
    }

    @Command
    fun writeStagedFile(invoke: Invoke) {
        val args = invoke.parseArgs(WriteStagedFileArgs::class.java)
        ioExecutor.execute {
            writeStagedFileOnWorker(invoke, args.uri, args.sourcePath, args.jobId)
        }
    }

    @Command
    fun deleteCreatedDocument(invoke: Invoke) {
        val args = invoke.parseArgs(OpenReadOnlyArgs::class.java)
        ioExecutor.execute {
            try {
                val uri = Uri.parse(args.uri)
                if (uri.scheme != "content") throw IOException("only content URIs are accepted")
                val deleted = if (DocumentsContract.isDocumentUri(activity, uri)) {
                    DocumentsContract.deleteDocument(activity.contentResolver, uri)
                } else {
                    activity.contentResolver.delete(uri, null, null) > 0
                }
                if (!deleted) throw IOException("provider did not remove the incomplete output")
                postResponse { invoke.resolve(JSObject()) }
            } catch (error: Throwable) {
                postResponse { invoke.reject(error.message ?: error.toString()) }
            }
        }
    }

    @Command
    fun cancelWrite(invoke: Invoke) {
        val args = invoke.parseArgs(CancelWriteArgs::class.java)
        if (args.cancelled) cancelledWrites[args.jobId] = true
        else cancelledWrites.remove(args.jobId)
        postResponse { invoke.resolve(JSObject()) }
    }

    private fun writeStagedFileOnWorker(
        invoke: Invoke,
        uri: String,
        sourcePath: String,
        jobId: String
    ) {
        try {
            val source = File(sourcePath).canonicalFile
            val stagingRoot = File(activity.cacheDir, "save-file-staging").canonicalFile
            if (source.parentFile != stagingRoot) {
                throw IOException("staged source is outside save-file-staging")
            }
            if (!source.isFile) {
                throw IOException("staged source is not a regular file")
            }
            FileInputStream(source).use { input ->
                val pfd = activity.contentResolver.openFileDescriptor(Uri.parse(uri), "wt")
                    ?: throw IOException("content provider returned no write descriptor")
                // AutoCloseOutputStream owns the fd; close failures must reject
                // before Rust can treat the destination as complete.
                ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelledWrites[jobId] == true) {
                            throw IOException("cancelled")
                        }
                        val read = input.read(buffer)
                        if (read < 0) {
                            break
                        }
                        output.write(buffer, 0, read)
                    }
                }
            }
            postResponse { invoke.resolve(JSObject()) }
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            postResponse { invoke.reject(message) }
        } finally {
            cancelledWrites.remove(jobId)
        }
    }

    private fun queryTreeDirectoryOnWorker(
        invoke: Invoke,
        treeUri: String,
        requestedParentDocumentId: String?
    ) {
        try {
            val tree = Uri.parse(treeUri)
            val parentDocumentId = requestedParentDocumentId
                ?.takeIf { it.isNotBlank() }
                ?: DocumentsContract.getTreeDocumentId(tree)
            val parentDocumentUri = DocumentsContract.buildDocumentUriUsingTree(
                tree,
                parentDocumentId
            )
            val parentDisplayName = queryDocumentDisplayName(parentDocumentUri) ?: ""
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                tree,
                parentDocumentId
            )
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            )
            val entries = JSONArray()
            val cursor = activity.contentResolver.query(
                childrenUri,
                projection,
                null,
                null,
                null
            ) ?: throw IOException("content provider returned no cursor")
            cursor.use {
                val idIndex = it.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID
                )
                val nameIndex = it.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME
                )
                val mimeIndex = it.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_MIME_TYPE
                )
                val sizeIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                val modifiedIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                while (it.moveToNext()) {
                    val documentId = it.getString(idIndex) ?: continue
                    val mimeType = it.getString(mimeIndex) ?: ""
                    val displayName = it.getString(nameIndex) ?: documentId
                    val documentUri = DocumentsContract.buildDocumentUriUsingTree(
                        tree,
                        documentId
                    )
                    val entry = JSObject().apply {
                        put("documentId", documentId)
                        put("uri", documentUri.toString())
                        put("displayName", displayName)
                        put("mimeType", mimeType)
                        put(
                            "isDirectory",
                            mimeType == DocumentsContract.Document.MIME_TYPE_DIR
                        )
                        if (modifiedIndex >= 0 && !it.isNull(modifiedIndex)) {
                            val modified = it.getLong(modifiedIndex)
                            if (modified > 0) put("lastModified", modified)
                        }
                        if (sizeIndex >= 0 && !it.isNull(sizeIndex)) {
                            val size = it.getLong(sizeIndex)
                            if (size >= 0) put("size", size)
                        }
                    }
                    entries.put(entry)
                }
            }
            val response = JSObject().apply {
                put("parentDisplayName", parentDisplayName)
                put("entries", entries)
            }
            postResponse { invoke.resolve(response) }
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            postResponse { invoke.reject(message) }
        }
    }

    private fun queryDocumentDisplayName(uri: Uri): String? {
        val projection = arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        return try {
            activity.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)
                } else {
                    null
                }
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun postResponse(action: () -> Unit) {
        try {
            activity.runOnUiThread(action)
        } catch (_: Throwable) {
            // The activity may already be finishing; still deliver the response
            // so Rust does not block forever waiting for its command.
            action()
        }
    }

    private fun closeRawFd(fd: Int) {
        try {
            ParcelFileDescriptor.adoptFd(fd).close()
        } catch (_: Throwable) {
            // Keep the original provider error/reject; a second close failure
            // must not replace it.
        }
    }
}
