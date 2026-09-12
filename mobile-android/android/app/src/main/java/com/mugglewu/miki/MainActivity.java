package com.mugglewu.miki;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 原生侧兜底，两件事：
 *
 * ① 安全区：把系统栏（状态栏/挖孔、导航栏/手势条）的真实高度按 CSS 变量发给网页。
 * 为什么需要这一层：Capacitor 8 的内置 SystemBars 插件只在「WebView ≥ 140 且页面带
 * viewport-fit=cover」时才把窗口内边距透传给页面（此时网页的 env(safe-area-inset-*) 才有值），
 * 不透传时它**只在 Android 15+**给 WebView 的父视图补内边距。于是「Android 14 及以下 +
 * 老 WebView」这一格两个机制都不生效：网页拿到的全是 0，内容就会压到状态栏与三大金刚下面
 * （小米 14 这类 Android 14 机器上实测就是这个表现）。做法是读窗口真实内边距，注入
 * --native-inset-*（CSS 里与 env()、Capacitor 注入的 --safe-area-inset-* 一起取最大值），
 * 已经由原生补过内边距的方向一律发 0，避免叠加两遍。
 *
 * ② 输入法避让（真机上报的"呼出键盘后看不见正在输入的内容"）：Android 15+ 起 targetSdk 35+
 * 强制边到边，窗口不再随输入法收缩——`windowSoftInputMode="adjustResize"` 在边到边窗口上等于
 * 失效，键盘直接画在 WebView 之上，WebView 也不会把聚焦的输入框滚出来。
 *
 * 做法（2026-09-12 按检索到的同类实现改写，两处关键差别）：
 *
 * - **改 WebView 自己的 bottomMargin，不改父视图的 padding**。改父视图会让父容器重新测量、
 *   触发整棵树的 insets 分发与重排，键盘弹出、输入法自己改高度的过程中会连环触发，页面表现
 *   为来回跳（真机上报的"内容一直在闪"）。改 WebView 的 margin 只影响它自己的边界。
 * - **insets 监听挂在 decor view 上，不挂在 WebView 上**。Capacitor 的 CoordinatorLayout 会把
 *   insets 吞掉：挂在 WebView 上的监听读到的永远是 0（Ionic 论坛有 decor 66 / WebView 0 的
 *   实测日志），挂在 decor view 上才是真值。
 *
 * 已知坑（同类实现里踩过并修好的）：**输入法在 App 启动前就可见时**直接设 margin 会出问题，
 * 所以 margin 要夹住 parent 的高度（见 applyKeyboardMargin）。
 *
 * 键盘让位**只由这一层负责**：WebView 被撑短之后，网页侧按可视视口算出的键盘高度自然就是 0
 * （布局视口与可见区一起变小），不需要再有第二个信号来协调。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "miki-insets";

    /**
     * 上一次发出去的 CSS 值，用来跳过无变化的重复发布。键盘弹出期间 insets 会连着来好几帧，
     * 每次回调都 evaluateJavascript 会让 WebView 无谓地重算样式与重排。
     */
    private String lastCss = "";

    /** 上一次设过的 WebView 底部外边距（像素）；-1 = 还没设过 */
    private int lastBottomMargin = -1;

    /** 上一次记下的布局读数，用来跳过没有变化的重复日志（见 reportInsets） */
    private String lastLayoutSig = "";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;

        // 排查用的桥：网页侧把键盘相关的现场记录送过来，落到 logcat（见 src/mobile/diag.ts）。
        // 只写日志、不改任何状态，出问题时不必改代码重新装包。
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void log(String text) {
                Log.d(TAG, "web " + text);
            }
        }, "MikiDiag");

        // 监听挂 decor view：CoordinatorLayout 会把 insets 吞掉，挂 WebView 上只能读到 0。
        // 只挂监听、不消费 insets：返回值原样透传，其它视图的处理不受影响。
        ViewCompat.setOnApplyWindowInsetsListener(
            getWindow().getDecorView(),
            (view, insets) -> {
                applyKeyboardMargin(webView, insets);
                publishInsets();
                reportInsets(webView, insets);
                return insets;
            }
        );
        applyKeyboardMargin(webView, ViewCompat.getRootWindowInsets(webView.getRootView()));
        publishInsets();
    }

    @Override
    public void onResume() {
        super.onResume();
        publishInsets();
    }

    /**
     * 按输入法内边距给 WebView 自己留出底部外边距：键盘弹起时 = 键盘高度，收起时 = 0。
     *
     * 必须是**设置**而不是累加（每次 insets 回调都从这里重新算），否则键盘弹出期间的
     * 连续回调会把外边距越加越大，页面被一节节顶上去。
     *
     * margin 要夹在 [0, parent 高度]：输入法在 App 启动前就可见时 parent 还没测量完
     * （高度为 0 或很小），此时按键盘高度设 margin 会把 WebView 挤成一条缝。
     *
     * 边到边设备（Android 15+）键盘占着底部时导航栏内边距也含在输入法内边距里，取输入法
     * 内边距就够；不边到边的设备（Android 14 及以下窗口自己会缩）输入法内边距本就是 0，
     * 这里不会多留一层白。
     */
    private void applyKeyboardMargin(WebView webView, WindowInsetsCompat insets) {
        if (insets == null) return;
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent == null) return;
        if (!(webView.getLayoutParams() instanceof ViewGroup.MarginLayoutParams)) return;

        int target = 0;
        if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
            target = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            if (target > parent.getHeight()) target = parent.getHeight();
            if (target < 0) target = 0;
        }
        if (target == lastBottomMargin) return;
        lastBottomMargin = target;

        ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
        lp.bottomMargin = target;
        webView.setLayoutParams(lp);
        Log.d(TAG, "kbMargin=" + target + " parentH=" + parent.getHeight()
            + " imeOn=" + (insets.isVisible(WindowInsetsCompat.Type.ime()) ? 1 : 0));
    }

    /**
     * 每次 insets 变化都记一行（只在数值真的变了才写，避免刷屏）。
     *
     * 排查"内容快速闪动"这类现象时，这一行是唯一能同时看到"WebView 有多高、外边距多少、
     * 输入法报了多少"的地方——三方中的哪一个在振荡，看序列就能定位。
     */
    private void reportInsets(WebView webView, WindowInsetsCompat insets) {
        String sig = webView.getHeight() + "/" + lastBottomMargin
            + "/" + insets.isVisible(WindowInsetsCompat.Type.ime())
            + "/" + insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        if (sig.equals(lastLayoutSig)) return;
        lastLayoutSig = sig;
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
        Log.d(TAG, "layout webH=" + webView.getHeight() + " margin=" + lastBottomMargin
            + " imeRaw=" + insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            + " imeOn=" + (insets.isVisible(WindowInsetsCompat.Type.ime()) ? 1 : 0)
            + " bars=" + bars.top + "/" + bars.bottom);
    }

    /** 读真实内边距并注入 CSS 变量；已经在原生侧留过白的方向发 0。 */
    private void publishInsets() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        webView.post(() -> {
            View parent = (View) webView.getParent();
            if (parent == null) return;

            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView.getRootView());
            if (insets == null) return;

            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            // 四点全 0 说明窗口还没真正布好（或这台设备确实没有系统栏）：
            // 别拿它去盖掉上一次发出去的正常值（真机上表现为安全区永久变 0、内容压到系统栏下面）
            if (bars.top == 0 && bars.bottom == 0 && bars.left == 0 && bars.right == 0) return;

            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            // 键盘占着底部时底部内边距交给键盘（与 Capacitor 的 calcSafeAreaInsets 同口径），
            // 键盘那层的留白由 applyKeyboardMargin 负责；否则三大金刚会与键盘叠出多余空白。
            int expectedBottom = keyboard ? 0 : bars.bottom;

            float density = getResources().getDisplayMetrics().density;
            int top = handled(parent.getPaddingTop(), bars.top) ? 0 : Math.round(bars.top / density);
            int left = handled(parent.getPaddingLeft(), bars.left) ? 0 : Math.round(bars.left / density);
            int right = handled(parent.getPaddingRight(), bars.right) ? 0 : Math.round(bars.right / density);
            int bottomCss = handled(parent.getPaddingBottom(), expectedBottom)
                ? 0
                : Math.round(expectedBottom / density);

            String script = "document.documentElement.style.setProperty('--native-inset-top','" + top + "px');"
                + "document.documentElement.style.setProperty('--native-inset-right','" + right + "px');"
                + "document.documentElement.style.setProperty('--native-inset-bottom','" + bottomCss + "px');"
                + "document.documentElement.style.setProperty('--native-inset-left','" + left + "px');"
                // 网页侧靠这个事件知道"原生改过变量了、重算一次"（写 CSS 变量本身不触发可视区事件）
                + "window.dispatchEvent(new Event('miki:insets'));";
            // 值没变就不再写一遍：键盘弹出期间每次回调都 evaluateJavascript 会让 WebView
            // 无谓地重算样式（真机上是每帧一次）
            if (script.equals(lastCss)) return;
            lastCss = script;
            webView.evaluateJavascript(script, null);
            // 排安全区/键盘问题时用 adb logcat -s miki-insets 就能看清"系统报了多少、原生补了多少、
            // 这次发给网页的是多少"，不用改代码重新装包。网页侧自己的读数会以 "web ..." 前缀
            // 追加在后面（见 src/mobile/diag.ts），两边的时序能对上。
            Log.d(TAG, "bars=" + bars.top + "/" + bars.bottom + " ime=" + (keyboard ? 1 : 0)
                + " webH=" + webView.getHeight() + " margin=" + lastBottomMargin
                + " -> css=" + top + "/" + bottomCss);
        });
    }

    /** 原生父视图已经按这个尺寸留过白了吗（留 2px 容差，dp 换算会取整）。 */
    private static boolean handled(int actualPaddingPx, int expectedPx) {
        return actualPaddingPx >= expectedPx - 2;
    }
}
