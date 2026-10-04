package dev.herenfor.epubreader

import android.app.Activity
import android.net.Uri
import android.os.ParcelFileDescriptor
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
            val afd = activity.contentResolver.openAssetFileDescriptor(
                Uri.parse(uri),
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
