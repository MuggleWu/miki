// card-dialog shared 纯函数单测：hash 路由、几何派生（钳制/居中/恢复）、载荷归一化与信任边界
import { describe, expect, it } from 'vitest'
import {
  CARD_DIALOG_DEFAULTS,
  CARD_DIALOG_MIN,
  clampNum,
  dialogToPayload,
  dialogWindowBounds,
  isCardDialogHash,
  payloadToDialog,
  withCardDialogHash
} from '../card-dialog'

describe('isCardDialogHash', () => {
  it('file: URL 带 #card-dialog → true', () => {
    expect(isCardDialogHash('file:///x/y/index.html#card-dialog')).toBe(true)
  })

  it('dev http URL 带 #card-dialog → true', () => {
    expect(isCardDialogHash('http://localhost:5173/#card-dialog')).toBe(true)
  })

  it('无 hash / 其他 hash → false', () => {
    expect(isCardDialogHash('file:///x/index.html')).toBe(false)
    expect(isCardDialogHash('http://localhost:5173/')).toBe(false)
    expect(isCardDialogHash('file:///x/index.html#other')).toBe(false)
  })

  it('查询串中带同名参数不算（hash 必须精确等于 #card-dialog）', () => {
    expect(isCardDialogHash('file:///x/index.html?a=card-dialog')).toBe(false)
  })

  it('非法 URL → false 不抛', () => {
    expect(isCardDialogHash('not a url')).toBe(false)
  })
})

describe('withCardDialogHash', () => {
  it('file: URL 追加 hash，路径保留', () => {
    expect(withCardDialogHash('file:///x/y/index.html')).toBe('file:///x/y/index.html#card-dialog')
  })

  it('dev http URL 追加 hash，查询串保留', () => {
    expect(withCardDialogHash('http://localhost:5173/?a=1')).toBe('http://localhost:5173/?a=1#card-dialog')
  })

  it('已有其他 hash 被覆盖', () => {
    expect(withCardDialogHash('file:///x/index.html#old')).toBe('file:///x/index.html#card-dialog')
  })

  it('与 isCardDialogHash 组合成环', () => {
    expect(isCardDialogHash(withCardDialogHash('file:///x/index.html'))).toBe(true)
    expect(isCardDialogHash(withCardDialogHash('http://localhost:5173/?v=2'))).toBe(true)
  })
})

describe('clampNum', () => {
  it('区间内原样、越界钳边、hi<lo 退化为 lo', () => {
    expect(clampNum(5, 0, 10)).toBe(5)
    expect(clampNum(-1, 0, 10)).toBe(0)
    expect(clampNum(11, 0, 10)).toBe(10)
    expect(clampNum(3, 5, 2)).toBe(5)
  })
})

