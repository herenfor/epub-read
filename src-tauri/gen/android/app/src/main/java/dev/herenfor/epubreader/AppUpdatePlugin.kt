package dev.herenfor.epubreader

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

@InvokeArg
class StartUpdateArgs {
    var url: String = ""
    var sha256: String = ""
    var size: Long = 0
    var version: String = ""
}

/**
 * In-app update for Android: download, check, hand to the system installer.
 *
 * The package goes to the app's own external files (`updates/`, no storage
 * permission) through DownloadManager, which also shows progress in the
 * notification shade. Before the installer sees it, the file must match the
 * release digest, carry this app's package name, be signed by the certificate
 * this install was signed with, and have a higher versionCode; otherwise it
 * is deleted. Nothing here installs without the user's tap and the system's
 * own confirmation.
 */
@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs = activity.getSharedPreferences("app-update", Context.MODE_PRIVATE)
    private val downloads = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    private fun updatesDir(): File? = activity.getExternalFilesDir(null)?.let { File(it, UPDATES_DIR) }

    private fun packageFile(version: String): File? = updatesDir()?.let { File(it, "epub-reader-$version.apk") }

    private fun currentDownloadId(): Long = prefs.getLong(KEY_ID, -1L)

    private fun clearRecord() {
        prefs.edit().clear().apply()
    }

    /** Off the plugin's calling thread: hashing and package parsing take a moment. */
    private fun background(invoke: Invoke, work: () -> JSObject) {
        Thread {
            try {
                invoke.resolve(work())
            } catch (error: Throwable) {
                invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
            }
        }.start()
    }

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartUpdateArgs::class.java)
        if (!VERSION_RE.matches(args.version) || !SHA256_RE.matches(args.sha256) ||
            !(args.url.startsWith("https://") || args.url.startsWith("http://"))
        ) {
            invoke.reject("invalid update request")
            return
        }
        background(invoke) {
            val sha256 = args.sha256.lowercase()
            val existing = currentDownloadId()
            if (existing >= 0 && prefs.getString(KEY_VERSION, null) == args.version &&
                prefs.getString(KEY_SHA256, null) == sha256 &&
                query(existing)?.state?.let { it != "failed" } == true
            ) {
                // The same version is already downloading or downloaded: reuse it.
                return@background JSObject()
            }
            if (existing >= 0) downloads.remove(existing)
            clearRecord()
            val file = packageFile(args.version) ?: throw IllegalStateException("no external files directory")
            file.parentFile?.mkdirs()
            if (file.exists()) file.delete()
            val request = DownloadManager.Request(Uri.parse(args.url))
                .setTitle("EPUB Reader ${args.version}")
                .setMimeType(APK_MIME)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationUri(Uri.fromFile(file))
            val id = downloads.enqueue(request)
            prefs.edit()
                .putLong(KEY_ID, id)
                .putString(KEY_VERSION, args.version)
                .putString(KEY_SHA256, sha256)
                .apply()
            JSObject()
        }
    }

    private data class DownloadStatus(val state: String, val received: Long, val total: Long?, val reason: String?)

    private fun query(id: Long): DownloadStatus? {
        downloads.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
            if (cursor == null || !cursor.moveToFirst()) return null
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val state = when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> "done"
                DownloadManager.STATUS_FAILED -> "failed"
                else -> "running"
            }
            val reason = if (status == DownloadManager.STATUS_FAILED) {
                "download:" + cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            } else {
                null
            }
            return DownloadStatus(state, received.coerceAtLeast(0), total.takeIf { it > 0 }, reason)
        }
    }

    @Command
    fun status(invoke: Invoke) {
        background(invoke) {
            val id = currentDownloadId()
            val status = if (id < 0) DownloadStatus("idle", 0, null, null)
            else query(id) ?: DownloadStatus("failed", 0, null, "missing")
            JSObject().apply {
                put("state", status.state)
                put("received", status.received)
                put("total", status.total ?: JSONObject.NULL)
                if (status.reason != null) put("reason", status.reason)
            }
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        background(invoke) {
            val id = currentDownloadId()
            if (id >= 0) downloads.remove(id)
            prefs.getString(KEY_VERSION, null)?.let { packageFile(it)?.delete() }
            clearRecord()
            JSObject()
        }
    }

    /** Null when the downloaded file may be installed, else the reason it may not. */
    private fun check(): String? {
        val id = currentDownloadId()
        val version = prefs.getString(KEY_VERSION, null)
        val expected = prefs.getString(KEY_SHA256, null)
        if (id < 0 || version == null || expected == null) return "missing"
        if (query(id)?.state != "done") return "missing"
        val file = packageFile(version)
        if (file == null || !file.isFile) return "missing"
        if (sha256(file) != expected) return "sha256"
        val archive = archiveInfo(file) ?: return "package"
        if (archive.packageName != activity.packageName) return "package"
        val installed = installedInfo()
        val archiveSigners = signerDigests(archive)
        if (archiveSigners.isNullOrEmpty() || archiveSigners != signerDigests(installed)) return "certificate"
        if (PackageInfoCompat.getLongVersionCode(archive) <= PackageInfoCompat.getLongVersionCode(installed)) return "version"
        return null
    }

    private fun discard() {
        val id = currentDownloadId()
        if (id >= 0) downloads.remove(id)
        prefs.getString(KEY_VERSION, null)?.let { packageFile(it)?.delete() }
        clearRecord()
    }

    @Command
    fun verify(invoke: Invoke) {
        background(invoke) {
            val reason = check()
            if (reason != null && reason != "missing") discard()
            JSObject().apply {
                put("ok", reason == null)
                if (reason != null) put("reason", reason)
            }
        }
    }

    @Command
    fun canInstall(invoke: Invoke) {
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (activity.packageManager.canRequestPackageInstalls()) "granted" else "denied"
        } else {
            "unknown"
        }
        invoke.resolve(JSObject().apply { put("permission", permission) })
    }

    @Command
    fun openInstallPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            invoke.resolve(JSObject())
            return
        }
        activity.runOnUiThread {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                )
                activity.startActivity(intent)
                invoke.resolve(JSObject())
            } catch (error: Throwable) {
                invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
            }
        }
    }

    @Command
    fun install(invoke: Invoke) {
        background(invoke) {
            // Checked again here: the file must still be the one that passed.
            val reason = check()
            if (reason != null) {
                if (reason != "missing") discard()
                throw IllegalStateException("update package refused: $reason")
            }
            val file = packageFile(prefs.getString(KEY_VERSION, null)!!)!!
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.runOnUiThread { activity.startActivity(intent) }
            JSObject()
        }
    }

    /** At startup: drop packages that are not newer than this install (already applied or stale). */
    @Command
    fun cleanup(invoke: Invoke) {
        background(invoke) {
            val installed = PackageInfoCompat.getLongVersionCode(installedInfo())
            updatesDir()?.listFiles()?.forEach { file ->
                val archive = if (file.isFile) archiveInfo(file) else null
                if (archive == null || PackageInfoCompat.getLongVersionCode(archive) <= installed) {
                    if (file.name == prefs.getString(KEY_VERSION, null)?.let { "epub-reader-$it.apk" }) {
                        val id = currentDownloadId()
                        if (id >= 0 && query(id)?.state == "running") return@forEach
                        if (id >= 0) downloads.remove(id)
                        clearRecord()
                    }
                    file.delete()
                }
            }
            JSObject()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    @Suppress("DEPRECATION")
    private fun signingFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun archiveInfo(file: File): PackageInfo? =
        activity.packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags())

    @Suppress("DEPRECATION")
    private fun installedInfo(): PackageInfo =
        activity.packageManager.getPackageInfo(activity.packageName, signingFlags())

    @Suppress("DEPRECATION")
    private fun signerDigests(info: PackageInfo): Set<String>? {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            info.signatures
        } ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        return signatures.map { signature ->
            digest.digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private companion object {
        const val UPDATES_DIR = "updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        const val KEY_ID = "downloadId"
        const val KEY_VERSION = "version"
        const val KEY_SHA256 = "sha256"
        val VERSION_RE = Regex("""^\d+\.\d+\.\d+$""")
        val SHA256_RE = Regex("""^[0-9a-fA-F]{64}$""")
    }
}
