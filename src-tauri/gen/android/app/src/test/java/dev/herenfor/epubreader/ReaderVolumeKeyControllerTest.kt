package dev.herenfor.epubreader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeScheduler {
  private val tasks = mutableListOf<Pair<Long, Runnable>>()

  fun postDelayed(delayMs: Long, action: Runnable) {
    tasks.add(delayMs to action)
  }

  fun removeCallbacks(action: Runnable) {
    tasks.removeAll { it.second === action }
  }

  val pending: Int get() = tasks.size

  fun nextDelay(): Long? = tasks.firstOrNull()?.first

  fun runNext() {
    val task = tasks.removeAt(0)
    task.second.run()
  }
}

class ReaderVolumeKeyControllerTest {
  private fun controller(scheduler: FakeScheduler): ReaderVolumeKeyController {
    val controller = ReaderVolumeKeyController(scheduler::postDelayed, scheduler::removeCallbacks)
    controller.onResume()
    controller.onWindowFocusChanged(true)
    controller.setMode(ReaderVolumeKeyMode.ON)
    return controller
  }

  @Test
  fun offLeavesVolumeKeysToTheSystem() {
    val scheduler = FakeScheduler()
    val controller = ReaderVolumeKeyController(scheduler::postDelayed, scheduler::removeCallbacks)
    assertFalse(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(0, scheduler.pending)
  }

  @Test
  fun onePressTurnsOnePageAndHoldingRepeatsAfterTheDelay() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    assertTrue(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(listOf(1), turns)
    assertEquals(ReaderVolumeKeyController.LONG_PRESS_DELAY_MS, scheduler.nextDelay()!!)

    scheduler.runNext()
    assertEquals(listOf(1, 1), turns)
    assertEquals(ReaderVolumeKeyController.REPEAT_INTERVAL_MS, scheduler.nextDelay()!!)

    scheduler.runNext()
    assertEquals(listOf(1, 1, 1), turns)

    assertTrue(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_UP, 0))
    assertEquals(0, scheduler.pending)
  }

  @Test
  fun hardwareRepeatCountDoesNotEmitExtraTurns() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_UP, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_UP, ReaderVolumeKeyController.ACTION_DOWN, 3)
    assertEquals(listOf(-1), turns)
    assertEquals(1, scheduler.pending)
  }

  @Test
  fun reverseSwapsThePhysicalKeys() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }
    controller.setMode(ReaderVolumeKeyMode.REVERSE)

    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_UP, 0)
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_UP, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_UP, ReaderVolumeKeyController.ACTION_UP, 0)
    assertEquals(listOf(-1, 1), turns)
  }

  @Test
  fun pauseAndFocusLossStopInterceptionAndCancelAQueuedRepeat() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.onPause()
    assertEquals(0, scheduler.pending)
    assertFalse(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))

    controller.onResume()
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.onWindowFocusChanged(false)
    assertEquals(0, scheduler.pending)
    assertFalse(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))

    controller.onWindowFocusChanged(true)
    assertTrue(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(listOf(1, 1, 1), turns)
  }

  @Test
  fun lateModeChangeWhilePausedCannotBypassForegroundGate() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    controller.onPause()
    controller.setMode(ReaderVolumeKeyMode.REVERSE)
    assertEquals(0, scheduler.pending)
    assertFalse(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(emptyList<Int>(), turns)

    controller.onResume()
    assertTrue(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(listOf(-1), turns)
  }

  @Test
  fun reopeningTheOverlayRequiresAFreshPress() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.setMode(ReaderVolumeKeyMode.OFF)
    assertEquals(0, scheduler.pending)
    controller.setMode(ReaderVolumeKeyMode.ON)
    assertEquals(0, scheduler.pending)
    assertEquals(listOf(1), turns)

    assertTrue(controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0))
    assertEquals(listOf(1, 1), turns)
  }

  @Test
  fun modeChangeOrPauseCancelsAQueuedRepeat() {
    val scheduler = FakeScheduler()
    val turns = mutableListOf<Int>()
    val controller = controller(scheduler)
    controller.onTurn = { turns.add(it) }

    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.setMode(ReaderVolumeKeyMode.OFF)
    assertEquals(0, scheduler.pending)

    controller.setMode(ReaderVolumeKeyMode.ON)
    controller.handleKeyEvent(ReaderVolumeKeyController.KEYCODE_VOLUME_DOWN, ReaderVolumeKeyController.ACTION_DOWN, 0)
    controller.onPause()
    assertEquals(0, scheduler.pending)
    assertEquals(listOf(1, 1), turns)
  }
}
