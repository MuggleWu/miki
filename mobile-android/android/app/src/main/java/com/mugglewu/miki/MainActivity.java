package com.mugglewu.miki;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
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
 * 失效，键盘直接盖在 WebView 上，WebView 也不会把聚焦的输入框滚出来。通行做法就是这里这一句：
 * 按输入法内边距把 WebView 顶上去（等价于恢复 classic adjustResize）。
 * 判据用「窗口内边距到底有没有落到父视图上」——边到边时父视图底部内边距是 0，这里才动手；
 * 不边到边的设备（Android 14 及以下走主题默认）窗口自己已经缩好了，再补一层就是多余空白。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "miki-insets";

    /** 上一次发出去的 CSS 值，用来跳过无变化的重复发布（键盘弹出期间 insets 会连着来好几帧） */
    private String lastCss = "";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
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
                + "document.documentElement.style.setProperty('--native-inset-left','" + left + "px');";
            // 值没变就不再写一遍：键盘弹出期间每次回调都 evaluateJavascript 会让 WebView
            // 无谓地重算样式（真机上是每帧一次）
            if (script.equals(lastCss)) return;
            lastCss = script;
            webView.evaluateJavascript(script, null);
            // 排安全区/键盘问题时用 adb logcat -s miki-insets 就能看清"系统报了多少、原生补了多少、
            // 这次发给网页的是多少"，不用改代码重新装包。
            Log.d(TAG, "bars=" + bars.top + "/" + bars.bottom + " ime=" + (keyboard ? 1 : 0)
                + " parentPad=" + parent.getPaddingTop() + "/" + parent.getPaddingBottom()
                + " -> css=" + top + "/" + bottomCss);
        });
    }

    /** 原生父视图已经按这个尺寸留过白了吗（留 2px 容差，dp 换算会取整）。 */
    private static boolean handled(int actualPaddingPx, int expectedPx) {
        return actualPaddingPx >= expectedPx - 2;
    }
}
