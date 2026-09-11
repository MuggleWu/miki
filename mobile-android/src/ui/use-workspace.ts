// 取工作区并订阅它的写操作计数。
//
// 为什么不用 useMemo 包派生数据：本应用的派生数据依赖**可变**的工作区对象，
// useMemo 的依赖数组表达不了「工作区内部变了」这件事——写 [ws] 只会拿到陈旧结果，
// 而那些「顺手把 version 也塞进依赖」的写法既会被 lint 判成多余依赖，也容易被下一个人
// 当成笔误删掉。
//
// 这里的取舍：每次渲染直接算。计算量是 O(牌组数) 量级（卡片计数由调度索引增量维护，
// 不是每次遍历全库），比维护一层失效逻辑便宜得多，也就不容易出错。
import { useApp } from './store'
import type { MobileWorkspace } from '@mobile/workspace'

export function useWorkspace(): MobileWorkspace {
  const ws = useApp((s) => s.ws)
  // 订阅写操作计数：它就是「工作区数据变了，请重算」的信号（值本身不用，渲染即目的）
  useApp((s) => s.version)
  if (!ws) throw new Error('工作区尚未就绪：useWorkspace 只能在 ws 非空后调用')
  return ws
}
