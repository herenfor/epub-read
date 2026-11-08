package dev.herenfor.epubreader

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.Os
import androidx.core.content.FileProvider
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@InvokeArg
class ImageRequestArgs {
    var path: String = ""
    var mime: String = ""
    var filename: String = ""
    var text: String? = null
}

/**
 * Shares or saves one image that Rust already wrote under cache/image-share.
 *
 * The invoke carries a checked path and metadata only. Bytes stay in that file
 * and are copied with a fixed buffer into the share URI or MediaStore stream.
 * API 24–28 asks for the legacy write permission once, on save, and resumes
 * the same invoke. A second save waiting on that dialog is rejected.
 */
@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE],
            alias = ImageSharePlugin.GALLERY_PERMISSION,
        ),
    ],
)
class ImageSharePlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "image-share").apply { isDaemon = true }
    }
    private val permissionWait = AtomicReference<Invoke?>(null)

    @Command
    fun share(invoke: Invoke) {
        val once = AtomicBoolean(false)
        val args = try {
            invoke.parseArgs(ImageRequestArgs::class.java)
        } catch (error: Throwable) {
            resolve(invoke, once, false, errorCode(error), null)
            return
        }
        try {
            io.execute {
                try {
                    shareOnIo(invoke, once, args)
                } catch (error: Throwable) {
                    resolve(invoke, once, false, errorCode(error), null)
                }
            }
        } catch (error: RejectedExecutionException) {
            resolve(invoke, once, false, "io", null)
        }
    }

    @Command
    fun save(invoke: Invoke) {
        val once = AtomicBoolean(false)
        val args = try {
            invoke.parseArgs(ImageRequestArgs::class.java)
        } catch (error: Throwable) {
            resolve(invoke, once, false, errorCode(error), null)
            return
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            getPermissionState(GALLERY_PERMISSION) != PermissionState.GRANTED
        ) {
            if (!permissionWait.compareAndSet(null, invoke)) {
                resolve(invoke, once, false, "io", null)
                return
            }
            try {
                if (!isPermissionDeclared(GALLERY_PERMISSION)) {
                    permissionWait.compareAndSet(invoke, null)
                    resolve(invoke, once, false, "io", null)
                    return
                }
                requestPermissionForAlias(GALLERY_PERMISSION, invoke, "galleryPermissionResult")
            } catch (error: Throwable) {
                permissionWait.compareAndSet(invoke, null)
                resolve(invoke, once, false, errorCode(error), null)
            }
            return
        }
        publishOnIo(invoke, once, args)
    }

    @PermissionCallback
    fun galleryPermissionResult(invoke: Invoke) {
        if (!permissionWait.compareAndSet(invoke, null)) {
            return
        }
        val once = AtomicBoolean(false)
        try {
            if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P ||
                getPermissionState(GALLERY_PERMISSION) != PermissionState.GRANTED
            ) {
                val code = if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) "io" else "permission"
                resolve(invoke, once, false, code, null)
                return
            }
            publishOnIo(invoke, once, invoke.parseArgs(ImageRequestArgs::class.java))
        } catch (error: Throwable) {
            resolve(invoke, once, false, errorCode(error), null)
        }
    }

    private fun shareOnIo(invoke: Invoke, once: AtomicBoolean, args: ImageRequestArgs) {
        val file = requireOwnedCacheFile(args.path)
        val mime = requireMime(args.mime)
        if (file.length() <= 0L || file.length() > MAX_BYTES) throw IOException("size")
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            val caption = args.text
            if (!caption.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, caption)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newUri(activity.contentResolver, "image", uri)
        }
        val chooser = Intent.createChooser(send, null).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = send.clipData
        }
        activity.runOnUiThread {
            try {
                activity.startActivity(chooser)
            } catch (error: Throwable) {
                resolve(invoke, once, false, errorCode(error), null)
                return@runOnUiThread
            }
            resolve(invoke, once, true, null, null)
        }
    }

    private fun publishOnIo(invoke: Invoke, once: AtomicBoolean, args: ImageRequestArgs) {
        try {
            io.execute {
                try {
                    resolve(invoke, once, true, null, publish(args))
                } catch (error: Throwable) {
                    resolve(invoke, once, false, errorCode(error), null)
                }
            }
        } catch (error: RejectedExecutionException) {
            resolve(invoke, once, false, "io", null)
        }
    }

    private fun publish(args: ImageRequestArgs): String {
        val source = requireOwnedCacheFile(args.path)
        val mime = requireMime(args.mime)
        val displayName = requireDisplayName(args.filename, mime)
        if (source.length() <= 0L || source.length() > MAX_BYTES) throw IOException("size")
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            publishPending(source, displayName, mime)
        } else {
            publishLegacy(source, displayName, mime)
        }
    }

    private fun publishPending(source: File, displayName: String, mime: String): String {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/SeLis")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        var uri: Uri? = null
        try {
            uri = resolver.insert(collection, values) ?: throw IOException("insert")
            resolver.openOutputStream(uri)?.use { output ->
                copyStream(source, output)
            } ?: throw IOException("stream")
            val published = ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }
            if (resolver.update(uri, published, null, null) != 1) throw IOException("publish")
            return uri.toString()
        } catch (error: Throwable) {
            uri?.let { runCatching { resolver.delete(it, null, null) } }
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun publishLegacy(source: File, displayName: String, mime: String): String {
        val dir = legacyDirectory()
        val created = createUniqueFile(dir, displayName)
        var row: Uri? = null
        try {
            FileOutputStream(created).use { output ->
                copyStream(source, output)
                output.fd.sync()
            }
            created.setReadable(true, false)
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, created.name)
                put(MediaStore.Images.Media.MIME_TYPE, mime)
                put(MediaStore.Images.Media.DATA, created.absolutePath)
                put(MediaStore.Images.Media.DATE_ADDED, System.currentTimeMillis() / 1000)
            }
            row = activity.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("insert")
            return row.toString()
        } catch (error: Throwable) {
            row?.let { runCatching { activity.contentResolver.delete(it, null, null) } }
            created.delete()
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyDirectory(): File {
        val pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
        val dir = File(pictures, "SeLis")
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("mkdir")
        if (isSymlink(dir)) throw IOException("symlink")
        val picturesCanon = pictures.canonicalFile
        val dirCanon = dir.canonicalFile
        if (dirCanon.parentFile?.canonicalPath != picturesCanon.canonicalPath) throw IOException("escape")
        dirCanon.setReadable(true, false)
        dirCanon.setExecutable(true, false)
        return dirCanon
    }

    private fun createUniqueFile(dir: File, displayName: String): File {
        val dot = displayName.lastIndexOf('.')
        if (dot <= 0 || dot == displayName.lastIndex) throw IOException("name")
        val stem = displayName.substring(0, dot)
        val extension = displayName.substring(dot)
        var index = 0
        while (index < 10000) {
            val name = if (index == 0) displayName else "$stem-$index$extension"
            if (name.length > 255 || name.contains('/') || name.contains('\\')) throw IOException("name")
            val candidate = File(dir, name)
            if (candidate.canonicalFile.parentFile?.canonicalPath != dir.canonicalPath) {
                throw IOException("escape")
            }
            if (candidate.createNewFile()) return candidate
            index += 1
        }
        throw IOException("name")
    }

    private fun copyStream(source: File, output: OutputStream) {
        val expected = source.length()
        FileInputStream(source).use { input ->
            val buffer = ByteArray(COPY_BUFFER)
            var copied = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                output.write(buffer, 0, read)
                copied += read.toLong()
                if (copied > expected) throw IOException("long")
            }
            output.flush()
            if (copied != expected) throw IOException("short")
        }
    }

    private fun requireOwnedCacheFile(path: String): File {
        if (path.isEmpty() || path.indexOf('\u0000') >= 0) throw IOException("path")
        val root = File(activity.cacheDir, IMAGE_SHARE_DIR).canonicalFile
        val requested = File(path)
        if (isSymlink(requested)) throw IOException("symlink")
        val parent = requested.parentFile ?: throw IOException("parent")
        if (isSymlink(parent)) throw IOException("symlink")
        if (!requested.isFile) throw IOException("file")
        val file = requested.canonicalFile
        val parentCanon = file.parentFile ?: throw IOException("parent")
        val grand = parentCanon.parentFile ?: throw IOException("grand")
        if (grand.canonicalPath != root.canonicalPath) throw IOException("escape")
        if (!isRequestId(parentCanon.name) || !file.isFile) throw IOException("file")
        return file
    }

    private fun requireMime(mime: String): String {
        return when (mime) {
            "image/png", "image/jpeg", "image/webp", "image/gif" -> mime
            else -> throw IOException("mime")
        }
    }

    private fun requireDisplayName(name: String, mime: String): String {
        val extension = when (mime) {
            "image/png" -> ".png"
            "image/jpeg" -> ".jpg"
            "image/webp" -> ".webp"
            "image/gif" -> ".gif"
            else -> throw IOException("mime")
        }
        if (name.length > 200 || !name.endsWith(extension)) throw IOException("name")
        if (name == "." || name == ".." || name.contains('/') || name.contains('\\')) throw IOException("name")
        if (name.any { it.isISOControl() }) throw IOException("name")
        if (File(name).name != name) throw IOException("name")
        return name
    }

    private fun isRequestId(name: String): Boolean {
        return name.length == 32 && name.all { it in '0'..'9' || it in 'a'..'f' }
    }

    private fun isSymlink(file: File?): Boolean {
        if (file == null) return false
        return try {
            Os.readlink(file.path)
            true
        } catch (_: ErrnoException) {
            false
        }
    }

    private fun errorCode(error: Throwable): String {
        var current: Throwable? = error
        while (current != null) {
            if (current is SecurityException) return "permission"
            current = current.cause
        }
        return "io"
    }

    private fun resolve(invoke: Invoke, once: AtomicBoolean, ok: Boolean, errorCode: String?, uri: String?) {
        if (!once.compareAndSet(false, true)) return
        val body = JSObject()
        body.put("ok", ok)
        if (errorCode != null) body.put("errorCode", errorCode)
        if (uri != null) body.put("uri", uri)
        invoke.resolve(body)
    }

    companion object {
        const val GALLERY_PERMISSION = "gallery"
        private const val IMAGE_SHARE_DIR = "image-share"
        private const val COPY_BUFFER = 64 * 1024
        private const val MAX_BYTES = 64L * 1024L * 1024L
    }
}
