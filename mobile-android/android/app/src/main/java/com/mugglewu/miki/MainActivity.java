package com.mugglewu.miki;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 安全区兜底：把系统栏（状态栏/挖孔、导航栏/手势条）的真实高度按 CSS 变量发给网页。
 *
 * 为什么需要这一层：Capacitor 8 的内置 SystemBars 插件只在「WebView ≥ 140 且页面带
 * viewport-fit=cover」时才把窗口内边距透传给页面（此时网页的 env(safe-area-inset-*) 才有值），
 * 不透传时它**只在 Android 15+**给 WebView 的父视图补内边距。于是「Android 14 及以下 +
 * 老 WebView」这一格两个机制都不生效：网页拿到的全是 0，内容就会压到状态栏与三大金刚下面
 * （小米 14 这类 Android 14 机器上实测就是这个表现）。
 *
 * 这里的做法：读窗口的真实内边距，注入 --native-inset-*（CSS 里与 env()、Capacitor 注入的
 * --safe-area-inset-* 一起取最大值）。已经由原生补过内边距的情况一律发 0，避免叠加两遍。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "miki-insets";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        // WebView 自己的内边距变化（键盘弹出/收起、切换导航方式、旋转）都要重发一次。
        // 只挂监听、不消费 insets：ViewCompat 的监听器是在 View.onApplyWindowInsets 之后
        // 才被调用，WebView 内部的处理不受影响。
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            publishInsets();
            return insets;
        });
        publishInsets();
    }

    @Override
    public void onResume() {
        super.onResume();
        publishInsets();
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
            // 键盘占着底部时底部内边距交给键盘（与 Capacitor 的 calcSafeAreaInsets 同口径），
            // 否则三大金刚会与键盘叠加出一段多余空白。
            int bottom = insets.isVisible(WindowInsetsCompat.Type.ime()) ? 0 : bars.bottom;

            float density = getResources().getDisplayMetrics().density;
            int top = handled(parent.getPaddingTop(), bars.top) ? 0 : Math.round(bars.top / density);
            int left = handled(parent.getPaddingLeft(), bars.left) ? 0 : Math.round(bars.left / density);
            int right = handled(parent.getPaddingRight(), bars.right) ? 0 : Math.round(bars.right / density);
            int bottomCss = handled(parent.getPaddingBottom(), bottom) ? 0 : Math.round(bottom / density);

            String script = "document.documentElement.style.setProperty('--native-inset-top','" + top + "px');"
                + "document.documentElement.style.setProperty('--native-inset-right','" + right + "px');"
                + "document.documentElement.style.setProperty('--native-inset-bottom','" + bottomCss + "px');"
                + "document.documentElement.style.setProperty('--native-inset-left','" + left + "px');";
            webView.evaluateJavascript(script, null);
            // 排安全区问题时用 adb logcat -s miki-insets 就能看清"系统报了多少、原生补了多少、
            // 这次发给网页的是多少"，不用改代码重新装包。
            Log.d(TAG, "bars=" + bars.top + "/" + bottom + " parentPad="
                + parent.getPaddingTop() + "/" + parent.getPaddingBottom()
                + " -> css=" + top + "/" + bottomCss);
        });
    }

    /** 原生父视图已经按这个尺寸留过白了吗（留 2px 容差，dp 换算会取整）。 */
    private static boolean handled(int actualPaddingPx, int expectedPx) {
        return actualPaddingPx >= expectedPx - 2;
    }
}
