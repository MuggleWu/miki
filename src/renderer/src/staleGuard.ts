// 异步竞态防护：请求可能因条件切换/定时刷新并发，旧响应晚到会覆盖新数据。
// 发请求前 next() 取序号（首个有效序号为 1，0 是「从未发起」哨兵），
// 响应回来 isLatest(seq) 不成立则丢弃本次结果。
export function createSeqGuard() {
  let seq = 0
  return {
    next: () => ++seq,
    isLatest: (s: number) => s !== 0 && s === seq
  }
}
