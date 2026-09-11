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
  }
}

export default config
