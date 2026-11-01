package dev.herenfor.epubreader

import android.app.Activity
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ReaderVolumeKeyModeArgs {
  var mode: String? = null
}

/**
 * Bridges the front-end's reader-scoped paging preference to the Activity.
 *
 * The JS side sends `off` as soon as the reader is gone, so the Activity only
 * owns volume keys while the current screen actually turns pages.
 */
@TauriPlugin
class ReaderVolumeKeyPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setMode(invoke: Invoke) {
    val mode = ReaderVolumeKeyMode.parse(invoke.parseArgs(ReaderVolumeKeyModeArgs::class.java).mode)
    if (mode == null) {
      invoke.reject("mode must be one of: off, on, reverse")
      return
    }
    activity.runOnUiThread {
      try {
        val main = activity as MainActivity
        main.readerVolumeKeys.onTurn = { direction -> emitTurn(direction) }
        main.readerVolumeKeys.setMode(mode)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: error.toString())
      }
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    (activity as? MainActivity)?.readerVolumeKeys?.setMode(ReaderVolumeKeyMode.OFF)
    (activity as? MainActivity)?.readerVolumeKeys?.onTurn = null
  }

  private fun emitTurn(direction: Int) {
    val payload = JSObject()
    payload.put("direction", direction)
    try {
      trigger("volume-key", payload)
    } catch (_: Throwable) {
      // The WebView (and its listeners) may already be gone.
    }
  }
}
