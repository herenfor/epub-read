package dev.herenfor.epubreader

import android.Manifest
import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import kotlin.math.min

/**
 * Full-screen QR scanner for joining a LAN save session.
 *
 * Unlike the ZXing CaptureActivity it follows the device orientation, shows a
 * centred viewfinder in the style users know from mainstream apps, and owns the
 * camera permission request so a denial is reported as a status instead of a
 * misleading "camera error" dialog. The result is always delivered as
 * RESULT_OK with [EXTRA_STATUS] (and [EXTRA_CONTENTS] when scanned).
 */
class LanScanActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_STATUS = "status"
        const val EXTRA_CONTENTS = "contents"
        const val STATUS_SCANNED = "scanned"
        const val STATUS_CANCELLED = "cancelled"
        const val STATUS_PERMISSION_DENIED = "permission-denied"
        const val STATUS_NO_CAMERA = "no-camera"
        const val STATUS_CAMERA_ERROR = "camera-error"
    }

    private lateinit var barcodeView: BarcodeView
    private lateinit var overlay: ScanOverlayView
    private var torchButton: View? = null
    private var torchLabel: TextView? = null
    private var torchOn = false
    private var finished = false

    private val permissionRequest =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startScanning() else finishWith(STATUS_PERMISSION_DENIED)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            finishWith(STATUS_NO_CAMERA)
            return
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        setContentView(buildContent())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finishWith(STATUS_CANCELLED)
        })
        if (hasCameraPermission()) startScanning() else permissionRequest.launch(Manifest.permission.CAMERA)
    }

    override fun onResume() {
        super.onResume()
        if (!finished && hasCameraPermission()) barcodeView.resume()
    }

    override fun onPause() {
        if (::barcodeView.isInitialized) barcodeView.pause()
        super.onPause()
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startScanning() {
        if (finished) return
        barcodeView.decodeSingle(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                val text = result.text?.trim().orEmpty()
                if (text.isEmpty() || finished) return
                overlay.performHapticFeedback(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM
                    else HapticFeedbackConstants.VIRTUAL_KEY,
                )
                finishWith(STATUS_SCANNED, text)
            }

            override fun possibleResultPoints(resultPoints: MutableList<ResultPoint>?) = Unit
        })
        barcodeView.resume()
    }

    private fun finishWith(status: String, contents: String? = null) {
        if (finished) return
        finished = true
        if (::barcodeView.isInitialized) barcodeView.pause()
        setResult(RESULT_OK, Intent().apply {
            putExtra(EXTRA_STATUS, status)
            if (contents != null) putExtra(EXTRA_CONTENTS, contents)
        })
        finish()
    }

    private fun dp(value: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt()

    private fun buildContent(): View {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        barcodeView = BarcodeView(this).apply {
            decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
            addStateListener(object : CameraPreview.StateListener {
                override fun previewSized() = Unit
                override fun previewStarted() {
                    torchButton?.visibility =
                        if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) View.VISIBLE else View.GONE
                }
                override fun previewStopped() = Unit
                override fun cameraError(error: Exception?) = finishWith(STATUS_CAMERA_ERROR)
                override fun cameraClosed() = Unit
            })
        }
        root.addView(barcodeView, FrameLayout.LayoutParams(MATCH, MATCH))

        overlay = ScanOverlayView(this)
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4f), 0, dp(4f), 0)
        }
        val back = ImageView(this).apply {
            setImageResource(R.drawable.ic_lan_scan_back)
            contentDescription = "返回"
            scaleType = ImageView.ScaleType.CENTER
            background = ContextCompat.getDrawable(context, android.R.drawable.list_selector_background)
            setOnClickListener { finishWith(STATUS_CANCELLED) }
        }
        topBar.addView(back, LinearLayout.LayoutParams(dp(48f), dp(48f)))
        val title = TextView(this).apply {
            text = "扫码连接"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        topBar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        topBar.addView(View(this), LinearLayout.LayoutParams(dp(48f), dp(48f)))
        root.addView(topBar, FrameLayout.LayoutParams(MATCH, dp(56f), Gravity.TOP))

        val torch = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
            setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
            setOnClickListener { toggleTorch() }
        }
        torch.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_lan_scan_torch)
            contentDescription = null
        }, LinearLayout.LayoutParams(dp(28f), dp(28f)))
        val torchText = TextView(this).apply {
            text = "轻触照亮"
            setTextColor(0xE6FFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(4f), 0, 0)
        }
        torchText.maxLines = 1
        torch.addView(torchText, LinearLayout.LayoutParams(WRAP, WRAP))
        torchButton = torch
        torchLabel = torchText
        root.addView(torch, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            (topBar.layoutParams as FrameLayout.LayoutParams).apply {
                topMargin = bars.top
                leftMargin = bars.left
                rightMargin = bars.right
            }
            (torch.layoutParams as FrameLayout.LayoutParams).bottomMargin = bars.bottom + dp(36f)
            overlay.setInsets(bars.top + dp(56f), bars.bottom + dp(96f))
            topBar.requestLayout()
            torch.requestLayout()
            insets
        }
        return root
    }

    private fun toggleTorch() {
        torchOn = !torchOn
        barcodeView.setTorch(torchOn)
        torchLabel?.text = if (torchOn) "轻触关闭" else "轻触照亮"
    }

    private val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    private val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
}

