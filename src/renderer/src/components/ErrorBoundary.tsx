// 渲染层错误边界：任一页面组件在渲染/生命周期里抛错，React 会卸载整棵树 → 窗口一片空白，
// 用户既不知道出了什么、也没法继续操作（只能重启）。这里把错误挡在边界内，
// 给出可读的提示与「重试」，并保留顶部导航（重试即重新挂载子树）。
//
// 必须是 class 组件：函数组件没有对应的钩子（React 官方唯一需要 class 的场景）。
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
    // 控制台留完整栈（含组件栈），便于开发期定位
    console.error('[miki] 渲染错误:', error, info.componentStack)
    try {
      this.props.onError?.()
    } catch {
      // 清理回调自身出错不能盖住原始错误
    }
  }

  private retry = () => {
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
          数据已经落盘，不受影响。可以点「重试」重新载入这个页面；若反复出现，请把下方信息连同 miki-error.log 一起反馈。
        </div>
        <pre className="error-boundary-stack">{(this.state.error.stack ?? '').slice(0, 1200)}</pre>
        <button className="primary" onClick={this.retry}>
          重试
        </button>
      </div>
    )
  }
}
