package dev.herenfor.epubreader

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ReaderSystemBarsArgs {
    var hidden: Boolean? = null
}

@TauriPlugin
class ReaderSystemBarsPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun setHidden(invoke: Invoke) {
        val hidden = invoke.parseArgs(ReaderSystemBarsArgs::class.java).hidden
        if (hidden == null) {
            invoke.reject("hidden must be a boolean")
            return
        }
        activity.runOnUiThread {
            try {
                (activity as MainActivity).readerSystemBars.setReaderHidden(hidden)
                invoke.resolve()
            } catch (error: Throwable) {
                invoke.reject(error.message ?: error.toString())
            }
        }
    }
}
