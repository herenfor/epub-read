package dev.herenfor.epubreader

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  lateinit var readerSystemBars: ReaderSystemBarsController
    private set
  lateinit var readerKeepScreenOn: ReaderKeepScreenOnController
    private set
  lateinit var readerVolumeKeys: ReaderVolumeKeyController
    private set
  private val volumeKeyHandler = Handler(Looper.getMainLooper())

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    readerSystemBars = ReaderSystemBarsController(window)
    readerKeepScreenOn = ReaderKeepScreenOnController(window)
    readerVolumeKeys = ReaderVolumeKeyController(
      postDelayed = { delayMs, action -> volumeKeyHandler.postDelayed(action, delayMs) },
      removeCallbacks = { action -> volumeKeyHandler.removeCallbacks(action) },
    )
    // A restored Activity must not replay an old, already handled VIEW intent.
    if (savedInstanceState == null) ExternalOpenInbox.capture(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    ExternalOpenInbox.capture(intent)
  }

  override fun onResume() {
    super.onResume()
    readerSystemBars.onResume()
    readerKeepScreenOn.onResume()
    if (::readerVolumeKeys.isInitialized) readerVolumeKeys.onResume()
  }

  override fun onPause() {
    if (::readerVolumeKeys.isInitialized) readerVolumeKeys.onPause()
    readerKeepScreenOn.onPause()
    readerSystemBars.onPause()
    super.onPause()
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    // Volume keys are consumed only while the reader opted in; otherwise the
    // system keeps its normal volume behavior.
    if (::readerVolumeKeys.isInitialized &&
      readerVolumeKeys.handleKeyEvent(event.keyCode, event.action, event.repeatCount)
    ) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::readerSystemBars.isInitialized) readerSystemBars.onWindowFocusChanged(hasFocus)
    if (::readerKeepScreenOn.isInitialized) readerKeepScreenOn.onWindowFocusChanged(hasFocus)
    if (::readerVolumeKeys.isInitialized) readerVolumeKeys.onWindowFocusChanged(hasFocus)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (::readerSystemBars.isInitialized) readerSystemBars.onConfigurationChanged()
  }

  override fun onDestroy() {
    if (isFinishing) ExternalOpenInbox.clear()
    if (::readerVolumeKeys.isInitialized) readerVolumeKeys.destroy()
    if (::readerKeepScreenOn.isInitialized) readerKeepScreenOn.destroy()
    if (::readerSystemBars.isInitialized) readerSystemBars.destroy()
    super.onDestroy()
  }
}
