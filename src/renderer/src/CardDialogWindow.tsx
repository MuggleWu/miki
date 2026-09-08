// 卡片弹窗子窗口的渲染层根组件：hash 路由 #card-dialog 时由 main.tsx 挂载（代替 App）。
// 独立 BrowserWindow 宿主，可拖出主窗口/拖到其他屏幕；提交后经主进程转发刷新事件给主窗口。
// 载荷由主进程在窗口显示时下发（onCardDialogPayload），未到达前渲染加载占位
import { useEffect, useState } from 'react'
import { CardForm } from './components/AddEditDialog'
import { useApp } from './store'
import { payloadToDialog } from '../../shared/card-dialog'
import type { DialogState } from '../../shared/types'

export function CardDialogWindow() {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const reload = useApp((s) => s.reload)

  useEffect(() => {
    void reload()
    const offPayload = window.miki.onCardDialogPayload((p) => {
      const d = payloadToDialog(p)
      if (d) setDialog(d)
    })
    const offWs = window.miki.onWorkspaceChanged(() => void reload())
    return () => {
      offPayload()
      offWs()
    }
  }, [reload])

  // 主进程保证载荷在显示前排队、显示后必达；防御性兜底：3s 仍无载荷则自关（异常路径不留空窗）
  useEffect(() => {
    if (dialog) return
    const t = setTimeout(() => void window.miki.closeCardDialog(), 3000)
    return () => clearTimeout(t)
  }, [dialog])

  if (!dialog) return <div className="dialog-window-loading">加载中…</div>
  return (
    <div className="dialog-window">
      <CardForm
        key={`${dialog.mode}-${dialog.cardId ?? dialog.deckId ?? ''}`}
        mode={dialog.mode}
        deckId={dialog.deckId}
        cardId={dialog.cardId}
        showHint
        keepAfterAdd={dialog.mode === 'add'}
        onSubmitted={(kind) => void window.miki.notifyCardsChanged(kind)}
        onCancelled={() => void window.miki.closeCardDialog()}
      />
    </div>
  )
}
