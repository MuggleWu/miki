// 移动端入口：挂 window.miki（M1 起为本地实现）→ 渲染 App。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@ui/App'
import '@ui/styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
