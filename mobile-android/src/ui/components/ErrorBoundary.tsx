// 页面级渲染错误边界：任一页面在渲染/生命周期里抛错，React 会卸载**整棵树**——手机上是
// 一片白屏，而且连同在这棵树里的「设备自检」都进不去，用户除了杀进程没有别的动作可做。
// 这里把错误挡在边界内，给出可读提示与「重试」（重试 = 把这一页重新挂载）。
//
// 必须是 class 组件：函数组件没有对应的钩子，这是 React 官方唯一还需要 class 的场景。
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 出错时额外做的清理（如让 store 重新取数）；抛错会被吞掉 */
  onError?: () => void
  /** 出错时显示的标题（按页面区分，便于用户描述问题） */
  label?: string
}

interface State {
  error: Error | null
  attempt: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留完整栈（含组件栈）：手机上没有别的现场，logcat 里那份 `[miki] 渲染错误`
    // 是唯一能定位到具体组件的线索（下面给用户看的那段是截断过的）。
    console.error('[miki] 渲染错误:', error, info.componentStack)
    try {
      this.props.onError?.()
    } catch {
      // 清理回调自身出错不能盖住原始错误
    }
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    if (!this.state.error) {
      // key 变化 = 子树整体重建（清掉可能已损坏的组件状态）
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
    }
    return (
      <div className="error-boundary">
        <div className="error-boundary-title">{this.props.label ?? '这个页面出错了'}</div>
        <div className="error-boundary-msg">{this.state.error.message || String(this.state.error)}</div>
        <div className="error-boundary-hint">
          数据已经落盘，不受影响。可以点「重试」重新打开这个页面；若反复出现，把下面这段信息发给我。
        </div>
        {/* 栈截断到 1200 字：手机上贴进聊天窗口的长度上限大概就这么长 */}
        <pre className="error-boundary-stack">{(this.state.error.stack ?? '').slice(0, 1200)}</pre>
        <button className="btn primary" onClick={this.retry}>
          重试
        </button>
      </div>
    )
  }
}
