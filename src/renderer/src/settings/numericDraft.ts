// 数值草稿 hook（从 Settings.tsx 收敛出的纯逻辑，便于单测）：
// 滑块拖动/连续输入过程只改本地草稿，停顿 delay 毫秒、flush() 或卸载才落盘一次；
// 落盘后 reload 回读的「回声」（等于上次发送值）不回写草稿，避免拖动中被旧值拉回。
//
// 回声判定用「在途发送值多重集」而非单槽：连续两次 commit 重叠时（第一次 reload 回包
// 未回、第二次已发出），单槽会被第二次覆盖，旧回声随即被误判为外部变化回写草稿——
// 进行中的编辑被拉回旧值，最终 commit 的也是被污染的草稿。这里每次 commit 把发送值
// 进 pending 集合，configValue 命中集合即自家回声：吞掉并消费一个，绝不回写草稿；
// 未命中才是真正外部变化，同步草稿。同值重复发送各认领各的回声（多重集语义）。
import { useEffect, useRef, useState } from 'react'

export interface NumericDraft {
  draft: number
  set(v: number): void
  flush(): void
}

export function useNumericDraft(configValue: number, commit: (v: number) => void, delay = 400): NumericDraft {
  const [draft, setDraft] = useState(configValue)
  const draftRef = useRef(configValue)
  // 已 commit 但 reload 可能未回的发送值；回声丢失（极端）时残留条目只会吞掉一次
  // 同值外部变化（值本就相同，无可见影响），下不为例的清理点在卸载
  const pendingEchoes = useRef<number[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // 外部配置变化同步草稿；与在途发送值一致的回声吞掉不回写
  useEffect(() => {
    const i = pendingEchoes.current.indexOf(configValue)
    if (i !== -1) {
      pendingEchoes.current.splice(i, 1)
      return
    }
    draftRef.current = configValue
    setDraft(configValue)
  }, [configValue])

  const set = (v: number) => {
    draftRef.current = v
    setDraft(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      pendingEchoes.current.push(draftRef.current)
      commitRef.current(draftRef.current)
    }, delay)
  }

  // 松手/失焦立即落盘，不等防抖计时
  const flush = () => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = null
    pendingEchoes.current.push(draftRef.current)
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
