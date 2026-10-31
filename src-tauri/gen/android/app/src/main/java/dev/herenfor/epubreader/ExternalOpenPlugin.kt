package dev.herenfor.epubreader

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference
import java.util.UUID
import org.json.JSONObject

@InvokeArg
class ExternalOpenAckArgs {
    lateinit var requestId: String
}

/** Metadata only: URI bytes continue through the existing bounded import bridge. */
internal object ExternalOpenInbox {
    private data class Request(val id: String, val kind: String, val value: String) {
        fun json(): JSObject = JSObject().apply {
            put("requestId", id)
            put("source", JSObject().apply {
                put("kind", kind)
                put(if (kind == "path") "path" else "uri", value)
            })
            // The provider display name is queried by the existing import worker.
            put("fileName", JSONObject.NULL)
        }
    }
    private val pending = ArrayDeque<Request>()
    private var plugin = WeakReference<ExternalOpenPlugin>(null)

    @Synchronized
    fun attach(value: ExternalOpenPlugin) { plugin = WeakReference(value) }

    @Synchronized
    fun capture(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        if (uri.scheme != "content" && uri.scheme != "file") return
        val isEpub = intent.type.equals("application/epub+zip", ignoreCase = true) ||
            uri.lastPathSegment?.endsWith(".epub", ignoreCase = true) == true
        if (!isEpub) return
        val kind = if (uri.scheme == "content") "contentUri" else "path"
        val value = if (kind == "path") uri.path ?: return else uri.toString()
        if (pending.any { it.kind == kind && it.value == value }) return
        pending.addLast(Request(UUID.randomUUID().toString(), kind, value))
        plugin.get()?.signalPending()
    }

    @Synchronized
    fun clear() { pending.clear(); plugin.clear() }

    @Synchronized
    fun peek(): JSObject? = pending.firstOrNull()?.json()

    @Synchronized
    fun ack(id: String): Boolean {
        if (pending.firstOrNull()?.id != id) return false
        pending.removeFirst()
        return true
    }
}

@TauriPlugin
class ExternalOpenPlugin(activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) { ExternalOpenInbox.attach(this) }

    internal fun signalPending() {
        try { trigger("pending", JSObject()) } catch (_: Exception) {
            // The retained request is read after JS readiness; an event is only a hint.
        }
    }

    @Command
    fun peek(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("request", ExternalOpenInbox.peek() ?: JSONObject.NULL) })
    }

    @Command
    fun ack(invoke: Invoke) {
        val args = invoke.parseArgs(ExternalOpenAckArgs::class.java)
        invoke.resolve(JSObject().apply { put("acknowledged", ExternalOpenInbox.ack(args.requestId)) })
    }
}
