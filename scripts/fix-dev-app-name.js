// 开发模式下应用名显示为 "Electron" 的根因：macOS 菜单栏/应用菜单的名字硬绑
// node_modules 里 Electron.app 的 Info.plist（CFBundleName），Menu API 改不动它。
// 该改动会被重装依赖覆盖，因此挂在 postinstall 上每次安装后自动重跑。
// Windows 的进程名跟随 electron.exe，无法在开发模式安全改名，由窗口标题
// （Miki）+ 打包后的 productName 承担，这里不做处理。
const { execSync } = require('node:child_process')
const path = require('node:path')

if (process.platform === 'darwin') {
  const plist = path.join(
    __dirname,
    '..',
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'Info.plist'
  )
  execSync(`plutil -replace CFBundleName -string "Miki" "${plist}"`)
  execSync(`plutil -replace CFBundleDisplayName -string "Miki" "${plist}"`)
  console.log('[fix-dev-app-name] Electron.app 显示名已改为 Miki')
}
