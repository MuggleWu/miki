// 轻量二叉最小堆：牌组调度索引用（需求 §19 L1）
// key 主序（due/createdAt），tie 决胜——tie 按卡片插入序分配，保证同 key 时与全量遍历序一致。
export interface HeapEntry {
  key: number
  tie: number
  id: string
}

export class MinHeap {
  private a: HeapEntry[] = []

  get size(): number {
    return this.a.length
  }

  push(e: HeapEntry): void {
    const a = this.a
    a.push(e)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(a[i], a[p])) {
        ;[a[i], a[p]] = [a[p], a[i]]
        i = p
      } else break
    }
  }

  peek(): HeapEntry | undefined {
    return this.a[0]
  }

  pop(): HeapEntry | undefined {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l], a[m])) m = l
        if (r < a.length && this.less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }

  private less(x: HeapEntry, y: HeapEntry): boolean {
    return x.key < y.key || (x.key === y.key && x.tie < y.tie)
  }
}