describe('dialogWindowBounds', () => {
  const parent = { x: 100, y: 50, width: 1280, height: 840 }
  const workArea = { x: 0, y: 25, width: 1440, height: 900 } // macOS 菜单栏占顶部 25

  it('无记录：默认尺寸居中偏上（1/3 线）于主窗口', () => {
    const b = dialogWindowBounds(null, parent, workArea)
    expect(b.width).toBe(CARD_DIALOG_DEFAULTS.width)
    expect(b.height).toBe(CARD_DIALOG_DEFAULTS.height)
    expect(b.x).toBe(100 + Math.round((1280 - CARD_DIALOG_DEFAULTS.width) / 2))
    expect(b.y).toBe(50 + Math.round((840 - CARD_DIALOG_DEFAULTS.height) / 3))
  })

  it('有记录：沿用持久化位置/尺寸', () => {
    const b = dialogWindowBounds({ x: 500, y: 300, width: 700, height: 500 }, parent, workArea)
    expect(b).toEqual({ x: 500, y: 300, width: 700, height: 500 })
  })

  it('记录位置越界：整窗钳回工作区（拖到屏幕外的窗口不丢）', () => {
    // 右下角拖出屏幕（x=2000 远超 1440-920）
    const b = dialogWindowBounds({ x: 2000, y: 1200, width: 920, height: 672 }, parent, workArea)
    expect(b.x).toBe(workArea.x + workArea.width - 920)
    expect(b.y).toBe(workArea.y + workArea.height - 672)
  })

  it('记录尺寸小于最小值：抬到最小尺寸', () => {
    const b = dialogWindowBounds({ x: 0, y: 0, width: 100, height: 50 }, parent, workArea)
    expect(b.width).toBe(CARD_DIALOG_MIN.width)
    expect(b.height).toBe(CARD_DIALOG_MIN.height)
  })

  it('记录尺寸大于工作区：压回工作区尺寸', () => {
    const b = dialogWindowBounds({ x: 0, y: 0, width: 4000, height: 3000 }, parent, workArea)
    expect(b.width).toBe(workArea.width)
    expect(b.height).toBe(workArea.height)
  })

  it('x/y 缺一：视为无记录走居中（尺寸仍沿用）', () => {
    const b = dialogWindowBounds({ x: 100, y: null, width: 700, height: 500 }, parent, workArea)
    expect(b.width).toBe(700)
    expect(b.height).toBe(500)
    expect(b.x).toBe(100 + Math.round((1280 - 700) / 2))
    expect(b.y).toBe(50 + Math.round((840 - 500) / 3))
  })

  it('外接屏拔掉（工作区小于窗口）：钳回残余工作区，不出负屏', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 300 }
    const b = dialogWindowBounds({ x: 1500, y: 900, width: 920, height: 672 }, parent, tiny)
    expect(b.x).toBe(0)
    expect(b.y).toBe(0)
    expect(b.width).toBe(400)
    expect(b.height).toBe(300)
  })

  it('第二个显示器（负坐标屏）正常钳制', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    const b = dialogWindowBounds({ x: -9999, y: 0, width: 920, height: 672 }, parent, left)
    expect(b.x).toBe(left.x) // 钳回左屏左缘
    expect(b.y).toBe(0)
  })
})

describe('dialogToPayload', () => {
  it('add：保留 deckId，cardId 归一为 null', () => {
    expect(dialogToPayload({ mode: 'add', deckId: 'd1', cardId: null })).toEqual({
      mode: 'add',
      deckId: 'd1',
      cardId: null
    })
    expect(dialogToPayload({ mode: 'add', deckId: null, cardId: null })).toEqual({
      mode: 'add',
      deckId: null,
      cardId: null
    })
  })

  it('edit：只带 cardId，deckId 置 null（卡自带牌组）', () => {
    expect(dialogToPayload({ mode: 'edit', deckId: 'd1', cardId: 'c1' })).toEqual({
      mode: 'edit',
      deckId: null,
      cardId: 'c1'
    })
  })
})

describe('payloadToDialog（信任边界）', () => {
  it('合法 add / edit 载荷还原', () => {
    expect(payloadToDialog({ mode: 'add', deckId: 'd1', cardId: null })).toEqual({
      mode: 'add',
      deckId: 'd1',
      cardId: null
    })
    expect(payloadToDialog({ mode: 'edit', deckId: null, cardId: 'c1' })).toEqual({
      mode: 'edit',
      deckId: null,
      cardId: 'c1'
    })
  })

  it('非对象 / mode 非法 → null', () => {
    expect(payloadToDialog(null)).toBeNull()
    expect(payloadToDialog('add')).toBeNull()
    expect(payloadToDialog(42)).toBeNull()
    expect(payloadToDialog({})).toBeNull()
    expect(payloadToDialog({ mode: 'delete' })).toBeNull()
    expect(payloadToDialog({ mode: 1 })).toBeNull()
  })

  it('edit 无 cardId / 空 cardId → null（拒绝而非静默转 add）', () => {
    expect(payloadToDialog({ mode: 'edit', cardId: null })).toBeNull()
    expect(payloadToDialog({ mode: 'edit', cardId: '' })).toBeNull()
    expect(payloadToDialog({ mode: 'edit', cardId: 123 })).toBeNull()
  })

  it('add 载荷带脏 cardId：忽略之', () => {
    expect(payloadToDialog({ mode: 'add', deckId: 'd1', cardId: 'stale' })).toEqual({
      mode: 'add',
      deckId: 'd1',
      cardId: null
    })
  })

  it('deckId 非字符串/空串归一为 null', () => {
    expect(payloadToDialog({ mode: 'add', deckId: 42, cardId: null })).toEqual({
      mode: 'add',
      deckId: null,
      cardId: null
    })
    expect(payloadToDialog({ mode: 'add', deckId: '', cardId: null })).toEqual({
      mode: 'add',
      deckId: null,
      cardId: null
    })
  })
})
