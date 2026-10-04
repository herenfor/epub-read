package dev.herenfor.epubreader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android-only QR scanner for the LAN save join flow.
 *
 * The scanner launches only after the user taps "扫码连接"; it is never started
 * as a side effect of creating a LAN session. [LanScanActivity] owns the camera
 * and its permission request and always reports a status, so the web layer can
 * explain cancellations, denied permissions and missing cameras in plain words.
 */
@TauriPlugin
class LanScanPlugin(private val activity: Activity) : Plugin(activity) {
    private val scanning = AtomicBoolean(false)

    @Command
    fun scan(invoke: Invoke) {
        if (!scanning.compareAndSet(false, true)) {
            invoke.reject("scan-busy")
            return
        }
        try {
            startActivityForResult(invoke, Intent(activity, LanScanActivity::class.java), "scanResult")
        } catch (error: Throwable) {
            scanning.set(false)
            invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
        }
    }

    @ActivityCallback
    fun scanResult(invoke: Invoke, result: ActivityResult) {
        scanning.set(false)
        val data = result.data
        val status = data?.getStringExtra(LanScanActivity.EXTRA_STATUS) ?: LanScanActivity.STATUS_CANCELLED
        val contents = data?.getStringExtra(LanScanActivity.EXTRA_CONTENTS)?.trim()
        val response = JSObject()
        if (status == LanScanActivity.STATUS_SCANNED && contents.isNullOrEmpty()) {
            response.put("status", LanScanActivity.STATUS_CANCELLED)
        } else {
            response.put("status", status)
            if (!contents.isNullOrEmpty()) response.put("contents", contents)
        }
        invoke.resolve(response)
    }

    /** Opens this app's system settings page so the user can grant the camera. */
    @Command
    fun openAppSettings(invoke: Invoke) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", activity.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            invoke.resolve()
        } catch (error: Throwable) {
            invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
        }
    }
}
