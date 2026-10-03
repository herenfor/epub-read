package dev.epubreader.app

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class StartBatteryArgs {
    lateinit var onStatus: Channel
}

/**
 * App-local Android battery subscription.
 *
 * A single `ACTION_BATTERY_CHANGED` receiver is registered only while the
 * front-end subscription is active. `start` resolves without carrying a
 * value; the sticky first reading and later updates all travel through the
 * command channel so the JS caller has already installed its callback.
 */
@TauriPlugin
class ReaderBatteryPlugin(private val activity: Activity) : Plugin(activity) {
    private data class BatterySnapshot(val levelPct: Int?, val charging: Boolean?)

    private var receiver: BroadcastReceiver? = null
    private var statusChannel: Channel? = null
    private var desired = false
    private var hasEmitted = false
    private var lastStatus: BatterySnapshot? = null

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartBatteryArgs::class.java)
        statusChannel = args.onStatus
        desired = true
        try {
            registerReceiver()
        } catch (error: Throwable) {
            desired = false
            statusChannel = null
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
        statusChannel = null
        invoke.resolve(JSObject())
    }

    override fun onResume() {
        if (!desired) return
        try {
            registerReceiver()
        } catch (_: Throwable) {
            unregisterReceiver()
        }
    }

    override fun onPause() {
        unregisterReceiver()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        desired = false
        unregisterReceiver()
        statusChannel = null
    }

    private fun registerReceiver() {
        if (receiver != null) return

        // A new registration session must publish its first sticky value even
        // when the percentage did not change while the app was in background.
        hasEmitted = false
        lastStatus = null

        val next = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == Intent.ACTION_BATTERY_CHANGED) {
                    emit(intent)
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
            emit(sticky)
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

    private fun emit(intent: Intent) {
        val status = readStatus(intent)
        if (hasEmitted && status == lastStatus) return

        hasEmitted = true
        lastStatus = status

        val payload = JSObject()
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
            statusChannel?.send(payload)
        } catch (_: Throwable) {
            // The JS subscription may already be gone; the next start/stop
            // cycle owns a fresh channel.
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
