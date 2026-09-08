// 卡片添加/编辑表单：正反面双栏 markdown 编辑 + 预览，cmd+enter 提交。
// 被两个宿主复用：
//   1. 主窗口 DOM 弹窗壳（AddEditDialog，本文件）
//   2. 卡片弹窗子窗口（CardDialogWindow.tsx，独立 BrowserWindow，可拖出主窗口）
// 表单本身不含开/关逻辑：初始值与提交/取消回调由宿主注入
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Md } from '../md'
import { sortedDecks, useApp } from '../store'
import type { DialogState } from '../../../shared/types'

/** wrap 类编辑（bold/backtick）纯函数的统一返回：替换范围、替换文本、应用后新选区 */
export interface WrapResult {
  text: string
  replaceStart: number
  replaceEnd: number
  replacement: string
  selStart: number
  selEnd: number
}

/** 选中区加粗开关键（⌘B）：算出替换范围/替换文本/新选区。纯函数便于测试 */
export function boldSelection(
  value: string,
  start: number,
  end: number
): WrapResult {
  const sel = value.slice(start, end)
  // 无选区：光标处插入 ****，光标落中间
  if (sel === '') {
    return {
      text: value.slice(0, start) + '****' + value.slice(end),
      replaceStart: start,
      replaceEnd: start,
      replacement: '****',
      selStart: start + 2,
      selEnd: start + 2
    }
  }
  // 选中内容自带 ** 对（含恰选中一个空 **）→ 去掉
  if (sel === '**' || (sel.length >= 4 && sel.startsWith('**') && sel.endsWith('**'))) {
    const inner = sel === '**' ? '' : sel.slice(2, -2)
    return {
      text: value.slice(0, start) + inner + value.slice(end),
      replaceStart: start,
      replaceEnd: end,
      replacement: inner,
      selStart: start,
      selEnd: start + inner.length
    }
  }
  // 选区紧贴外侧 ** 对 → 去掉外侧（选中的是不含星号的内容）
  if (start >= 2 && value.slice(start - 2, start) === '**' && value.slice(end, end + 2) === '**') {
    return {
      text: value.slice(0, start - 2) + sel + value.slice(end + 2),
      replaceStart: start - 2,
      replaceEnd: end + 2,
      replacement: sel,
      selStart: start - 2,
      selEnd: end - 2
    }
  }
  // 普通选区：两侧包 **，选区保持在内层
  return {
    text: value.slice(0, start) + '**' + sel + '**' + value.slice(end),
    replaceStart: start,
    replaceEnd: end,
    replacement: '**' + sel + '**',
    selStart: start + 2,
    selEnd: end + 2
  }
}

/** 单按反引号：无选区插一对 ` 光标落中间；有选区两侧包 ` 选区保持内层。
 * 不做 toggle——三连按出代码块依赖「按 2 下后文本呈 ``|`` 形态」，toggle 会拆掉中间态 */
export function backtickSelection(value: string, start: number, end: number): WrapResult {
  if (start === end) {
    return {
      text: value.slice(0, start) + '``' + value.slice(end),
      replaceStart: start,
      replaceEnd: start,
      replacement: '``',
      selStart: start + 1,
      selEnd: start + 1
    }
  }
  const sel = value.slice(start, end)
  return {
    text: value.slice(0, start) + '`' + sel + '`' + value.slice(end),
    replaceStart: start,
    replaceEnd: end,
    replacement: '`' + sel + '`',
    selStart: start + 1,
    selEnd: end + 1
  }
}

/** 三连按反引号检测（第三下触发）：前两下单按的产物恰好是可检测的文本形态——
 * 无选区且光标两侧紧贴各 2 个 `（``|``）→ 替换为空围栏代码块，光标落内容行；
 * 选区外侧紧贴 `` 对（``sel`` 双层包裹）→ 替换为 ```/sel/``` 围栏代码块，选区保持内容。
 * 纯文本形态检测不限按键间隔，不匹配返回 null（由单按逻辑接管） */
