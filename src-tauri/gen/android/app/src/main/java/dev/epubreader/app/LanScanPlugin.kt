package dev.epubreader.app

import android.app.Activity
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Android-only QR scanner for the LAN save join flow.
 *
 * The scanner intentionally launches only after the user taps "扫码加入"; it is
 * never started as a side effect of creating a LAN session. The ZXing
 * CaptureActivity owns the camera lifecycle and permission request, and this
 * plugin simply forwards its result or cancellation back through the existing
 * Tauri ActivityResult bridge.
 */
@TauriPlugin
class LanScanPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun scan(invoke: Invoke) {
        try {
            val options = ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("将连接码放入框内")
                setBeepEnabled(false)
                setOrientationLocked(false)
                setBarcodeImageEnabled(false)
            }
            val intent = ScanContract().createIntent(activity, options)
            startActivityForResult(invoke, intent, "scanResult")
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            invoke.reject(message)
        }
    }

    @ActivityCallback
    fun scanResult(invoke: Invoke, result: ActivityResult) {
        try {
            val contents = ScanContract()
                .parseResult(result.resultCode, result.data)
                ?.contents
                ?.trim()
            val response = JSObject()
            if (contents.isNullOrEmpty()) {
                response.put("status", "cancelled")
            } else {
                response.put("status", "scanned")
                response.put("contents", contents)
            }
            invoke.resolve(response)
        } catch (error: Throwable) {
            val message = error.message?.takeIf { it.isNotBlank() } ?: error.toString()
            invoke.reject(message)
        }
    }
}
