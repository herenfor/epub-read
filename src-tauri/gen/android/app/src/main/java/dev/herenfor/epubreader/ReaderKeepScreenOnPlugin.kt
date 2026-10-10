package dev.herenfor.epubreader

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ReaderKeepScreenOnArgs {
  var enabled: Boolean? = null
}

@TauriPlugin
class ReaderKeepScreenOnPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setEnabled(invoke: Invoke) {
    val enabled = invoke.parseArgs(ReaderKeepScreenOnArgs::class.java).enabled
    if (enabled == null) {
      invoke.reject("enabled must be a boolean")
      return
    }
    activity.runOnUiThread {
      try {
        (activity as MainActivity).readerKeepScreenOn.setEnabled(enabled)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: error.toString())
      }
    }
  }
}
