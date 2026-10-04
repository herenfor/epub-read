package dev.herenfor.epubreader

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class StartBatteryArgs {
    var subscriptionId: Long = 0
}

/**
 * App-local Android battery subscription.
 *
 * A single `ACTION_BATTERY_CHANGED` receiver is registered only while the
 * front-end subscription is active. `start` resolves without carrying a
 * value; the sticky first reading and later updates all travel through the
 * app-level event listener registered by JS before starting the receiver.
 */
@TauriPlugin
class ReaderBatteryPlugin(private val activity: Activity) : Plugin(activity) {
    private data class BatterySnapshot(val levelPct: Int?, val charging: Boolean?)

    private var receiver: BroadcastReceiver? = null
    private var subscriptionId: Long = 0
    private var desired = false
    private var hasEmitted = false
    private var lastStatus: BatterySnapshot? = null

    // The generated TauriActivity defines a plugin lifecycle observer but never
    // registers it, so Plugin.onPause/onResume are not delivered. Follow the
    // activity lifecycle directly: release the receiver while backgrounded and
    // re-register (publishing a fresh first value) when the reader returns.
    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) {
            if (!desired) return
            try {
                registerReceiver()
            } catch (_: Throwable) {
                unregisterReceiver()
            }
        }

        override fun onPause(owner: LifecycleOwner) {
            unregisterReceiver()
        }
    }

    init {
        activity.runOnUiThread {
            (activity as? LifecycleOwner)?.lifecycle?.addObserver(lifecycleObserver)
        }
    }

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartBatteryArgs::class.java)
        unregisterReceiver()
        subscriptionId = args.subscriptionId
        desired = true
        try {
            registerReceiver()
        } catch (error: Throwable) {
            desired = false
            subscriptionId = 0
            unregisterReceiver()
            invoke.reject(error.message ?: error.toString())
            return
        }
        invoke.resolve(JSObject())
    }

    @Command
    fun stop(invoke: Invoke) {
        desired = false
        unregisterReceiver()
        subscriptionId = 0
        invoke.resolve(JSObject())
    }

    override fun onDestroy(activity: AppCompatActivity) {
        activity.lifecycle.removeObserver(lifecycleObserver)
        desired = false
        unregisterReceiver()
        subscriptionId = 0
    }

    private fun registerReceiver() {
        if (receiver != null) return

        // A new registration session must publish its first sticky value even
        // when the percentage did not change while the app was in background.
        hasEmitted = false
        lastStatus = null

        val ownerSubscriptionId = subscriptionId
        val next = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (receiver === this && intent?.action == Intent.ACTION_BATTERY_CHANGED) {
                    emit(intent, ownerSubscriptionId)
                }
            }
        }

        receiver = next
        val sticky = try {
            activity.registerReceiver(next, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (error: Throwable) {
            receiver = null
            throw error
        }

        // Most Android versions deliver the sticky intent to onReceive during
        // registration. Only publish the returned value when that did not
        // happen, so a newer event cannot be overwritten by the old first read.
        if (sticky != null && !hasEmitted) {
            emit(sticky, ownerSubscriptionId)
        }
    }

    private fun unregisterReceiver() {
        val current = receiver ?: return
        receiver = null
        try {
            activity.unregisterReceiver(current)
        } catch (_: IllegalArgumentException) {
            // The framework may already have detached the receiver.
        }
    }

    private fun emit(intent: Intent, ownerSubscriptionId: Long) {
        val status = readStatus(intent)
        if (hasEmitted && status == lastStatus) return

        hasEmitted = true
        lastStatus = status

        val payload = JSObject()
        payload.put("subscriptionId", ownerSubscriptionId)
        val levelPct = status.levelPct
        if (levelPct == null) {
            payload.put("levelPct", JSONObject.NULL)
        } else {
            payload.put("levelPct", levelPct)
        }

        val charging = status.charging
        if (charging == null) {
            payload.put("charging", JSONObject.NULL)
        } else {
            payload.put("charging", charging)
        }

        try {
            trigger("battery-status", payload)
        } catch (_: Throwable) {
            // No front-end listener remains after a destroyed WebView.
        }
    }

    private fun readStatus(intent: Intent): BatterySnapshot {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val levelPct = if (scale > 0 && level in 0..scale) {
            Math.round(level * 100.0 / scale).toInt().coerceIn(0, 100)
        } else {
            null
        }

        val status = intent.getIntExtra(
            BatteryManager.EXTRA_STATUS,
            BatteryManager.BATTERY_STATUS_UNKNOWN,
        )
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val charging = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING,
            BatteryManager.BATTERY_STATUS_FULL -> true

            BatteryManager.BATTERY_STATUS_DISCHARGING,
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false

            else -> if (plugged != 0) true else null
        }

        return BatterySnapshot(levelPct, charging)
    }
}
