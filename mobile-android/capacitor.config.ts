// Capacitor 配置：webDir 指向 Vite 产物；android/ 原生工程由 `npx cap add android` 生成。
// 本工程不含任何自写 Kotlin 插件——文件读写走官方 Filesystem 的 Directory.Data（应用私有目录，零权限）。
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // 与桌面端 appId 同名不同平台，互不影响
  appId: 'com.mugglewu.miki',
  appName: 'Miki',
  webDir: 'dist',
  android: {
    // 与 GitHub 说话是纯 HTTPS，不开混合内容；调试期用 chrome://inspect 看 WebView
    allowMixedContent: false
  },
  plugins: {
    SystemBars: {
      // 安全区一律由**网页自己**处理（styles.css 的 --inset-*），不让原生再掺一脚。
      //
      // 为什么关掉 Capacitor 的自动处理：它那套的生效条件随 WebView 版本与 Android 版本漂移
      // （WebView ≥ 140 且 viewport-fit=cover 才给真实 env()；只在 Android 15+ 才给 WebView 的
      // 父视图补内边距）。于是「Android 14 + 老 WebView」这一格两个机制都不生效，网页拿到全 0，
      // 内容压进状态栏与导航栏。关掉之后所有设备走同一条路：MainActivity 读真实窗口内边距注入
      // --native-inset-*，CSS 取 env() / Capacitor 注入值 / --native-inset-* 三者最大值。
      // 顺带解决验证问题：以前模拟器落在"原生已补内边距"那格，真机那格的问题在模拟器上看不见。
      insetsHandling: 'disable'
    }
  }
}

export default config
