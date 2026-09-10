import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CardDialogWindow } from './CardDialogWindow'
import { isCardDialogHash } from '../../shared/card-dialog'
import { preloadAllLangs, preloadHighlighter } from './highlighter'
import 'katex/dist/katex.min.css'
import './styles.css'

// 路由分流：主窗口无 hash → App；卡片弹窗子窗口 #card-dialog → CardDialogWindow（无顶栏无路由）
const Root = isCardDialogHash(window.location.href) ? CardDialogWindow : App

// 先渲染，再补高亮引擎。引擎（shiki/core + 正则引擎 + 各语言包）走动态 import，
// 不再挡在首帧前面：原先要等主包解析完再加引擎约 126ms 才画第一个像素。
// 首帧里代码块以转义纯文本出现，引擎就绪后由 Md 的重渲染补上 token 色（md.tsx 订阅）。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)

// 首帧之后预热引擎（rAF 让出这一帧）：引擎就绪前的代码块先以纯文本出现，就绪后由 Md 补色。
// 引擎（shiki/core + 正则引擎）只是两个小 chunk，先就位即可开始渲染带色代码块；
// 18 个语言包随后并行加载（各自独立 chunk），不阻塞首帧也不阻塞引擎启用。
// preloadHighlighter 自带模块级去重，与 Md 订阅时的触发合流为一次加载；失败也不影响使用。
requestAnimationFrame(() => {
  void preloadHighlighter().then(() => preloadAllLangs())
})
