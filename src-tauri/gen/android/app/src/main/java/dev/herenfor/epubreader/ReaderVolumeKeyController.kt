package dev.herenfor.epubreader

/**
 * Android volume-key paging.
 *
 * The first key-down turns one page immediately. Holding the key for
 * [LONG_PRESS_DELAY_MS] then turns one page every [REPEAT_INTERVAL_MS] until
 * the key is released. Android's own key-repeat events are swallowed: the
 * cadence is owned here so it is identical on every device.
 *
 * `on` keeps the physical mapping (volume down = next), `reverse` swaps it.
 * Both are independent of touch tap direction and reading progression.
 */
enum class ReaderVolumeKeyMode {
  OFF,
  ON,
  REVERSE;

  companion object {
    fun parse(value: String?): ReaderVolumeKeyMode? = when (value) {
      "off" -> OFF
      "on" -> ON
      "reverse" -> REVERSE
      else -> null
    }
  }
}

class ReaderVolumeKeyController(
  private val postDelayed: (Long, Runnable) -> Unit,
  private val removeCallbacks: (Runnable) -> Unit,
) {
  companion object {
    /** Hold this long before the page starts repeating. */
    const val LONG_PRESS_DELAY_MS = 400L
    /** One page per interval while held. ~5 pages/second. */
    const val REPEAT_INTERVAL_MS = 200L

    // Values from android.view.KeyEvent; kept local so this file stays JVM-testable.
    const val KEYCODE_VOLUME_UP = 24
    const val KEYCODE_VOLUME_DOWN = 25
    const val ACTION_DOWN = 0
    const val ACTION_UP = 1

    /** +1 = next page, -1 = previous page, null = not ours / turned off. */
    fun direction(keyCode: Int, mode: ReaderVolumeKeyMode): Int? {
      if (mode == ReaderVolumeKeyMode.OFF) return null
      val next = mode == ReaderVolumeKeyMode.ON
      return when (keyCode) {
        KEYCODE_VOLUME_DOWN -> if (next) 1 else -1
        KEYCODE_VOLUME_UP -> if (next) -1 else 1
        else -> null
      }
    }
  }

  /** The native plugin installs the event emitter when the front-end subscribes. */
  var onTurn: ((Int) -> Unit)? = null

  var mode: ReaderVolumeKeyMode = ReaderVolumeKeyMode.OFF
    private set

  private var pressedKey = 0
  private var repeatDirection = 0
  private var repeatAction: Runnable? = null

  fun setMode(next: ReaderVolumeKeyMode) {
    if (next == mode) return
    mode = next
    // A mode change during a hold must not keep the old direction repeating.
    cancelRepeat()
  }

  /**
   * Returns true when this controller owns the event. Owned events are not
   * passed to the system, so the volume stream does not change while paging.
   */
  fun handleKeyEvent(keyCode: Int, action: Int, repeatCount: Int): Boolean {
    val direction = direction(keyCode, mode) ?: return false

    when (action) {
      ACTION_DOWN -> {
        if (repeatCount == 0) {
          pressedKey = keyCode
          onTurn?.invoke(direction)
          startRepeat(direction)
        }
        // Swallow Android's faster hardware repeat; our timer drives the cadence.
        return true
      }

      ACTION_UP -> {
        if (keyCode == pressedKey) {
          pressedKey = 0
          cancelRepeat()
        }
        return true
      }
    }
    return false
  }

  /** Backgrounding the app must not leave a queued repeat behind. */
  fun onPause() {
    pressedKey = 0
    cancelRepeat()
  }

  fun destroy() {
    onTurn = null
    onPause()
    mode = ReaderVolumeKeyMode.OFF
  }

  private fun startRepeat(direction: Int) {
    cancelRepeat()
    repeatDirection = direction
    val action = object : Runnable {
      override fun run() {
        if (mode == ReaderVolumeKeyMode.OFF || repeatDirection == 0) return
        onTurn?.invoke(repeatDirection)
        postDelayed(REPEAT_INTERVAL_MS, this)
      }
    }
    repeatAction = action
    postDelayed(LONG_PRESS_DELAY_MS, action)
  }

  private fun cancelRepeat() {
    repeatDirection = 0
    val action = repeatAction ?: return
    repeatAction = null
    removeCallbacks(action)
  }
}
