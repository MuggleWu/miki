package com.mugglewu.miki;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
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
 * 失效，键盘直接盖在 WebView 上，WebView 也不会把聚焦的输入框滚出来。这里的做法是按输入法
 * 内边距给 WebView 的父视图留白（WebView 是 match_parent，于是它真的变短），等价于恢复
 * classic adjustResize。判据是「窗口内边距有没有真的落到父视图上」——边到边时父视图底部内边距
 * 是 0 才动手；Android 14 及以下窗口自己会缩，再补一层就是多余空白。
 *
 * **键盘让位只由这一层负责**：网页侧一旦看到 --native-kb 就把自己那份让位量报成 0
 * （见 src/ui/viewport.ts）。两层同时改布局会互相触发对方的回调，键盘弹出期间页面会在两三个
 * 位置之间反复跳——真机上报的"内容一直在快速闪动"就是这么来的。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "miki-insets";

    /**
     * 上一次发出去的 CSS 值，用来跳过无变化的重复发布。键盘弹出期间 insets 会连着来好几帧，
     * 每次回调都 evaluateJavascript 会让 WebView 无谓地重算样式与重排。
     */
    private String lastCss = "";

    /** 当前这轮原生让位的高度（CSS 像素）；0 = 没让位，网页侧自己负责 */
    private int keyboardCssPx = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;

        installLayoutWatch(webView);
        // WebView 自己的内边距变化（键盘弹出/收起、切换导航方式、旋转）都要重发一次。
        // 只挂监听、不消费 insets：ViewCompat 的监听器是在 View.onApplyWindowInsets 之后
        // 才被调用，WebView 内部的处理不受影响。
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            applyKeyboardInset(webView, insets);
            publishInsets();
            return insets;
        });
        applyKeyboardInset(webView, ViewCompat.getRootWindowInsets(webView));
        publishInsets();
    }

    @Override
    public void onResume() {
        super.onResume();
        publishInsets();
    }

    /**
     * 补发安全区：onCreate 那次 publishInsets 跑在布局之前，读到的 insets 全是 0。
     *
     * 这不只是"少发一次"的问题——那次发布时 bottom 是 0，而「父视图底部内边距 ≥ 期望值(0)」这个
     * 判据恰好成立，于是 --native-inset-bottom 被写成 0 并且**再也不会被改正**（值没变就不再发），
     * 表现为内容压在三大金刚/状态栏下面（真机上报的"重叠又回来了"就是这么来的）。
     *
     * 所以挂一个布局监听：每次布局都重发一次（读到全 0 的窗口不覆盖上一次的值）；
     * 之后继续保持监听——旋转、切导航方式、分屏都会改内边距，而这些不一定派发新的 insets 回调。
     */
    private void installLayoutWatch(final WebView webView) {
        webView.getViewTreeObserver().addOnGlobalLayoutListener(
            new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override
                public void onGlobalLayout() {
                    WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView.getRootView());
                    if (insets == null) return;
                    Insets bars = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                    );
                    // 全 0 说明窗口还没真正布好（或这台设备确实没有系统栏）：别拿它盖掉上一次的值
                    if (bars.top == 0 && bars.bottom == 0 && bars.left == 0 && bars.right == 0) return;
                    applyKeyboardInset(webView, insets);
                    publishInsets();
                }
            }
        );
    }

    /**
     * 按输入法内边距给 WebView 的父视图留白：键盘弹起时 = 键盘高度，收起时 = 0。
     *
     * 必须是**设置**而不是累加（每次 insets 回调都从这里重新算），否则键盘弹出期间的
     * 连续回调会把内边距越加越高，页面被一节节顶上去。
     */
    private void applyKeyboardInset(WebView webView, WindowInsetsCompat insets) {
        if (insets == null) return;
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent == null) return;

        boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
        int target = 0;
        if (keyboard) {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            // 已经留过系统栏内边距 = 窗口不是边到边的（系统自己缩过），别再补键盘那一层
            if (parent.getPaddingBottom() < bars.bottom) {
                target = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            }
        }
        float density = getResources().getDisplayMetrics().density;
        // 发给网页前换算成 CSS 像素：网页读的是 CSS 变量，dp 与 px 在这里会差一个密度
        keyboardCssPx = target > 0 ? Math.round(target / density) : 0;
        if (parent.getPaddingBottom() == target) return;
        parent.setPadding(
            parent.getPaddingLeft(),
            parent.getPaddingTop(),
            parent.getPaddingRight(),
            target
        );
        Log.d(TAG, "ime=" + (keyboard ? 1 : 0) + " parentBottomPad=" + target);
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
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            // 键盘占着底部时底部内边距交给键盘（与 Capacitor 的 calcSafeAreaInsets 同口径），
            // 否则三大金刚会与键盘叠加出一段多余空白。键盘那层的留白由 applyKeyboardInset 负责，
            // 所以这里的比较基准也要跟着换，否则会把键盘留白当成"导航栏已经处理过"。
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
                // 让位归属：原生接管着键盘时写非 0，网页侧据此把 --kb 报 0（见 src/ui/viewport.ts）；
                // 交还时把这个变量清掉，网页侧回到"自己算"。
                + (keyboardCssPx > 0
                    ? "document.documentElement.style.setProperty('--native-kb','" + keyboardCssPx + "px');"
                    : "document.documentElement.style.removeProperty('--native-kb');")
                // 网页侧靠这个事件知道"原生改过变量了、重算一次"（写 CSS 变量本身不触发可视区事件）
                + "window.dispatchEvent(new Event('miki:insets'));";
            // 值没变就不再写一遍：键盘弹出期间每次回调都 evaluateJavascript 会让 WebView
            // 无谓地重算样式（真机上是每帧一次）
            if (script.equals(lastCss)) return;
            lastCss = script;
            webView.evaluateJavascript(script, null);
            // 排安全区/键盘问题时用 adb logcat -s miki-insets 就能看清"系统报了多少、原生补了多少、
            // 这次发给网页的是多少"，不用改代码重新装包。
            Log.d(TAG, "bars=" + bars.top + "/" + bars.bottom + " ime=" + (keyboard ? 1 : 0)
                + " parentPad=" + parent.getPaddingTop() + "/" + parent.getPaddingBottom()
                + " -> css=" + top + "/" + bottomCss + " kb=" + keyboardCssPx);
        });
    }

    /** 原生父视图已经按这个尺寸留过白了吗（留 2px 容差，dp 换算会取整）。 */
    private static boolean handled(int actualPaddingPx, int expectedPx) {
        return actualPaddingPx >= expectedPx - 2;
    }
}
