# Miki · Android 客户端

同一份 miki 数据（工作区文件夹）在手机上的客户端。桌子上的那台是 Electron 应用，这里是
Capacitor 壳 + React：**调度与数据层是同一批纯函数**（`src/core`、`src/shared`），差异只在
三处——

| 层 | 桌面端 | 手机端 |
| --- | --- | --- |
| 文件访问 | `node:fs` | Capacitor Filesystem 桥（`src/mobile/fs/`，浏览器开发时用内存实现） |
| 界面 | 五视图 + 独立卡片窗口 | 面向触屏的另一套页面 + 抽屉导航（`src/ui/`） |
| 跨端一致 | git 直接推拉 | 应用内同步：拉取 → 行合并 → 推送（`src/mobile/sync/`） |

## 开发与构建

```bash
npm install
npm run dev          # 浏览器里开发（FileStore 用内存实现，不需要模拟器）
npm run build        # 产出 web 产物到 dist/
npx cap sync android # 同步进 android/ 工程
cd android && ./gradlew assembleDebug   # → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

改完界面代码后必须走 `npm run build` → `npx cap sync android` → `gradlew` → 安装这一整条链：
直接改 `android/app/src/main/assets/` 里的产物会在下次 `cap sync` 时被覆盖。

首次构建要装 Android SDK（`platforms;android-36` + `build-tools;36.0.0`），并让 `android/local.properties`
指向它；依赖源在 `android/build.gradle` 里已配成阿里云镜像优先、官方兜底——Maven Central 在国内直连
会 TLS 握手失败，换源理由与实测数字见该文件顶部注释。

提交前门禁：

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

测试套件清单与两个真机专属的坑（第二次加载要强制重建调度索引、网络层必须禁掉 HTTP 缓存）
见 [docs/zh/development.md](../docs/zh/development.md) 的「Android 移动端」一节
（English: [docs/en/development.md](../docs/en/development.md)）。
English version of this file: [README.en.md](README.en.md)。

## 运行环境与配置

面向 Android 15 及以上（compileSdk / targetSdk 36，minSdk 24）。应用按边到边布局运行：内容是
绕开系统栏与键盘排布的，而不是靠系统缩小窗口——动布局或输入相关代码前，先看开发文档
「Android 移动端」一节里键盘避让那一层。

手机上的工作区**不是**桌面那个文件夹——它由同步建立：

1. 手机装好 APK 后，进「设置 → 配置同步」；
2. 填「一个私有 git 仓库」（`owner/repo`）、要同步的分支（首次用主分支即可）、以及一个
   **细粒度 PAT**——权限只需要该仓库的 **Contents: read/write**；
3. 点「保存并验证」（会调 GitHub 校验仓库与分支可达），再点「立即同步」把工作区拉到手机上。

凭据只存在应用私有目录里（其他应用读不到），界面回显只留前 4 位与后 4 位；「清空凭据」只清 token。

## 同步机制

同步有三种模式：**整轮**（拉取 → 合并 → 推送）、**只拉不推**（回前台时用，绝不推送）、
**强制拉取**（丢弃本机状态、以远端为准）。数据文件是 NDJSON，所以合并大部分是行并集；两种情况
刻意不猜：

- **同一张卡/同一份文档两侧改得不一样**：同一 id 的内容行两侧不同，或 `decks.json` /
  `config.json` 两侧都变了 → 停止合并并报出来，不选赢家。这两个 JSON 是整体文档，行并集对它们
  不成立。
- **没有可合并的内容**：远端没有新提交时整轮是空操作，不会产生空提交。

每次同步都会报告做了什么（看到哪些提交、合并了哪些文件、上传了多少条复习记录）；工作区前几次
的快照会保留，合并出问题可以回退。

## v1 的边界

- **只追加、不压实**：手机端不会重写卡片基文件。压实（checkpoint + delta 收敛）留在桌面端，
  因为那一步需要按行拼接之外的信息。
- **不追求极致性能**：目标是自己手机上可用；大库实测（200 牌组 / 5000 卡 / 2 万事件）工作区
  就绪 2.3–2.6s，够用即止。
- **debug 签名**：当前产物是 debug 签名的 APK（Android 会标注为调试用途）；长期自用或换机迁移
  需要 release keystore 与 versionCode 策略，尚未做。