export function tripleBacktick(value: string, start: number, end: number): WrapResult | null {
  if (start === end) {
    if (value.slice(start - 2, start) !== '``' || value.slice(end, end + 2) !== '``') return null
    return {
      text: value.slice(0, start - 2) + '```\n\n```' + value.slice(end + 2),
      replaceStart: start - 2,
      replaceEnd: end + 2,
      replacement: '```\n\n```',
      selStart: start + 2,
      selEnd: start + 2
    }
  }
  const sel = value.slice(start, end)
  if (value.slice(start - 2, start) !== '``' || value.slice(end, end + 2) !== '``') return null
  return {
    text: value.slice(0, start - 2) + '```\n' + sel + '\n```' + value.slice(end + 2),
    replaceStart: start - 2,
    replaceEnd: end + 2,
    replacement: '```\n' + sel + '\n```',
    selStart: start + 2,
    selEnd: start + 2 + sel.length
  }
}

/** 反引号键入口：先试三连按转换，未命中走单按包裹 */
export function tickSelection(value: string, start: number, end: number): WrapResult {
  return tripleBacktick(value, start, end) ?? backtickSelection(value, start, end)
}

/** Enter 列表续行：光标在列表项行末回车，下一行补同级标记（保留缩进，有序列表数字 +1）；
 * 空列表项（标记后无内容）回车视为退出列表，删除标记只留缩进。
 * 有选区、光标不在行末、非列表行返回 null，走默认换行 */
export function enterContinueList(value: string, start: number, end: number): WrapResult | null {
  if (start !== end) return null
  const nl = value.indexOf('\n', start)
  const lineEnd = nl === -1 ? value.length : nl
  if (end !== lineEnd) return null
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  // 标记后至少一个空白才算列表项（-abc 不算），标记后的空白首字符随续行沿用
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(value.slice(lineStart, lineEnd))
  if (!m) return null
  const [, indent, marker, space, rest] = m
  if (rest === '') {
    // 空列表项：整行删成只剩缩进（再回车就是普通空行）
    return {
      text: value.slice(0, lineStart) + indent + value.slice(lineEnd),
      replaceStart: lineStart,
      replaceEnd: lineEnd,
      replacement: indent,
      selStart: lineStart + indent.length,
      selEnd: lineStart + indent.length
    }
  }
  const ordered = /^(\d{1,9})([.)])$/.exec(marker)
  const nextMarker = ordered ? String(Number(ordered[1]) + 1) + ordered[2] : marker
  const ins = '\n' + indent + nextMarker + space[0]
  return {
    text: value.slice(0, start) + ins + value.slice(start),
    replaceStart: start,
    replaceEnd: start,
    replacement: ins,
    selStart: start + ins.length,
    selEnd: start + ins.length
  }
}

/** 把 wrap 类编辑（bold/backtick/list）的结果应用到文本框：优先 execCommand（保留原生撤销栈，
 * ⌘Z 可回退），失败退回直改。fn 返回 null 表示不接管（如 Enter 非列表行），不动文本框返回 false，
 * 返回 true 表示已接管（调用方需据此 preventDefault） */
export function applyWrap(
  el: HTMLTextAreaElement,
  setText: (v: string) => void,
  fn: (value: string, start: number, end: number) => WrapResult | null
): boolean {
  const { selectionStart: s, selectionEnd: e } = el
  if (s == null || e == null) return false
  const r = fn(el.value, s, e)
  if (!r) return false
  el.focus()
  el.setSelectionRange(r.replaceStart, r.replaceEnd)
  try {
    document.execCommand('insertText', false, r.replacement)
  } catch {
    // 不支持时走下面的受控直改
  }
  setText(r.text) // execCommand 成功时与原生 input 事件同值（no-op），失败时兜底同步受控状态
  requestAnimationFrame(() => el.setSelectionRange(r.selStart, r.selEnd))
  return true
}

