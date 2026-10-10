package dev.herenfor.epubreader

import android.view.Window
import android.view.WindowManager

/** Only this Activity window owns the flag. No WakeLock or global timeout change. */
class ReaderKeepScreenOnController(private val setScreenOn: (Boolean) -> Unit) {
  constructor(window: Window) : this({ enabled ->
    if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  })

  private var requested = false
  private var resumed = false
  private var focused = false
  private var applied = false
  private var destroyed = false

  fun setEnabled(enabled: Boolean) {
    check(!destroyed || !enabled) { "reader window has been destroyed" }
    requested = enabled
    reconcile()
  }

  fun onResume() {
    resumed = true
    reconcile()
  }

  fun onPause() {
    resumed = false
    reconcile()
  }

  fun onWindowFocusChanged(hasFocus: Boolean) {
    focused = hasFocus
    reconcile()
  }

  fun destroy() {
    destroyed = true
    requested = false
    resumed = false
    reconcile()
  }

  private fun reconcile() {
    val next = requested && resumed && focused && !destroyed
    if (next == applied) return
    setScreenOn(next)
    applied = next
  }
}
