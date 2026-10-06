package dev.herenfor.epubreader

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * App-level task control for the shelf's "back again to exit" gesture.
 *
 * The front end owns every Back press while the shelf is shown, so the
 * default WebView-history fallback never runs there. Leaving is the same
 * move-to-background Android 12+ applies to a root activity on Back: the
 * process and WebView stay alive and nothing pending is torn down.
 */
@TauriPlugin
class AppTaskPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun moveTaskToBack(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                activity.moveTaskToBack(true)
                invoke.resolve()
            } catch (error: Throwable) {
                invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
            }
        }
    }
}
