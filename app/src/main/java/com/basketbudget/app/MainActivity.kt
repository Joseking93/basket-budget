package com.basketbudget.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Basket Budget: the single-page app in assets/index.html, in a WebView, plus a
 * camera-to-ML-Kit bridge for reading a till slip.
 *
 * The page is served over https://appassets.androidplatform.net rather than
 * file://, so it gets a real origin and its localStorage ("basket-budget-v1")
 * survives restarts and app updates.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var statusStrip: View

    /** Kept in step by the page through Android.setSheetOpen(). */
    private var sheetOpen = false

    /**
     * The page cannot be called into until it has loaded. Android can destroy
     * this activity while the camera is in front, so a result can arrive before
     * the reloaded page is ready; without this the call vanishes silently.
     */
    private var pageReady = false
    private var queuedJs: String? = null

    private val recognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    /**
     * Where the camera was told to write. Held as a path and saved into the
     * instance state: the camera app is heavy and this activity is routinely
     * destroyed behind it, which used to lose the photo entirely.
     */
    private var pendingPhotoPath: String? = null

    private val takePicture =
        registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
            val file = pendingPhotoPath?.let { File(it) }
            pendingPhotoPath = null
            when {
                // The file on disk is the truth. Some camera apps report
                // RESULT_CANCELED even after writing a perfectly good photo.
                file != null && file.exists() && file.length() > 0 ->
                    recognise(FileProvider.getUriForFile(this, authority(), file))
                saved -> fail("The camera said it saved a photo, but nothing was written.")
                else -> scanCancelled()
            }
        }

    private val pickImage =
        registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) recognise(uri) else scanCancelled()
        }

    /** For a scan saved as a PDF, which is what phone document scanners make. */
    private val pickDocument =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) recognise(uri) else scanCancelled()
        }

    private val askCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) launchCamera() else {
                scanCancelled()
                Toast.makeText(
                    this,
                    "Camera permission is needed to photograph a receipt. You can still pick a photo or a PDF.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingPhotoPath = savedInstanceState?.getString(KEY_PENDING_PHOTO)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("UNUSED_VARIABLE")
        val brand = ContextCompat.getColor(this, R.color.brand)
        val saved = getSharedPreferences("chrome", MODE_PRIVATE)
        val pageBg = saved.getInt("bg", ContextCompat.getColor(this, R.color.page_bg))

        // A green strip of exactly the status bar's height, with the page below it.
        // Android 15+ ignores window.statusBarColor, so the colour is drawn here.
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(pageBg)
        }
        // The page runs edge to edge in one warm dark, so the strip matches it
        // rather than painting a band across the top.
        statusStrip = View(this).apply { setBackgroundColor(pageBg) }
        root.addView(
            statusStrip,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0),
        )

        web = WebView(this)
        root.addView(
            web,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        setContentView(root, FrameLayout.LayoutParams(-1, -1))

        @Suppress("DEPRECATION")
        window.statusBarColor = pageBg
        @Suppress("DEPRECATION")
        window.navigationBarColor = pageBg
        val bars = WindowInsetsControllerCompat(window, root)
        val startDark = saved.getBoolean("dark", isNight())
        bars.isAppearanceLightStatusBars = !startDark
        bars.isAppearanceLightNavigationBars = !startDark

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            statusStrip.layoutParams = statusStrip.layoutParams.apply { height = sys.top }
            statusStrip.requestLayout()
            // The keyboard must not sit on top of the price field.
            web.setPadding(sys.left, 0, sys.right, maxOf(sys.bottom, ime.bottom))
            insets
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.setBackgroundColor(pageBg)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // The page is entirely local; nothing should ever load off a network.
            blockNetworkLoads = true
            blockNetworkImage = true
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // Lets the page's own prefers-color-scheme CSS follow the system theme.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, true)
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = request.url.host != ASSET_HOST // stay inside the app

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                queuedJs?.let { view.evaluateJavascript(it, null) }
                queuedJs = null
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        web.loadUrl("https://$ASSET_HOST/assets/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (sheetOpen) {
                    runJs("window.bbCloseSheet && window.bbCloseSheet();")
                    sheetOpen = false
                } else {
                    finish()
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        pendingPhotoPath?.let { outState.putString(KEY_PENDING_PHOTO, it) }
    }

    override fun onDestroy() {
        recognizer.close()
        super.onDestroy()
    }

    private fun isNight(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    private fun authority() = "$packageName.fileprovider"

    /** Calls into the page, waiting for it to load if a result beat it there. */
    private fun runJs(js: String) {
        if (pageReady) web.evaluateJavascript(js, null) else queuedJs = js
    }

    // ---------------------------------------------------------------- bridge

    inner class Bridge {
        /** Fallback for navigator.clipboard, which a WebView can refuse. */
        @JavascriptInterface
        fun copyToClipboard(text: String) {
            runOnUiThread {
                val clip = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clip.setPrimaryClip(ClipData.newPlainText("Basket Budget list", text))
            }
        }

        /** So the hardware back button closes an open sheet before the app. */
        @JavascriptInterface
        fun setSheetOpen(open: Boolean) {
            sheetOpen = open
        }

        /**
         * Hands the page to Android's print system, whose dialog offers "Save
         * as PDF". No library, and nothing to download - which matters for an
         * app with no internet permission.
         */
        @JavascriptInterface
        fun printPage(name: String) {
            runOnUiThread {
                val title = name.replace(Regex("""[^A-Za-z0-9 ._-]"""), "")
                    .trim().ifEmpty { "Receipt" }
                val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                manager.print(
                    title,
                    web.createPrintDocumentAdapter(title),
                    PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build(),
                )
            }
        }

        /** The page owns the colours; the system bars have to be told. */
        @JavascriptInterface
        fun setChrome(color: String, darkTheme: Boolean) {
            runOnUiThread {
                val tint = try {
                    android.graphics.Color.parseColor(color)
                } catch (e: IllegalArgumentException) {
                    return@runOnUiThread
                }
                // Remembered so the next launch opens in the right colour
                // instead of flashing the other theme.
                getSharedPreferences("chrome", MODE_PRIVATE).edit()
                    .putInt("bg", tint).putBoolean("dark", darkTheme).apply()
                statusStrip.setBackgroundColor(tint)
                findViewById<View>(android.R.id.content).rootView.setBackgroundColor(tint)
                web.setBackgroundColor(tint)
                @Suppress("DEPRECATION")
                window.statusBarColor = tint
                @Suppress("DEPRECATION")
                window.navigationBarColor = tint
                WindowInsetsControllerCompat(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !darkTheme
                    isAppearanceLightNavigationBars = !darkTheme
                }
            }
        }

        @JavascriptInterface
        fun scanReceipt() {
            runOnUiThread { chooseSource() }
        }
    }

    // ------------------------------------------------------------- scanning

    private fun chooseSource() {
        AlertDialog.Builder(this)
            .setTitle("Scan a receipt")
            .setItems(arrayOf("Take a photo", "Choose a photo", "Choose a PDF or image")) { _, which ->
                when (which) {
                    0 -> startCamera()
                    1 -> pickImage.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    )
                    else -> pickDocument.launch(arrayOf("application/pdf", "image/*"))
                }
            }
            .setOnCancelListener { scanCancelled() }
            .show()
    }

    private fun startCamera() {
        // Asked for only now, when the camera is actually the chosen route.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            launchCamera()
        } else {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchCamera() {
        try {
            val dir = File(cacheDir, "receipts").apply { mkdirs() }
            val file = File(dir, "receipt-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, authority(), file)
            pendingPhotoPath = file.absolutePath
            takePicture.launch(uri)
        } catch (e: Exception) {
            pendingPhotoPath = null
            scanCancelled()
            Toast.makeText(this, "Could not open the camera.", Toast.LENGTH_LONG).show()
        }
    }

    private fun recognise(uri: Uri) {
        runJs("window.onReceiptScanning && window.onReceiptScanning();")
        sheetOpen = true
        try {
            if (looksLikePdf(uri)) recognisePdf(uri) else recogniseImage(uri)
        } catch (e: Exception) {
            fail("That file could not be opened.")
        }
    }

    private fun recogniseImage(uri: Uri) {
        recognizer.process(InputImage.fromFilePath(this, uri))
            .addOnSuccessListener { text ->
                val (scan, rows) = parse(linesOf(text, 0))
                deliver(scan, rows)
            }
            .addOnFailureListener { fail("The text on that photo could not be read.") }
    }

    /** A phone document scanner saves a PDF, so each page is rendered and read. */
    private fun recognisePdf(uri: Uri) {
        val pages = mutableListOf<Bitmap>()
        contentResolver.openFileDescriptor(uri, "r").use { descriptor ->
            if (descriptor == null) {
                fail("That PDF could not be opened.")
                return
            }
            PdfRenderer(descriptor).use { renderer ->
                val count = minOf(renderer.pageCount, MAX_PDF_PAGES)
                for (index in 0 until count) {
                    renderer.openPage(index).use { page ->
                        val scale = (PDF_TARGET_WIDTH.toFloat() / page.width).coerceIn(1f, 4f)
                        val bitmap = Bitmap.createBitmap(
                            (page.width * scale).toInt(),
                            (page.height * scale).toInt(),
                            Bitmap.Config.ARGB_8888,
                        )
                        // PDF pages render onto transparency; OCR needs paper.
                        bitmap.eraseColor(Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        pages.add(bitmap)
                    }
                }
            }
        }
        if (pages.isEmpty()) fail("That PDF has no pages.") else recognisePages(pages)
    }

    private fun recognisePages(pages: List<Bitmap>) {
        val lines = mutableListOf<OcrLine>()
        fun step(index: Int) {
            if (index >= pages.size) {
                val (scan, rows) = parse(lines)
                deliver(scan, rows)
                return
            }
            recognizer.process(InputImage.fromBitmap(pages[index], 0))
                .addOnSuccessListener { text ->
                    // Pages are pushed far apart so no row spans two of them.
                    lines += linesOf(text, index * PAGE_STRIDE)
                    step(index + 1)
                }
                .addOnFailureListener { fail("That PDF could not be read.") }
        }
        step(0)
    }

    /**
     * ML Kit reports axis-aligned boxes, so a slip photographed at an angle puts
     * the amount column a whole line below the name it belongs to. The page's
     * tilt is measured from the text itself and taken out here, so the rows
     * group the way they read on paper.
     */
    private fun linesOf(text: Text, yOffset: Int): List<OcrLine> {
        val lines = text.textBlocks.flatMap { it.lines }
        val slope = tiltOf(lines)
        return lines.mapNotNull { line ->
            line.boundingBox?.let { box ->
                val level = (slope * (box.left + box.right) / 2.0).toInt()
                OcrLine(
                    line.text,
                    box.left,
                    box.top + yOffset - level,
                    box.right,
                    box.bottom + yOffset - level,
                )
            }
        }
    }

    /** Average rise over run across the page's text, in pixels. */
    private fun tiltOf(lines: List<Text.Line>): Double {
        var rise = 0.0
        var run = 0.0
        for (line in lines) {
            val corners = line.cornerPoints ?: continue
            if (corners.size < 2) continue
            val dx = (corners[1].x - corners[0].x).toDouble()
            if (dx < 40) continue // too short to say anything about the tilt
            rise += corners[1].y - corners[0].y
            run += dx
        }
        return if (run <= 0.0) 0.0 else (rise / run).coerceIn(-0.35, 0.35)
    }

    /** The rows are kept so the raw read can be copied out when it goes wrong. */
    private fun parse(lines: List<OcrLine>): Pair<ReceiptScan, List<String>> {
        val rows = ReceiptParser.rowsFrom(lines)
        return ReceiptParser.parse(rows) to rows
    }

    private fun looksLikePdf(uri: Uri): Boolean {
        if (contentResolver.getType(uri) == "application/pdf") return true
        return try {
            contentResolver.openInputStream(uri)?.use { stream ->
                val head = ByteArray(5)
                stream.read(head) == 5 && String(head) == "%PDF-"
            } ?: false
        } catch (e: Exception) {
            false
        }
    }

    private fun deliver(
        scan: ReceiptScan,
        rows: List<String> = emptyList(),
        message: String? = null,
    ) {
        val items = JSONArray()
        for (item in scan.items) {
            items.put(
                JSONObject()
                    .put("name", item.name)
                    .put("qty", item.qty)
                    .put("price", item.price)
                    .put("total", item.total)
            )
        }
        val payload = JSONObject()
            .put("items", items)
            .put("receiptTotal", scan.receiptTotal ?: JSONObject.NULL)
            .put("lineCount", scan.lineCount ?: JSONObject.NULL)
            .put("message", message ?: JSONObject.NULL)
            .put("rows", JSONArray(rows))
        runJs("window.onReceiptScanned($payload);")
        sheetOpen = true
    }

    /** Says what went wrong in the sheet. Silence is what made this hard to find. */
    private fun fail(message: String) {
        deliver(ReceiptScan(emptyList(), null), emptyList(), message)
    }

    /** Nothing was photographed or picked, so leave the page as it was. */
    private fun scanCancelled() {
        runJs("window.bbCloseSheet && window.bbCloseSheet();")
        sheetOpen = false
    }

    private companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val KEY_PENDING_PHOTO = "pendingPhotoPath"
        const val MAX_PDF_PAGES = 5
        const val PDF_TARGET_WIDTH = 1600
        const val PAGE_STRIDE = 1_000_000
    }
}
