// 添加/编辑卡片弹窗（S3/S4）：正反面双栏 markdown 编辑 + 预览，cmd+enter 提交
// 添加模式提交后弹窗保留并清空输入（连续新增场景），Esc/取消才关闭
import { useEffect, useRef, useState } from 'react'
import { Md } from '../md'
import { sortedDecks, useApp } from '../store'

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

/** 把 wrapSelection 的结果应用到文本框：优先 execCommand（保留原生撤销栈，⌘Z 可回退），失败退回直改 */
export function applyWrap(
  el: HTMLTextAreaElement,
  setText: (v: string) => void,
  fn: (value: string, start: number, end: number) => WrapResult
): void {
  const { selectionStart: s, selectionEnd: e } = el
  if (s == null || e == null) return
  const r = fn(el.value, s, e)
  el.focus()
  el.setSelectionRange(r.replaceStart, r.replaceEnd)
  try {
    document.execCommand('insertText', false, r.replacement)
  } catch {
    // 不支持时走下面的受控直改
  }
  setText(r.text) // execCommand 成功时与原生 input 事件同值（no-op），失败时兜底同步受控状态
  requestAnimationFrame(() => el.setSelectionRange(r.selStart, r.selEnd))
}

export function AddEditDialog() {
  const dialog = useApp((s) => s.dialog)
  const decks = useApp((s) => s.decks)
  const closeDialog = useApp((s) => s.closeDialog)
  const reload = useApp((s) => s.reload)
  const bumpContent = useApp((s) => s.bumpContent)

  const [deckId, setDeckId] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [loaded, setLoaded] = useState(false)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!dialog) return
    // 只在弹窗打开时初始化一次。decks 不能进依赖：App 的 60s 轮询与切视图都会 reload()
    // 换新 decks 数组引用，若它在依赖里，弹窗开着时正反面输入会被清空
    // （add：白打；edit：闪断后回退到已保存内容，未保存输入丢失）。
    // 开窗瞬间的默认牌组用 getState 现取，不建立对 decks 的响应式依赖。
    setDeckId(dialog.deckId ?? sortedDecks(useApp.getState().decks)[0]?.id ?? '')
    setFront('')
    setBack('')
    setLoaded(dialog.mode === 'add')
    if (dialog.mode === 'edit' && dialog.cardId) {
      void window.miki.getCard(dialog.cardId).then((card) => {
        // 回填前确认仍是同一个弹窗会话：防止快速取消→再开新弹窗时旧 promise 串场覆盖
        if (card && useApp.getState().dialog === dialog) {
          setFront(card.front)
          setBack(card.back)
        }
        setLoaded(true)
      })
    }
  }, [dialog])

  if (!dialog) return null

  const submit = async () => {
    if (front.trim() === '' && back.trim() === '') return
    if (dialog.mode === 'add') {
      if (!deckId) return
      await window.miki.addCard(deckId, front, back)
      // 连续新增：保留弹窗，清空输入继续录下一张
      setFront('')
      setBack('')
      frontRef.current?.focus()
    } else if (dialog.cardId) {
      await window.miki.updateCard(dialog.cardId, front, back)
      bumpContent() // 学习页当前卡就地重取内容（同卡保留提问/答案相位）
      closeDialog()
    }
    await reload()
  }

  return (
    <div className="overlay">
      <div
        className="modal dialog-wide"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
            // ⌘/Ctrl+B：选区加粗开关键（正反面输入框内）
            const el = e.target instanceof HTMLTextAreaElement ? e.target : null
            if (el) {
              e.preventDefault()
              applyWrap(el, el === frontRef.current ? setFront : setBack, boldSelection)
            }
            return
          }
          if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // 反引号：单按包裹 / 三连按出代码块（正反面输入框内）
            const el = e.target instanceof HTMLTextAreaElement ? e.target : null
            if (el) {
              e.preventDefault()
              applyWrap(el, el === frontRef.current ? setFront : setBack, tickSelection)
            }
            return
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') closeDialog()
        }}
      >
        <h3>{dialog.mode === 'add' ? '添加卡片' : '编辑卡片'}</h3>
        {dialog.mode === 'add' && (
          <div className="form-row">
            <label>牌组</label>
            <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
              {sortedDecks(decks).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
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
                  autoFocus={dialog.mode === 'add'}
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
          <span style={{ color: 'var(--text-dim)', fontSize: 12, marginRight: 'auto', alignSelf: 'center' }}>
            <kbd className="kbd">⌘</kbd>+<kbd className="kbd">B</kbd> 加粗 · <kbd className="kbd">`</kbd> 行内代码（连按三下出代码块） ·{' '}
            <kbd className="kbd">⌘</kbd>+<kbd className="kbd">↩</kbd> 提交 · <kbd className="kbd">esc</kbd> 关闭
          </span>
          <button onClick={closeDialog}>取消</button>
          <button className="primary" onClick={() => void submit()}>
            {dialog.mode === 'add' ? '添加' : '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
