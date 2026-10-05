package dev.herenfor.epubreader

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray

/**
 * Read-only native bridge for one LAN address snapshot.
 *
 * This belongs to the LAN save area and is intentionally separate from the
 * camera scanner. Each call takes a fresh finite snapshot; no receiver or
 * callback is registered and the app is never bound to one network.
 */
@TauriPlugin
class LanNetworkPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun snapshot(invoke: Invoke) {
        try {
            val addresses = JSONArray()
            lanAddressSnapshot(activity).forEach { fact ->
                val item = JSObject()
                item.put("address", fact.address)
                item.put("interfaceId", fact.interfaceId)
                item.put("label", fact.label)
                item.put("kind", fact.kind)
                item.put("up", fact.up)
                item.put("excluded", fact.excluded)
                addresses.put(item)
            }
            val response = JSObject()
            response.put("addresses", addresses)
            invoke.resolve(response)
        } catch (error: Throwable) {
            invoke.reject(error.message?.takeIf { it.isNotBlank() } ?: error.toString())
        }
    }
}
