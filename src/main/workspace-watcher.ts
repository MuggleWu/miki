// 工作区外部变更检测：轮询受管文件指纹（mtimeMs:size），发现外部写入后触发全量热加载。
// 这里只管「发现变化 + 冷却合并 + 自写豁免」；重载链经构造回调交回 WorkspaceService 执行
// （文件是唯一真理，内存态是运行时缓存——加载链要动服务层全部内存态，不外移）。
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkspacePaths } from './workspace-io'

/** 冷却窗口：git pull 大操作期间文件反复变化时合并触发，防重载风暴 */
const RELOAD_COOLDOWN_MS = 3000

export class WorkspaceWatcher {
  /** 受管文件上次快照（path → `${mtimeMs}:${size}`），始自 init/热加载 */
  private stamps = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private cbs: (() => void)[] = []
  private lastReloadAt = 0
  private reloadDirty = false

  constructor(
    private paths: WorkspacePaths,
    /** 检出外部变化后执行的全量重载链（服务层提供） */
    private reload: () => void
  ) {}

  /** 受管文件 = 数据真理层（decks/config/stats + cards/review-log 全部 *.ndjson）；.git/.miki 等派生物不参与 */
  private managedFiles(): string[] {
    const out: string[] = [this.paths.decksFile(), this.paths.statsFile(), this.paths.configJson()]
    const scan = (dir: string): void => {
      if (!fs.existsSync(dir)) return
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.ndjson')) out.push(path.join(dir, f))
      }
    }
    scan(path.join(this.paths.root, 'cards'))
    scan(path.join(this.paths.root, 'review-log'))
    return out
  }

  /** 文件指纹：`${mtimeMs}:${size}`；不存在返回 null（用于删文件检测） */
  private stampOf(p: string): string | null {
    try {
      const st = fs.statSync(p)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  private collectStamps(): Map<string, string> {
    const m = new Map<string, string>()
    for (const p of this.managedFiles()) {
      const s = this.stampOf(p)
      if (s !== null) m.set(p, s)
    }
    return m
  }

  /** 自写豁免：写路径完成后立即更新该文件快照，避免把自己的写入当外部变更 */
  noteWrite(file: string): void {
    const s = this.stampOf(file)
    if (s === null) this.stamps.delete(file)
    else this.stamps.set(file, s)
  }

  /** init 完成后建快照基线：后续轮询只认真外部变更，不把启动加载当变化（不动冷却起点） */
  initStamps(): void {
    this.stamps = this.collectStamps()
  }

  /** 热加载链完成后调用：重建基线（含本链自身的 config 写入）+ 起冷却窗 */
  rebase(): void {
    this.stamps = this.collectStamps()
    this.lastReloadAt = Date.now()
  }

  /** 注册外部变更回调（主进程把它转发给渲染进程刷新 UI） */
  onExternalChange(cb: () => void): void {
    this.cbs.push(cb)
  }

  /** 热加载完成后通知回调方（服务层 reloadFromDisk 末尾调用） */
  notify(): void {
    for (const cb of this.cbs) cb()
  }

  startWatching(intervalMs = 2000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.pollOnce(), intervalMs)
  }

  stopWatching(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 轮询一次：快照对比发现外部变化 → 热加载（冷却期内合并到下次）。测试直接调用。 */
  pollOnce(): void {
    const cur = this.collectStamps()
    let changed = cur.size !== this.stamps.size
    if (!changed) {
      for (const [p, s] of cur) {
        if (this.stamps.get(p) !== s) {
          changed = true
          break
        }
      }
    }
    if (!changed) return
    if (this.reloadDirty || Date.now() - this.lastReloadAt < RELOAD_COOLDOWN_MS) {
      this.reloadDirty = true
      return
    }
    this.reloadDirty = false
    this.reload()
  }
}
