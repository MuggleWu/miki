import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { preloadHighlighter } from './highlighter'
import 'katex/dist/katex.min.css'
import './styles.css'

// 高亮引擎预载后首渲染，保证首批卡片代码块直接带 token 色；失败（不应发生）也照常渲染，走转义兜底
preloadHighlighter().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
