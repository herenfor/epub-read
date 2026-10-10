package dev.herenfor.epubreader

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  lateinit var readerSystemBars: ReaderSystemBarsController
    private set
  lateinit var readerKeepScreenOn: ReaderKeepScreenOnController
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    readerSystemBars = ReaderSystemBarsController(window)
    readerKeepScreenOn = ReaderKeepScreenOnController(window)
  }

  override fun onResume() {
    super.onResume()
    readerSystemBars.onResume()
    readerKeepScreenOn.onResume()
  }

  override fun onPause() {
    readerKeepScreenOn.onPause()
    readerSystemBars.onPause()
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (::readerSystemBars.isInitialized) readerSystemBars.onWindowFocusChanged(hasFocus)
    if (::readerKeepScreenOn.isInitialized) readerKeepScreenOn.onWindowFocusChanged(hasFocus)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (::readerSystemBars.isInitialized) readerSystemBars.onConfigurationChanged()
  }

  override fun onDestroy() {
    if (::readerKeepScreenOn.isInitialized) readerKeepScreenOn.destroy()
    if (::readerSystemBars.isInitialized) readerSystemBars.destroy()
    super.onDestroy()
  }
}
