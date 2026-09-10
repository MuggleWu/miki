// 卡片库的单卡编辑缓冲 + 防抖落盘。
//
// 从 Browser.tsx 里整块搬出来的（原先内联在主组件里）：这三样东西共用同一个不变量——
// 「切卡/离开页面前必须把上一张卡的在途编辑落盘」，而缺了它的后果是静默丢数据
// （选中 A 打字 → debounce 未到就切到 B → B 的 onChange clearTimeout 掉 A 的计时，A 的编辑无声消失）。
// 收成一个 hook 后，撤销栈/清理 effect/目标卡固定这三处不再各自散落。
//
// 两个容易改错的地方，搬过来时连注释一起带上了：
//   1. 目标卡 id 在「排计时」时就固定进 pendingSave，不依赖闭包里的 selected——
//      切卡后那份内容仍要落回原卡。
//   2. 清理 effect 的依赖是 selected?.id 而不是 selected 对象：行对象每次重查都是新引用，
//      依赖对象会让「每查一次就误 flush」。这也是这里要写 eslint-disable 的原因。
//
// 文件名是 .tsx（尽管没有 JSX）：仓库的 react-hooks 规则只对 src/renderer/**/*.tsx 生效，
// 用 .ts 会让下面那行 eslint-disable 指向一条未启用的规则从而直接报错。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CardRow } from '../../../shared/types'

export interface CardEditor {
  /** 正面编辑缓冲；null = 未选中卡片 */
  front: string | null
  back: string | null
  setFront: (v: string) => void
  setBack: (v: string) => void
  /** 内容改动：登记待落盘内容并按 debounce 排计时 */
  scheduleSave: (front: string, back: string) => void
  /** 立即落盘在途编辑（切卡/离开页面前调用）；无在途计时是 no-op */
  flush: () => void
  /** 落盘失败的原因（卡已被删/不存在时给用户看）；null = 没有失败。
   * 以前这里无条件调 onSaved 刷视图，卡已删时用户看到的是「刚打的字自己弹回去」，
   * 既不知道没保存、也不知道为什么 */
  saveError: string | null
}

/**
 * @param selected 当前选中行（null = 未选中）
 * @param debounceMs 防抖间隔；测试注入小值（默认 800ms 是真实手感值）
 * @param onSaved 落盘成功后的回调（生产传 query，刷新当前视图）
 */
export function useCardEditor(
  selected: CardRow | null,
  debounceMs: number,
  onSaved: () => Promise<void> | void
): CardEditor {
  const [front, setFront] = useState<string | null>(null)
  const [back, setBack] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 在途未落盘的编辑（含目标卡 id）：切卡/离开页面前必须先落这张卡的这份内容 */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ cardId: string; front: string; back: string } | null>(null)
  // 回调进 ref：scheduleSave/flush 的依赖里就不必带 onSaved，避免它每次换引用导致
  // 排好的计时被重建（也会让下面的清理 effect 反复 flush）。
  // 用 effect 而不是「渲染期直接赋值 ref」：后者是渲染期副作用（react-hooks/refs 会报，
  // 且并发渲染下不保证执行）。这里晚一帧更新无副作用——回调只负责刷新视图，
  // 落盘本身在 write 里同步发起。
  const savedRef = useRef(onSaved)
  useEffect(() => {
    savedRef.current = onSaved
  }, [onSaved])

  // 切卡时把缓冲换成新卡内容，而不是留着上一张的（否则会显示错内容并可能写错卡）
  useEffect(() => {
    setFront(selected ? selected.front : null)
    setBack(selected ? selected.back : null)
    setSaveError(null) // 上一张卡的失败提示不跟着换到新卡
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const write = useCallback((p: { cardId: string; front: string; back: string }) => {
    void window.miki.updateCard(p.cardId, { front: p.front, back: p.back }).then(
      (saved) => {
        if (saved) {
          setSaveError(null)
          savedRef.current()
        } else {
          // updateCard 返回 null = 卡不存在或已被软删：这份内容根本没落盘，
          // 不能刷视图假装成功，也不能清掉错误提示
          setSaveError('改动未保存：这张卡已被删除')
        }
      },
      () => setSaveError('改动未保存：写入失败')
    )
  }, [])

  const scheduleSave = useCallback(
    (f: string, b: string) => {
      if (!selected) return
      const cardId = selected.id
      pending.current = { cardId, front: f, back: b }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        const p = pending.current
        pending.current = null
        if (p) write(p)
      }, debounceMs)
    },
    [selected, debounceMs, write]
  )

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    if (p) write(p)
  }, [write])

  // 切卡或离开卡片库前先落盘在途编辑（见文件头注释：缺这步会静默丢编辑）
  useEffect(() => () => flush(), [selected?.id, flush])

  // 窗口卸载（关窗/退出）时也落一次盘：这条路径上 React 不会执行上面的卸载清理
  // （进程直接结束，jsdom 里的 unmount 测试覆盖不到），用户最后那次编辑会随 debounce 一起丢。
  // 用同步通道：异步 invoke 发出去后进程可能先被杀掉，写盘不保证完成。
  useEffect(() => {
    const onUnload = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const p = pending.current
      pending.current = null
      if (p) window.miki.flushPendingEdit(p.cardId, { front: p.front, back: p.back })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return { front, back, setFront, setBack, scheduleSave, flush, saveError }
}
