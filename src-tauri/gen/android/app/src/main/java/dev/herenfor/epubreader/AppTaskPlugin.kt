package dev.herenfor.epubreader

import android.app.Activity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
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
    private val lifecycle = (activity as LifecycleOwner).lifecycle

    init {
        activity.runOnUiThread {
            lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onResume(owner: LifecycleOwner) = publishForeground(true)
                override fun onPause(owner: LifecycleOwner) = publishForeground(false)
                override fun onDestroy(owner: LifecycleOwner) {
                    owner.lifecycle.removeObserver(this)
                }
            })
        }
    }

    private fun foregroundStatus(foreground: Boolean) = JSObject().apply {
        put("foreground", foreground)
    }

    private fun publishForeground(foreground: Boolean) {
        trigger("foreground", foregroundStatus(foreground))
    }

    @Command
    fun getForeground(invoke: Invoke) {
        activity.runOnUiThread {
            invoke.resolve(foregroundStatus(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)))
        }
    }

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
