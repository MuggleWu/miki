// 数值草稿 hook（从 Settings.tsx 收敛出的纯逻辑，便于单测）：
// 滑块拖动/连续输入过程只改本地草稿，停顿 delay 毫秒、flush() 或卸载才落盘一次；
// 落盘后 reload 回读的「回声」（等于上次发送值）不回写草稿，避免拖动中被旧值拉回。
import { useEffect, useRef, useState } from 'react'

export interface NumericDraft {
  draft: number
  set(v: number): void
  flush(): void
}

export function useNumericDraft(configValue: number, commit: (v: number) => void, delay = 400): NumericDraft {
  const [draft, setDraft] = useState(configValue)
  const draftRef = useRef(configValue)
  const sentRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // 外部配置变化同步草稿；自家落盘的回声一次性消费，不回写
  useEffect(() => {
    const isEcho = sentRef.current !== null && configValue === sentRef.current
    sentRef.current = null
    if (isEcho) return
    draftRef.current = configValue
    setDraft(configValue)
  }, [configValue])

  const set = (v: number) => {
    draftRef.current = v
    setDraft(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      sentRef.current = draftRef.current
      commitRef.current(draftRef.current)
    }, delay)
  }

  // 松手/失焦立即落盘，不等防抖计时
  const flush = () => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
    sentRef.current = draftRef.current
    commitRef.current(draftRef.current)
  }

  // 带着未落盘的草稿离开设置页：补一次落盘
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        commitRef.current(draftRef.current)
      }
    },
    []
  )

  return { draft, set, flush }
}