export interface CardFormProps {
  /** add：初始牌组（null = 取第一个牌组）；edit：忽略，牌组只读展示卡所在牌组名 */
  mode: 'add' | 'edit'
  deckId: string | null
  cardId: string | null
  /** 卡片内容版本：edit 回填后宿主可用 key 重挂载；本组件只管表单内状态 */
  onSubmitted?: (kind: 'add' | 'edit') => void
  /** 用户主动取消（Esc / 取消按钮）；宿主决定关弹窗还是仅重置 */
  onCancelled?: () => void
  /** 提交按钮文字与标题（弹窗窗口标题栏由 main 设置） */
  submitLabel?: string
  title?: string
  /** 底部左侧提示（主窗口弹窗显示快捷键说明；子窗口传 false 隐藏） */
  showHint?: boolean
  /** add 模式提交成功后是否保留表单（主窗口连续新增）；子窗口固定 false */
  keepAfterAdd?: boolean
}

/** 表单主体：弹窗壳与子窗口共用。牌组选择/内容编辑/校验/提交全在这里，宿主只接 onSubmitted/onCancelled */
export function CardForm(props: CardFormProps) {
  const { mode, deckId, cardId, onSubmitted, onCancelled, submitLabel, title, showHint = true, keepAfterAdd = false } = props
  const decks = useApp((s) => s.decks)
  const reload = useApp((s) => s.reload)
  const bumpContent = useApp((s) => s.bumpContent)

  const [deck, setDeck] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [loaded, setLoaded] = useState(mode === 'add')
  const [editDeckId, setEditDeckId] = useState<string | null>(null)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (mode !== 'add') return
    // add：开表单初始化一次。decks 不进依赖：60s 轮询换新数组引用会把已输入内容冲掉
    setDeck(deckId ?? sortedDecks(useApp.getState().decks)[0]?.id ?? '')
    setFront('')
    setBack('')
    setLoaded(true)
  }, [mode, deckId])

  // add 模式：表单先于牌组列表就绪（子窗口 mount 后异步 reload）时，列表到达后补选第一个牌组。
  // 只补空值，不动已选项；不重置正反面输入
  useEffect(() => {
    if (mode !== 'add' || deck) return
    const first = sortedDecks(decks)[0]?.id
    if (first) setDeck(first)
  }, [mode, deck, decks])

  useEffect(() => {
    if (mode !== 'edit' || !cardId) return
    let alive = true
    setLoaded(false)
    void window.miki.getCard(cardId).then((card) => {
      if (!alive) return
      if (card) {
        setFront(card.front)
        setBack(card.back)
        setEditDeckId(card.deckId) // 牌组名从 decks 派生（decks 异步到达后自动补显）
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [mode, cardId])

  // 内容就绪后聚焦正面输入框，光标落到内容末尾，打开即可续写
  useEffect(() => {
    if (!loaded) return
    const el = frontRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [loaded, mode])

  const submit = async () => {
    if (front.trim() === '' && back.trim() === '') return
    if (mode === 'add') {
      if (!deck) return
      await window.miki.addCard(deck, front, back)
      if (keepAfterAdd) {
        // 连续新增：保留表单，清空输入继续录下一张
        setFront('')
        setBack('')
        frontRef.current?.focus()
      }
    } else if (cardId) {
      await window.miki.updateCard(cardId, front, back)
      bumpContent() // 学习页当前卡就地重取内容（同卡保留提问/答案相位）
    }
    onSubmitted?.(mode)
    await reload()
    if (mode === 'edit' || !keepAfterAdd) onCancelled?.()
  }

  const form = (
    <>
      <h3>{title ?? (mode === 'add' ? '添加卡片' : '编辑卡片')}</h3>
      {mode === 'add' && (
        <div className="form-row">
          <label>牌组</label>
          <select value={deck} onChange={(e) => setDeck(e.target.value)}>
            {sortedDecks(decks).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {mode === 'edit' && editDeckId && decks.length > 0 && (
        <div className="form-row">
          <label>牌组</label>
          <input value={decks.find((d) => d.id === editDeckId)?.name ?? '（牌组不存在）'} readOnly />
        </div>
      )}
      {loaded && (
        <>
          <div className="dual">
            <div>
              <div className="tag">
                <span>正面（Markdown）</span>
              </div>
              <textarea
                ref={frontRef}
                value={front}
                onChange={(e) => setFront(e.target.value)}
                placeholder="问题 / 提示"
              />
            </div>
            <div>
              <div className="tag">
                <span>正面预览</span>
              </div>
              <div className="preview">
                <Md source={front} />
              </div>
            </div>
          </div>
          <div className="dual">
            <div>
              <div className="tag">
                <span>反面（Markdown）</span>
              </div>
              <textarea
                value={back}
                onChange={(e) => setBack(e.target.value)}
                placeholder="答案"
              />
            </div>
            <div>
              <div className="tag">
                <span>反面预览</span>
              </div>
              <div className="preview">
                <Md source={back} />
              </div>
            </div>
          </div>
        </>
      )}
      <div className="actions">
        {showHint && (
          <span style={{ color: 'var(--text-dim)', fontSize: 12, marginRight: 'auto', alignSelf: 'center' }}>
            <kbd className="kbd">⌘</kbd>+<kbd className="kbd">B</kbd> 加粗 · <kbd className="kbd">`</kbd> 行内代码（连按三下出代码块） ·{' '}
            <kbd className="kbd">↩</kbd> 列表续行 · <kbd className="kbd">⌘</kbd>+<kbd className="kbd">↩</kbd> 提交 ·{' '}
            <kbd className="kbd">esc</kbd> 关闭
          </span>
        )}
        <button onClick={() => onCancelled?.()}>{keepAfterAdd ? '关闭' : '取消'}</button>
        <button className="primary" onClick={() => void submit()}>
          {submitLabel ?? (mode === 'add' ? '添加' : '确认')}
        </button>
      </div>
    </>
  )

  // 键盘处理对两个宿主一致；Esc 交给宿主关闭（onCancelled），这里只管编辑键与提交
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      const el = e.target instanceof HTMLTextAreaElement ? e.target : null
      if (el) {
        e.preventDefault()
        applyWrap(el, el === frontRef.current ? setFront : setBack, boldSelection)
      }
      return
    }
    if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = e.target instanceof HTMLTextAreaElement ? e.target : null
      if (el) {
        e.preventDefault()
        applyWrap(el, el === frontRef.current ? setFront : setBack, tickSelection)
      }
      return
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 普通回车：列表项行末续行 / 空列表项退出列表，其余走默认换行（组合输入中不接管）
      const el = e.target instanceof HTMLTextAreaElement ? e.target : null
      if (el && !e.nativeEvent.isComposing) {
        const handled = applyWrap(el, el === frontRef.current ? setFront : setBack, enterContinueList)
        if (handled) e.preventDefault()
      }
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
    if (e.key === 'Escape') onCancelled?.()
  }

  return (
    <div className="modal dialog-wide" onKeyDown={onKeyDown}>
      {form}
    </div>
  )
}

/** 主窗口 DOM 弹窗壳：从 store.dialog 读取状态渲染 CardForm（原有行为不变） */
export function AddEditDialog() {
  const dialog = useApp((s) => s.dialog)
  const closeDialog = useApp((s) => s.closeDialog)

  if (!dialog) return null
  const d: DialogState = dialog
  return (
    <div className="overlay">
      <CardForm
        mode={d.mode}
        deckId={d.deckId}
        cardId={d.cardId}
        keepAfterAdd={d.mode === 'add'}
        onCancelled={closeDialog}
      />
    </div>
  )
}
