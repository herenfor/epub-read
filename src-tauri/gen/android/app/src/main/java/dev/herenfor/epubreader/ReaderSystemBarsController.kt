// MainActivity owns one instance; only statusBars are changed.
package dev.herenfor.epubreader

import android.os.Looper
import android.view.ViewTreeObserver
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class ReaderSystemBarsController(private val window: Window) {
  private data class Snapshot(val visible: Boolean, val behavior: Int)

  private var wantedHidden = false
  private var resumed = false
  private var focused = false
  private var needsApply = false
  private var previous: Snapshot? = null
  private var firstLayoutPending = true
  private val decor get() = window.decorView

  private val onFirstInsets = ViewTreeObserver.OnGlobalLayoutListener {
    if (ViewCompat.getRootWindowInsets(decor) != null) {
      removeFirstLayoutObserver()
      reconcile()
    }
  }

  init {
    checkUiThread()
    decor.viewTreeObserver.addOnGlobalLayoutListener(onFirstInsets)
  }

  fun setReaderHidden(hidden: Boolean) {
    checkUiThread()
    if (wantedHidden != hidden) needsApply = true
    wantedHidden = hidden
    reconcile()
  }

  fun onResume() {
    checkUiThread()
    resumed = true
    needsApply = true
    reconcile()
  }

  fun onPause() {
    checkUiThread()
    resumed = false
  }

  fun onWindowFocusChanged(hasFocus: Boolean) {
    checkUiThread()
    focused = hasFocus
    // Focus changes alone must not fight the user's temporary system-bar reveal.
    reconcile()
  }

  fun onConfigurationChanged() {
    checkUiThread()
    needsApply = true
    reconcile()
  }

  fun destroy() {
    checkUiThread()
    removeFirstLayoutObserver()
    resumed = false
    focused = false
    previous = null // The old window is gone; a new Activity gets a new controller.
  }

  private fun reconcile() {
    if (!resumed || !focused || !needsApply) return
    val insets = ViewCompat.getRootWindowInsets(decor) ?: return
    val controller = WindowCompat.getInsetsController(window, decor)
    val statusBars = WindowInsetsCompat.Type.statusBars()
    if (wantedHidden) {
      if (previous == null) {
        previous = Snapshot(insets.isVisible(statusBars), controller.systemBarsBehavior)
      }
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(statusBars)
    } else {
      previous?.let { snapshot ->
        controller.systemBarsBehavior = snapshot.behavior
        if (snapshot.visible) controller.show(statusBars) else controller.hide(statusBars)
      }
      previous = null
    }
    needsApply = false
  }

  private fun removeFirstLayoutObserver() {
    if (!firstLayoutPending) return
    if (decor.viewTreeObserver.isAlive) {
      decor.viewTreeObserver.removeOnGlobalLayoutListener(onFirstInsets)
    }
    firstLayoutPending = false
  }

  private fun checkUiThread() {
    check(Looper.myLooper() == Looper.getMainLooper())
  }
}
