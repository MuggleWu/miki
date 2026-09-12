// 提示条（toast）怎么才能显示在弹层之上。
//
// 问题：新增卡片保存后不关抽屉（连续录入），而弹层用的是原生 `<dialog>.showModal()`——
// 它会把整个对话框提到**顶层**（top layer），页面里其余内容连同挂在 .app 下的 .toast
// 一起被它和 ::backdrop 盖住。用户看到输入框被清空了，但"已新增卡片"四个字在遮罩后面，
// 等于什么提示都没有——很容易被当成「没存上」再存一遍。
//
// 试过的两条路：
// ① 把提示条 DOM 挪进当前打开的 dialog（可行，但 React 不认账）：节点被搬走之后，
//    React 仍按"它还在 .toast-layer 下"去删它，卸载提示时抛
//    NotFoundError: Failed to execute 'removeChild' on 'Node'（真跑出来过，整棵树崩掉）。
//    凡是 React 渲染出来的节点，就不能在它背后搬家。
// ② 用 popover API（现在这条）：`<div popover="manual">` + showPopover() 同样进顶层，
//    而节点一动不动——React 只管渲染，进不进顶层由这一层说了算。
//    实测：modal dialog 开着时 showPopover() 生效，`matches(':popover-open')` 为真，
//    顶层顺序是 [dialog, popover]，提示画在对话框之上、位置按 fixed 跟随视口。
//    老 WebView 没有这个 API 时静默降级：提示条仍是个普通 fixed 元素，
//    只是弹层开着时会被遮住——退化成改动之前的观感，不会更差，也不会报错。
//
// 抽成纯函数是为了能在 node 里断言（工程没有 jsdom，也不为这一条引进来）。
/** 只用到这几个方法的元素替身，便于单测；真实元素天然满足 */
export interface ToastLike {
  matches(sel: string): boolean
  showPopover?: () => void
  hidePopover?: () => void
}

export function syncToastPopover(toast: ToastLike | null, visible: boolean): void {
  if (!toast) return
  // 不支持 popover 的老引擎：没有这两个方法，直接不接管（不能用 in 判 popover 属性，
  // 属性在所有元素上都能读到）
  if (typeof toast.showPopover !== 'function' || typeof toast.hidePopover !== 'function') return
  try {
    if (visible && !toast.matches(':popover-open')) toast.showPopover()
    if (!visible && toast.matches(':popover-open')) toast.hidePopover()
  } catch {
    // 已经在顶层（或正处于关闭动画）时浏览器会抛，这里没有需要补救的状态
  }
}