/** Dims everything outside a centred square and animates a scan line inside it. */
private class ScanOverlayView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val frame = RectF()
    private val scrimPath = Path()
    private val cornerPath = Path()
    private var topInset = 0
    private var bottomInset = 0
    private var lineProgress = 0f

    private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(150, 0, 0, 0) }
    private val cornerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 4f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(70, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(230, 255, 255, 255)
        textAlign = Paint.Align.CENTER
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 14f, resources.displayMetrics)
    }
    private val subHintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255)
        textAlign = Paint.Align.CENTER
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12f, resources.displayMetrics)
    }

    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 2400
        repeatCount = ValueAnimator.INFINITE
        interpolator = AccelerateDecelerateInterpolator()
        addUpdateListener {
            lineProgress = it.animatedValue as Float
            postInvalidateOnAnimation()
        }
    }

    fun setInsets(top: Int, bottom: Int) {
        topInset = top
        bottomInset = bottom
        layoutFrame(width, height)
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator.start()
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = layoutFrame(w, h)

    private fun layoutFrame(w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        val available = (h - topInset - bottomInset).toFloat()
        val side = min(min(w * 0.68f, available * 0.62f), 280f * density)
        val left = (w - side) / 2f
        val top = topInset + (available - side) / 2f - 24f * density
        frame.set(left, top, left + side, top + side)

        val radius = 14f * density
        scrimPath.reset()
        scrimPath.fillType = Path.FillType.EVEN_ODD
        scrimPath.addRect(0f, 0f, w.toFloat(), h.toFloat(), Path.Direction.CW)
        scrimPath.addRoundRect(frame, radius, radius, Path.Direction.CW)

        val arm = 24f * density
        val r = radius
        cornerPath.reset()
        // Each bracket hugs the rounded corner of the clear window.
        cornerPath.moveTo(frame.left, frame.top + arm)
        cornerPath.lineTo(frame.left, frame.top + r)
        cornerPath.quadTo(frame.left, frame.top, frame.left + r, frame.top)
        cornerPath.lineTo(frame.left + arm, frame.top)
        cornerPath.moveTo(frame.right - arm, frame.top)
        cornerPath.lineTo(frame.right - r, frame.top)
        cornerPath.quadTo(frame.right, frame.top, frame.right, frame.top + r)
        cornerPath.lineTo(frame.right, frame.top + arm)
        cornerPath.moveTo(frame.right, frame.bottom - arm)
        cornerPath.lineTo(frame.right, frame.bottom - r)
        cornerPath.quadTo(frame.right, frame.bottom, frame.right - r, frame.bottom)
        cornerPath.lineTo(frame.right - arm, frame.bottom)
        cornerPath.moveTo(frame.left + arm, frame.bottom)
        cornerPath.lineTo(frame.left + r, frame.bottom)
        cornerPath.quadTo(frame.left, frame.bottom, frame.left, frame.bottom - r)
        cornerPath.lineTo(frame.left, frame.bottom - arm)

        val accent = Color.rgb(110, 168, 220)
        linePaint.shader = LinearGradient(
            frame.left, 0f, frame.right, 0f,
            intArrayOf(Color.TRANSPARENT, accent, Color.WHITE, accent, Color.TRANSPARENT),
            floatArrayOf(0f, 0.2f, 0.5f, 0.8f, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    override fun onDraw(canvas: Canvas) {
        if (frame.isEmpty) return
        canvas.drawPath(scrimPath, scrimPaint)
        val radius = 14f * density
        canvas.drawRoundRect(frame, radius, radius, edgePaint)

        val inset = 10f * density
        val travel = frame.height() - inset * 2
        val y = frame.top + inset + travel * lineProgress
        val glowHeight = 40f * density
        glowPaint.shader = LinearGradient(
            0f, y - glowHeight, 0f, y,
            Color.TRANSPARENT, Color.argb(60, 110, 168, 220),
            Shader.TileMode.CLAMP,
        )
        canvas.save()
        canvas.clipRect(frame.left + inset, frame.top + inset, frame.right - inset, frame.bottom - inset)
        canvas.drawRect(frame.left + inset, y - glowHeight, frame.right - inset, y, glowPaint)
        canvas.drawRect(frame.left + inset, y - 1f * density, frame.right - inset, y + 1f * density, linePaint)
        canvas.restore()

        canvas.drawPath(cornerPath, cornerPaint)

        val hintY = frame.bottom + 36f * density
        canvas.drawText("将另一台设备上的二维码放入框内", frame.centerX(), hintY, hintPaint)
        canvas.drawText("对准后会自动连接", frame.centerX(), hintY + 22f * density, subHintPaint)
    }
}
