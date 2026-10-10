package dev.herenfor.epubreader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ReaderKeepScreenOnControllerTest {
  @Test
  fun leavingReaderReleasesImmediatelyAndRepeatedIntentsDoNotStack() {
    val applied = mutableListOf<Boolean>()
    val controller = ReaderKeepScreenOnController { applied.add(it); Unit }
    controller.onResume()
    controller.onWindowFocusChanged(true)
    controller.setEnabled(true)
    controller.setEnabled(true)
    controller.setEnabled(false)
    controller.setEnabled(false)
    controller.onPause()
    controller.onResume()
    assertEquals(listOf(true, false), applied)
  }

  @Test
  fun pauseAndFocusLossReleaseEvenIfJavascriptDoesNotRun() {
    val applied = mutableListOf<Boolean>()
    val controller = ReaderKeepScreenOnController { applied.add(it); Unit }
    controller.setEnabled(true)
    controller.onResume()
    assertEquals(emptyList<Boolean>(), applied)
    controller.onWindowFocusChanged(true)
    controller.onPause()
    controller.onWindowFocusChanged(false)
    // A stale enable arriving while paused must not acquire the window flag.
    controller.setEnabled(true)
    controller.onResume()
    assertEquals(listOf(true, false), applied)
    controller.onWindowFocusChanged(true)
    controller.onWindowFocusChanged(false)
    assertEquals(listOf(true, false, true, false), applied)
  }

  @Test
  fun destroyedWindowRejectsLateEnableAndNewWindowStartsOff() {
    val applied = mutableListOf<Boolean>()
    val controller = ReaderKeepScreenOnController { applied.add(it); Unit }
    controller.onResume()
    controller.onWindowFocusChanged(true)
    controller.setEnabled(true)
    controller.destroy()
    assertThrows(IllegalStateException::class.java) { controller.setEnabled(true) }
    controller.onResume()
    controller.onWindowFocusChanged(true)
    val recreated = ReaderKeepScreenOnController { applied.add(it); Unit }
    recreated.onResume()
    recreated.onWindowFocusChanged(true)
    assertEquals(listOf(true, false), applied)
  }
}
