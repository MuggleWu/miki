// WorkspaceService：主进程唯一写入口（需求 NF1，技术栈 §2/§4）
// 内存态 = 启动时从工作区文件重放；所有写路径：先落盘（原子写/追加），后更新内存。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  type Card,
  type CardContent,
  type CardSnapshot,
  type Deck,
  type DeckCounts,
  type DeckInfo,
  type MikiConfig,
  type QueryParams,
  type QueryResult,
  type Rating,
  type ReviewEvent,
  type StatsParams,
  type StudyPayload,
  type UndoResult
} from '../shared/types'
import { FsrScheduler, DEFAULT_FSRS_PARAMS } from '../core/fsrs'
import { MinHeap, type HeapEntry } from '../core/min-heap'
import { applyEvent } from '../core/replay'
import { compareByKeys, displayState, filterByKeywords, toRow } from '../core/query'
import type { MikiConfigPatch } from '../shared/ipc'
import { bumpDailyAgg, computeStats, endOfLocalDay, localDateKey, type DailyAgg } from '../core/stats'

const MONTH_MS = 31 * 86_400_000

/** 牌组调度索引：due 最小堆 + 增量计数器，学习页/首页读 O(log n)（需求 §19 L1） */
interface DeckIndex {
  /** Learning/Relearning 态卡，key = due */
  learning: MinHeap
  /** Review 态卡，key = due */
  review: MinHeap
  /** 新卡，key = createdAt */
  fresh: MinHeap
  counts: {
    new: number
    learningAll: number
    learningDueToday: number
    reviewDueToday: number
  }
  /** 堆是否已构建：init/跨天重建只建计数器（首页/统计够用），堆推迟到首次取卡时全量构建 */
  built: boolean
}

function atomicWrite(file: string, data: string): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 压实后的卡片行 = 内容 + 调度检查点快照；旧格式行无 fsrs/reps/lapses 字段（视为零值 + 全量重放）。
 * __mikiSeq：该行调度快照已反映到的事件水位；缺省时回落到基文件 meta 的 __mikiCheckpoint */
interface CardCheckpointRow extends CardContent {
  fsrs?: CardSnapshot | null
  reps?: number
  lapses?: number
  __mikiSeq?: number
}

function readNdjson(file: string): string[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
}

export class WorkspaceService {
  root!: string
  config!: MikiConfig
  decks: Deck[] = []
  cards = new Map<string, Card>()
  /** 仅本会话事件（undo 查找用）；历史事件流式重放后不驻留（需求 §19 L1） */
  events: ReviewEvent[] = []
  private seq = 0
  private scheduler!: FsrScheduler
  /** 预览专用（无 fuzz），评级按钮的到期提示用它保证展示稳定 */
  private previewScheduler!: FsrScheduler
  /** 会话 undo 栈（D2：不跨会话） */
  private sessionOps: { seq: number; cardId: string }[] = []
  /** 热力图聚合（undo 已抵消）：deckId → 日期键 → 计数 */
  private dailyAgg: DailyAgg = new Map()
  /** 聚合检查点 seq（stats.json 已含该 seq 及之前的贡献） */
  private statsCheckpoint = 0
  /** 今日已答净计数（answer ++ / undo 抵消 -- / 跨天清零） */
  private todayAnswers = 0
  /** 牌组调度索引（deckId → 堆 + 计数器），跨天/启动全量重建，其余增量维护 */
  private idx = new Map<string, DeckIndex>()
  private indexDayKey = ''
  private orderCounter = 0
  /** 各牌组基文件检查点 seq（该 seq 及之前的事件已反映在快照行里） */
  private deckCheckpoints = new Map<string, number>()
  /** 各牌组 delta 行数（压实阈值触发） */
  private deltaCounts = new Map<string, number>()

  // ---------- 路径 ----------

  private decksFile(): string {
    return path.join(this.root, 'decks.json')
  }

  private deckCardsFile(deckId: string): string {
    return path.join(this.root, 'cards', `${deckId}.ndjson`)
  }

  private deckDeltaFile(deckId: string): string {
    return path.join(this.root, 'cards', `${deckId}.delta.ndjson`)
  }

  private statsFile(): string {
    return path.join(this.root, 'stats.json')
  }

  private logFile(t: number): string {
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, '0')
    return path.join(this.root, 'review-log', `${d.getFullYear()}-${p(d.getMonth() + 1)}.ndjson`)
  }

  // ---------- 加载 ----------

  init(root: string, overrides?: Partial<MikiConfig>): void {
    this.root = root
    fs.mkdirSync(path.join(this.root, 'cards'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'review-log'), { recursive: true })
    this.config = this.loadConfig(overrides)
    this.scheduler = this.buildScheduler(this.config)
    this.previewScheduler = this.buildScheduler(this.config, true)
    this.loadDecks()
    this.loadStatsCheckpoint()
    this.loadCardsWithCheckpoint()
    this.streamEvents()
    this.ensureDay()
    this.ensureGitignore()
  }

  private loadConfig(overrides?: Partial<MikiConfig>): MikiConfig {
    const file = path.join(this.root, 'config.json')
    let stored: Partial<MikiConfig> = {}
    if (fs.existsSync(file)) {
      try {
        stored = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch {
        stored = {}
      }
    }
    // study 嵌套字段单独合并，避免旧 config 整体覆盖默认值
    const study = { ...DEFAULT_CONFIG.study, ...(stored.study ?? {}) }
    const api = { ...DEFAULT_CONFIG.api, ...(stored.api ?? {}) }
    const config: MikiConfig = {
      ...DEFAULT_CONFIG,
      ...stored,
      ...overrides,
      study,
      api,
      workspacePath: this.root
    }
    // HTTP API 鉴权 token：首次启动生成一次，长期使用
    if (!config.api.token) config.api.token = randomUUID()
    atomicWrite(file, JSON.stringify(config, null, 2))
    // 老版本可能以默认 0644 落盘过（含 token），收敛到仅当前用户可读写
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // 平台不支持则跳过
    }
    return config
  }

  private buildScheduler(cfg: MikiConfig, noFuzz = false): FsrScheduler {
    return new FsrScheduler({
      parameters: cfg.parameters,
      desiredRetention: cfg.desiredRetention,
      learningStepsSec: cfg.learningStepsSec,
      relearningStepsSec: cfg.relearningStepsSec,
      maximumInterval: cfg.maximumInterval,
      enableFuzzing: noFuzz ? false : cfg.enableFuzzing
    })
  }

  /** 合并保存设置并落盘；study/browser 深合并（其余顶层替换）；调度相关字段变化时重建调度器 */
  saveConfig(patch: MikiConfigPatch): MikiConfig {
    const study = { ...this.config.study, ...(patch.study ?? {}) }
    const browser = { ...this.config.browser, ...(patch.browser ?? {}) }
    Object.assign(this.config, patch, { study, browser })
    const scheduleKeys: (keyof MikiConfig)[] = [
      'parameters',
      'desiredRetention',
      'learningStepsSec',
      'relearningStepsSec',
      'maximumInterval',
      'enableFuzzing'
    ]
    if (scheduleKeys.some((k) => k in patch)) {
      this.scheduler = this.buildScheduler(this.config)
      this.previewScheduler = this.buildScheduler(this.config, true)
    }
    atomicWrite(path.join(this.root, 'config.json'), JSON.stringify(this.config, null, 2))
    return this.config
  }

  private loadDecks(): void {
    if (fs.existsSync(this.decksFile())) {
      try {
        this.decks = JSON.parse(fs.readFileSync(this.decksFile(), 'utf-8'))
        return
      } catch {
        // 损坏则重建为空
      }
    }
    this.decks = []
    this.saveDecks()
  }

  private saveDecks(): void {
    atomicWrite(this.decksFile(), JSON.stringify(this.decks, null, 2))
  }

  /** 读统计聚合检查点（stats.json）；缺失/损坏 → 从头聚合（多读一遍事件，语义无损） */
  private loadStatsCheckpoint(): void {
    this.dailyAgg = new Map()
    this.statsCheckpoint = 0
    this.todayAnswers = 0
    const file = this.statsFile()
    if (!fs.existsSync(file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        checkpointSeq?: number
        dailyAgg?: [string, [string, { total: number; again: number }][]][]
      }
    this.statsCheckpoint = Number(raw.checkpointSeq) || 0
    for (const [deckId, days] of raw.dailyAgg ?? []) {
      this.dailyAgg.set(deckId, new Map(days))
    }
    // 今日净计数直接从聚合恢复（跨天由 ensureDay 清零）
    const tk = localDateKey(Date.now())
    let n = 0
    for (const m of this.dailyAgg.values()) n += m.get(tk)?.total ?? 0
    this.todayAnswers = n
  } catch {
      this.dailyAgg = new Map()
      this.statsCheckpoint = 0
    }
  }

  /** 读全部卡片：基文件（含检查点快照行）→ delta 覆盖/墓碑（行序=时序）→ 卡片内存态。
   * 每行跟踪 seq 水位：快照行自带 __mikiSeq，内容行继承基行水位，重放时按卡跳过水位前事件 */
  private loadCardsWithCheckpoint(): void {
    this.cards = new Map()
    this.deckCheckpoints = new Map()
    for (const deck of this.decks) {
      const rows = new Map<string, CardCheckpointRow>()
      let cp = 0
      for (const line of readNdjson(this.deckCardsFile(deck.id))) {
        let row: CardCheckpointRow
        try {
          row = JSON.parse(line) as CardCheckpointRow
        } catch {
          continue
        }
        if (row && typeof row === 'object' && '__mikiCheckpoint' in row) {
          cp = Number((row as { __mikiCheckpoint?: number }).__mikiCheckpoint) || 0
          continue
        }
        if (row && typeof row.id === 'string') {
          row.__mikiSeq ??= cp
          rows.set(row.id, row)
        }
      }
      for (const line of readNdjson(this.deckDeltaFile(deck.id))) {
        let row: (CardCheckpointRow & { __mikiTombstone?: boolean }) | null
        try {
          row = JSON.parse(line) as CardCheckpointRow & { __mikiTombstone?: boolean }
        } catch {
          continue
        }
        if (!row || typeof row.id !== 'string') continue
        if (row.__mikiTombstone) {
          rows.delete(row.id)
          continue
        }
        // move 快照行自带水位；内容变更行只承载内容，继承基行的调度快照与水位
        const prev = rows.get(row.id)
        if (row.__mikiSeq !== undefined) {
          // 水位已在行上
        } else if (prev) {
          if (row.fsrs === undefined) row.fsrs = prev.fsrs ? { ...prev.fsrs } : prev.fsrs
          if (row.reps === undefined) row.reps = prev.reps
          if (row.lapses === undefined) row.lapses = prev.lapses
          row.__mikiSeq = prev.__mikiSeq
        } else {
          row.__mikiSeq = cp
        }
        rows.set(row.id, row)
      }
      this.deckCheckpoints.set(deck.id, cp)
      for (const row of rows.values()) {
        // 行对象直接升级为卡（避免每卡再分配 content 中间对象与 fsrs 拷贝）
        const card = row as unknown as Card
        card.deckId = deck.id
        card.fsrs = row.fsrs ?? null
        card.reps = row.reps ?? 0
        card.lapses = row.lapses ?? 0
        card.seqApplied = row.__mikiSeq ?? cp
        delete (card as unknown as CardCheckpointRow).__mikiSeq
        this.cards.set(card.id, card)
      }
    }
  }

  /**
   * 流式重放 review-log（需求 §19 L1）：一次顺序读，双水位消费——
   * seq > 牌组检查点 → 应用到卡（检查点快照行已含之前效果）；
   * seq > 聚合检查点 → 计入热力图聚合与今日净计数。
   * 历史事件不驻留内存：undo 抵消目标靠最近事件窗口（undo 与 target 同会话，距离有限）；
   * 新版 undo 事件自带 targetAction/targetRating，窗口只是旧库兼容兜底。
   */
  private streamEvents(): void {
    const dir = path.join(this.root, 'review-log')
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()
      : []
    this.events = []
    this.seq = 0
    const todayKey = localDateKey(Date.now())
    const win = new Map<number, { action: ReviewEvent['action']; rating?: Rating; t: number; deckId: string }>()
    for (const f of files) {
      for (const line of readNdjson(path.join(dir, f))) {
        let ev: ReviewEvent
        try {
          ev = JSON.parse(line) as ReviewEvent
        } catch {
          continue
        }
        ev.seq = ++this.seq
        const card = this.cards.get(ev.cardId)
        const wEntry =
          ev.action === 'undo' && ev.targetSeq != null ? win.get(ev.targetSeq) ?? null : null
        if (card && ev.seq > (card.seqApplied ?? 0)) {
          const tgt = wEntry
            ? { action: wEntry.action, rating: wEntry.rating }
            : ev.targetAction
              ? { action: ev.targetAction, rating: ev.targetRating }
              : null
          applyEvent(card, ev, tgt)
          card.seqApplied = ev.seq
        }
        if (ev.seq > this.statsCheckpoint) {
          if (ev.action === 'answer') {
            bumpDailyAgg(this.dailyAgg, ev.deckId, ev.t, ev.rating, 1)
            if (localDateKey(ev.t) === todayKey) this.todayAnswers++
          } else if (ev.action === 'undo' && wEntry?.action === 'answer') {
            bumpDailyAgg(this.dailyAgg, wEntry.deckId, wEntry.t, wEntry.rating, -1)
            if (localDateKey(wEntry.t) === todayKey) this.todayAnswers--
          }
        }
        win.set(ev.seq, { action: ev.action, rating: ev.rating, t: ev.t, deckId: ev.deckId })
        if (win.size > 40_000) {
          let n = 20_000
          for (const k of win.keys()) {
            win.delete(k)
            if (--n === 0) break
          }
        }
      }
    }
  }

  private ensureGitignore(): void {
    const gitDir = path.join(this.root, '.git')
    if (!fs.existsSync(gitDir)) return
    const gi = path.join(this.root, '.gitignore')
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf-8') : ''
    if (!existing.split('\n').includes('.miki/')) {
      fs.appendFileSync(gi, (existing.endsWith('\n') || existing === '' ? '' : '\n') + '.miki/\n')
    }
  }

  // ---------- 调度索引（due 最小堆 + 增量计数器） ----------

  private deckIdx(deckId: string): DeckIndex {
    let x = this.idx.get(deckId)
    if (!x) {
      x = {
        learning: new MinHeap(),
        review: new MinHeap(),
        fresh: new MinHeap(),
        counts: { new: 0, learningAll: 0, learningDueToday: 0, reviewDueToday: 0 },
        built: false
      }
      this.idx.set(deckId, x)
    }
    return x
  }

  /** 跨天检测：日期变化时全量重建索引并清零今日计数（重建同时自愈任何计数漂移） */
  ensureDay(now = Date.now()): void {
    const k = localDateKey(now)
    if (k === this.indexDayKey) return
    const had = this.indexDayKey !== ''
    this.indexDayKey = k
    this.rebuildIndexes(now)
    if (had) this.todayAnswers = 0
  }

  private rebuildIndexes(now: number): void {
    const eot = endOfLocalDay(now)
    this.idx = new Map()
    const hidden = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    let tie = 0
    for (const c of this.cards.values()) {
      c.tie = tie++ // tie 全量分配（含排除卡），保持与 Map 插入序一致
      if (c.deletedAt || c.suspended || hidden.has(c.deckId)) continue
      this.classPush(c, this.deckIdx(c.deckId), eot)
    }
    this.orderCounter = tie
  }

  /** 按当前状态加计数 +（堆已构建时）入堆（调用方保证卡未删未暂停、牌组未删）；tie 取卡上分配好的插入序 */
  private classPush(c: Card, ix: DeckIndex, eot: number): void {
    if (c.tie == null) c.tie = ++this.orderCounter
    const st = displayState(c)
    if (st === 'new') {
      ix.counts.new++
      if (ix.built) ix.fresh.push({ key: c.createdAt, tie: c.tie, id: c.id })
      return
    }
    const due = c.fsrs!.due
    if (st === 'review') {
      if (due <= eot) ix.counts.reviewDueToday++
      if (ix.built) ix.review.push({ key: due, tie: c.tie, id: c.id })
      return
    }
    ix.counts.learningAll++
    if (due <= eot) ix.counts.learningDueToday++
    if (ix.built) ix.learning.push({ key: due, tie: c.tie, id: c.id })
  }

  /** 仅入堆不计数（ensureBuilt 专用，计数已就绪） */
  private pushOnly(c: Card, ix: DeckIndex): void {
    if (c.tie == null) c.tie = ++this.orderCounter
    const st = displayState(c)
    if (st === 'new') {
      ix.fresh.push({ key: c.createdAt, tie: c.tie, id: c.id })
      return
    }
    const due = c.fsrs!.due
    if (st === 'review') {
      ix.review.push({ key: due, tie: c.tie, id: c.id })
      return
    }
    ix.learning.push({ key: due, tie: c.tie, id: c.id })
  }

  /** 首次取卡前全量构建该牌组的堆（百万卡 init 只建计数器，首次进学习页才付建堆成本） */
  private ensureBuilt(deckId: string): DeckIndex {
    const ix = this.deckIdx(deckId)
    if (ix.built) return ix
    ix.built = true
    const hidden = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    for (const c of this.cards.values()) {
      if (c.deckId !== deckId || c.deletedAt || c.suspended || hidden.has(c.deckId)) continue
      if (c.tie == null) c.tie = ++this.orderCounter
      this.pushOnly(c, ix)
    }
    return ix
  }

  /** 按变更前状态减计数（堆条目不删，弹出时惰性失效） */
  private unclassCounts(before: Card, eot: number, deckId: string): void {
    if (before.deletedAt || before.suspended) return
    const ix = this.deckIdx(deckId)
    const st = displayState(before)
    if (st === 'new') {
      ix.counts.new--
      return
    }
    const due = before.fsrs!.due
    if (st === 'review') {
      if (due <= eot) ix.counts.reviewDueToday--
      return
    }
    ix.counts.learningAll--
    if (due <= eot) ix.counts.learningDueToday--
  }

  /** 任一状态变化点统一调用：减掉变更前贡献、按新状态重新入堆计数（deckIdBefore 供移动跨牌组扣减） */
  private reindexCard(card: Card, before: Card | null, deckIdBefore?: string): void {
    const now = Date.now()
    this.ensureDay(now)
    const eot = endOfLocalDay(now)
    if (before) this.unclassCounts(before, eot, deckIdBefore ?? before.deckId)
    const hidden = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    if (!card.deletedAt && !card.suspended && !hidden.has(card.deckId)) {
      this.classPush(card, this.deckIdx(card.deckId), eot)
    }
  }

  /** 取堆顶有效卡：跳过失效条目（已删/暂停/换牌组/due 已变），dueLimit 内未到期则返回 null。
   * 有效卡只 peek 不 pop——pickNext 是幂等读，条目在卡片状态变化后按 key 不匹配惰性失效。 */
  private heapNext(
    h: MinHeap,
    deckId: string,
    dueLimit: number | null,
    match: (c: Card, e: HeapEntry) => boolean
  ): Card | null {
    while (h.size > 0) {
      const e = h.peek() as HeapEntry
      const card = this.cards.get(e.id)
      if (!card || card.deletedAt || card.suspended || card.deckId !== deckId || !match(card, e)) {
        h.pop()
        continue
      }
      if (dueLimit != null && e.key > dueLimit) return null
      return card
    }
    return null
  }

  private pickNextIdx(deckId: string, now: number): Card | null {
    const ix = this.ensureBuilt(deckId)
    const learning = this.heapNext(ix.learning, deckId, now, (c, e) => !!c.fsrs && displayState(c) === 'learning' && c.fsrs!.due === e.key)
    if (learning) return learning
    // 刷完旧卡才能刷新卡：当日会到期的复习卡（含今日稍后到点）都先于新卡出
    const eot = endOfLocalDay(now)
    const review = this.heapNext(ix.review, deckId, eot, (c, e) => displayState(c) === 'review' && c.fsrs!.due === e.key)
    if (review) return review
    return this.heapNext(ix.fresh, deckId, null, (c, e) => !c.fsrs && c.createdAt === e.key)
  }

  private remainingOf(deckId: string): number {
    const ix = this.deckIdx(deckId)
    return ix.counts.new + ix.counts.learningDueToday + ix.counts.reviewDueToday
  }

  // ---------- 只读视图 ----------

  now(): number {
    return Date.now()
  }

  endOfToday(): number {
    return endOfLocalDay(Date.now())
  }

  deckInfos(): DeckInfo[] {
    this.ensureDay()
    return this.decks
      .filter((d) => !d.deletedAt)
      .map((d) => {
        const ix = this.deckIdx(d.id)
        const counts: DeckCounts = {
          new: ix.counts.new,
          learning: ix.counts.learningAll,
          review: ix.counts.reviewDueToday
        }
        return { ...d, counts: sortCounts(counts, Date.now()) }
      })
  }

  private todayStartMs(): number {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  todayCount(): number {
    this.ensureDay()
    return this.todayAnswers
  }

  // ---------- 牌组 ----------

  addDeck(name: string): Deck {
    const deck: Deck = { id: randomUUID(), name, order: this.decks.length, createdAt: Date.now(), deletedAt: null }
    this.decks.push(deck)
    this.saveDecks()
    return deck
  }

  renameDeck(id: string, name: string): Deck | null {
    const deck = this.decks.find((d) => d.id === id && !d.deletedAt)
    if (deck) {
      deck.name = name
      this.saveDecks()
    }
    return deck ?? null
  }

  deleteDeck(id: string): void {
    const deck = this.decks.find((d) => d.id === id && !d.deletedAt)
    if (deck) {
      deck.deletedAt = Date.now()
      this.saveDecks()
    }
  }

  // ---------- 卡片 ----------

  // ---------- 卡片文件写路径（追加 + 压实，需求 §19 L1） ----------

  private contentRow(c: Card): string {
    const { deckId: _d, fsrs: _f, reps: _r, lapses: _l, tie: _t, seqApplied: _s, ...content } = c
    return JSON.stringify(content)
  }

  private snapshotRow(c: Card): string {
    const { deckId: _d, tie: _t, seqApplied: _s, ...row } = c
    return JSON.stringify(row)
  }

  /** 新卡行追加到基文件尾（纯新增、无调度历史，不走全量重写） */
  private appendCardRows(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    fs.appendFileSync(this.deckCardsFile(deckId), cards.map((c) => this.contentRow(c)).join('\n') + '\n', 'utf-8')
  }

  /** 内容变更追加到 delta 文件（启动时覆盖基行并继承其调度快照） */
  private appendCardDelta(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    fs.appendFileSync(this.deckDeltaFile(deckId), cards.map((c) => this.contentRow(c)).join('\n') + '\n', 'utf-8')
    this.touchDelta(deckId)
  }

  /** 移入牌组：delta 追加带调度快照的完整行（目标可能没有该卡基行，快照须自带）；
   * __mikiSeq 记录快照水位，重放不再重复应用水位前事件 */
  private appendCardDeltaSnapshot(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    const lines = cards.map((c) => {
      const { deckId: _d, tie: _t, seqApplied: _s, ...row } = c
      return JSON.stringify({ __mikiSeq: this.seq, ...row })
    })
    fs.appendFileSync(this.deckDeltaFile(deckId), lines.join('\n') + '\n', 'utf-8')
    this.touchDelta(deckId)
  }

  /** 移出牌组的墓碑行（启动合并时删除对应基行；delta 内行序=时序，先移出后移回不会误删） */
  private appendCardTombstones(deckId: string, ids: string[]): void {
    if (ids.length === 0) return
    fs.appendFileSync(
      this.deckDeltaFile(deckId),
      ids.map((id) => JSON.stringify({ id, __mikiTombstone: true })).join('\n') + '\n',
      'utf-8'
    )
    this.touchDelta(deckId)
  }

  private touchDelta(deckId: string): void {
    const n = (this.deltaCounts.get(deckId) ?? 0) + 1
    this.deltaCounts.set(deckId, n)
    if (n > 2000) this.compactDeck(deckId)
  }

  /** 压实一个牌组：全量重写基文件（检查点 seq + 调度快照行）→ 清 delta → 落聚合检查点 */
  private compactDeck(deckId: string): void {
    const lines: string[] = [JSON.stringify({ __mikiCheckpoint: this.seq })]
    const rows: string[] = []
    for (const c of this.cards.values()) {
      if (c.deckId !== deckId) continue
      rows.push(this.snapshotRow(c))
    }
    rows.sort()
    atomicWrite(this.deckCardsFile(deckId), lines.join('\n') + '\n' + (rows.length ? rows.join('\n') + '\n' : ''))
    fs.rmSync(this.deckDeltaFile(deckId), { force: true })
    this.deltaCounts.set(deckId, 0)
    this.deckCheckpoints.set(deckId, this.seq)
    this.writeStatsCheckpoint()
  }

  /** 统计聚合检查点落盘（压实时调用，运行期不写避免高频重写） */
  private writeStatsCheckpoint(): void {
    const daily: [string, [string, { total: number; again: number }][]][] = [...this.dailyAgg].map(
      ([d, m]) => [d, [...m]]
    )
    atomicWrite(this.statsFile(), JSON.stringify({ checkpointSeq: this.seq, dailyAgg: daily }))
  }

  /** 手动全量压实（运维入口；把所有牌组基文件、调度快照与聚合检查点对齐到当前 seq） */
  compact(): void {
    for (const d of this.decks) this.compactDeck(d.id)
  }

  addCard(deckId: string, front: string, back: string): Card {
    const now = Date.now()
    const content: CardContent = {
      id: randomUUID(),
      front,
      back,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      suspended: false
    }
    const card: Card = { ...content, deckId, fsrs: null, reps: 0, lapses: 0 }
    this.cards.set(card.id, card)
    this.appendCardRows(deckId, [card])
    this.reindexCard(card, null)
    return card
  }

  /** 批量新增卡片：同批共用时间戳，一次落盘；不写调度事件（新卡无进度） */
  addCards(deckId: string, items: { front: string; back: string }[]): Card[] {
    if (items.length === 0) return []
    const now = Date.now()
    const cards: Card[] = items.map((it) => ({
      id: randomUUID(),
      deckId,
      front: it.front,
      back: it.back,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      suspended: false,
      fsrs: null,
      reps: 0,
      lapses: 0
    }))
    for (const c of cards) this.cards.set(c.id, c)
    this.appendCardRows(deckId, cards)
    for (const c of cards) this.reindexCard(c, null)
    return cards
  }

  /** 批量更新内容：delta 追加（O(变更)），按牌组分组一次落盘；返回更新数与不存在的 ID 数 */
  updateCards(items: { cardId: string; front: string; back: string }[]): { updated: number; missing: number } {
    const now = Date.now()
    let updated = 0
    let missing = 0
    const touched = new Map<string, Card[]>()
    for (const it of items) {
      const card = this.cards.get(it.cardId)
      if (!card || card.deletedAt) {
        missing++
        continue
      }
      card.front = it.front
      card.back = it.back
      card.updatedAt = now
      updated++
      const list = touched.get(card.deckId) ?? []
      list.push(card)
      touched.set(card.deckId, list)
    }
    for (const [deckId, cards] of touched) this.appendCardDelta(deckId, cards)
    return { updated, missing }
  }

  /** 批量软删：每张一个 delete 事件（可撤销），不重写卡片文件（重放恢复删除态） */
  deleteCards(cardIds: string[]): { deleted: number; missing: number } {
    const now = Date.now()
    const evs: ReviewEvent[] = []
    const touched: { card: Card; before: Card }[] = []
    let missing = 0
    for (const id of cardIds) {
      const card = this.cards.get(id)
      if (!card || card.deletedAt) {
        missing++
        continue
      }
      const before = { ...card }
      evs.push({ seq: ++this.seq, t: now, action: 'delete', cardId: id, deckId: card.deckId, before: card.fsrs })
      card.deletedAt = now
      touched.push({ card, before })
    }
    if (evs.length === 0) return { deleted: 0, missing }
    this.appendEvents(evs)
    for (const ev of evs) this.sessionOps.push({ seq: ev.seq, cardId: ev.cardId })
    for (const t of touched) this.reindexCard(t.card, t.before)
    return { deleted: evs.length, missing }
  }

  /** 批量按 ID 取卡片（保持入参顺序，跳过不存在的 ID） */
  getCards(cardIds: string[]): Card[] {
    const out: Card[] = []
    for (const id of cardIds) {
      const card = this.cards.get(id)
      if (card) out.push(card)
    }
    return out
  }

  updateCard(cardId: string, front: string, back: string): Card | null {
    const card = this.cards.get(cardId)
    if (!card) return null
    card.front = front
    card.back = back
    card.updatedAt = Date.now()
    this.appendCardDelta(card.deckId, [card])
    return card
  }

  /** 暂停/解除：追加 suspend 事件（不可撤销，不入会话撤销栈），不重写卡片文件 */
  setCardSuspended(cardId: string, suspended: boolean): Card | null {
    const card = this.cards.get(cardId)
    if (!card) return null
    if (card.suspended !== suspended) {
      const before = { ...card }
      const ev: ReviewEvent = {
        seq: ++this.seq,
        t: Date.now(),
        action: 'suspend',
        cardId: card.id,
        deckId: card.deckId,
        suspended
      }
      this.appendEvents([ev])
      card.suspended = suspended
      this.reindexCard(card, before)
    }
    return card
  }

  /** 批量移动卡片到目标牌组：deckId 是内容字段，保留调度进度，不进调度事件 */
  moveCards(cardIds: string[], targetDeckId: string): number {
    if (!this.decks.some((d) => d.id === targetDeckId && !d.deletedAt)) return 0
    const now = Date.now()
    const touched: { card: Card; before: Card }[] = []
    let moved = 0
    for (const id of cardIds) {
      const c = this.cards.get(id)
      if (!c || c.deletedAt || c.deckId === targetDeckId) continue
      const before = { ...c }
      c.deckId = targetDeckId
      c.updatedAt = now
      moved++
      touched.push({ card: c, before })
    }
    if (moved > 0) {
      // 目标牌组 delta 追加带快照完整行、源牌组追加墓碑——均 O(移动数)，无全量重写；
      // delta 内行序=操作时序，先移出后移回不会互相覆盖
      this.appendCardDeltaSnapshot(targetDeckId, touched.map((t) => t.card))
      const bySource = new Map<string, string[]>()
      for (const t of touched) {
        const list = bySource.get(t.before.deckId) ?? []
        list.push(t.card.id)
        bySource.set(t.before.deckId, list)
      }
      for (const [deckId, ids] of bySource) this.appendCardTombstones(deckId, ids)
      for (const t of touched) this.reindexCard(t.card, t.before, t.before.deckId)
    }
    return moved
  }

  /** 批量重置进度：调度/统计清零并解除暂停，变回新卡；追加 reset 事件（不可撤销） */
  resetProgress(cardIds: string[]): number {
    const now = Date.now()
    const evs: ReviewEvent[] = []
    const touched: { card: Card; before: Card }[] = []
    for (const id of cardIds) {
      const c = this.cards.get(id)
      if (!c || c.deletedAt) continue
      const before = { ...c }
      evs.push({
        seq: ++this.seq,
        t: now,
        action: 'reset',
        cardId: c.id,
        deckId: c.deckId,
        before: c.fsrs ? { ...c.fsrs } : null
      })
      c.fsrs = null
      c.reps = 0
      c.lapses = 0
      c.suspended = false
      c.updatedAt = now
      touched.push({ card: c, before })
    }
    if (evs.length === 0) return 0
    this.appendEvents(evs)
    // reset 不可撤销：把该卡的会话撤销栈一并作废
    const resetIds = new Set(evs.map((e) => e.cardId))
    this.sessionOps = this.sessionOps.filter((op) => !resetIds.has(op.cardId))
    for (const t of touched) this.reindexCard(t.card, t.before)
    return evs.length
  }

  private appendEvents(evs: ReviewEvent[]): void {
    const byFile = new Map<string, string[]>()
    for (const ev of evs) {
      const f = this.logFile(ev.t)
      const list = byFile.get(f) ?? []
      list.push(JSON.stringify(ev))
      byFile.set(f, list)
    }
    for (const [f, lines] of byFile) {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, lines.join('\n') + '\n', 'utf-8')
    }
    this.events.push(...evs)
  }

  deleteCard(cardId: string): void {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return
    const now = Date.now()
    const before = { ...card }
    const ev: ReviewEvent = { seq: ++this.seq, t: now, action: 'delete', cardId, deckId: card.deckId, before: card.fsrs }
    this.appendEvents([ev])
    card.deletedAt = now
    this.reindexCard(card, before)
    this.sessionOps.push({ seq: ev.seq, cardId })
  }

  // ---------- 学习 ----------

  private deckCards(deckId: string | null): Card[] {
    const out: Card[] = []
    const hidden = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    for (const c of this.cards.values()) {
      if (c.deletedAt || hidden.has(c.deckId)) continue
      if (deckId != null && c.deckId !== deckId) continue
      out.push(c)
    }
    return out
  }

  getStudy(deckId: string): StudyPayload {
    const now = Date.now()
    this.ensureDay(now)
    return {
      card: this.pickNextIdx(deckId, now),
      remaining: this.remainingOf(deckId),
      todayCount: this.todayCount()
    }
  }

  answer(cardId: string, rating: Rating, durationMs?: number): StudyPayload & { answeredCardId: string } {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) throw new Error(`card not found: ${cardId}`)
    const now = Date.now()
    const before = { ...card }
    const beforeFsrs = card.fsrs
    const after = this.scheduler.review(beforeFsrs, rating, now)
    const ev: ReviewEvent = { seq: ++this.seq, t: now, action: 'answer', cardId, deckId: card.deckId, rating, before: beforeFsrs, after, durationMs }
    const evs: ReviewEvent[] = [ev]
    card.fsrs = after
    card.reps++
    if (rating === 1) card.lapses++
    // leech：累计重来次数达到阈值（>0 时启用）自动暂停，不再进入调度；同样走 suspend 事件
    if (this.config.leechThreshold > 0 && !card.suspended && card.lapses >= this.config.leechThreshold) {
      card.suspended = true
      evs.push({ seq: ++this.seq, t: now, action: 'suspend', cardId: card.id, deckId: card.deckId, suspended: true })
    }
    this.appendEvents(evs)
    bumpDailyAgg(this.dailyAgg, card.deckId, ev.t, rating, 1)
    this.todayAnswers++
    this.reindexCard(card, before)
    this.sessionOps.push({ seq: ev.seq, cardId })
    return { answeredCardId: cardId, ...this.getStudy(card.deckId) }
  }

  /** 四档评级各自的下次到期预览（不落盘；关闭 fuzz 保证展示稳定） */
  previewIntervals(cardId: string): number[] {
    const card = this.cards.get(cardId)
    if (!card) return [0, 0, 0, 0]
    const now = Date.now()
    return ([1, 2, 3, 4] as Rating[]).map((r) => this.previewScheduler.review(card.fsrs, r, now).due)
  }

  undo(): UndoResult {
    const op = this.sessionOps.pop()
    if (!op) {
      return { restoredCardId: null, card: null, remaining: 0, todayCount: this.todayCount() }
    }
    const target = this.events.find((e) => e.seq === op.seq)
    if (!target) throw new Error(`session event missing: ${op.seq}`)
    const card = this.cards.get(op.cardId)
    if (!card) throw new Error(`card missing: ${op.cardId}`)
    const now = Date.now()
    const before = { ...card }
    const ev: ReviewEvent = {
      seq: ++this.seq,
      t: now,
      action: 'undo',
      cardId: card.id,
      deckId: card.deckId,
      targetSeq: target.seq,
      targetAction: target.action,
      targetRating: target.rating,
      before: target.before ?? null
    }
    this.appendEvents([ev])
    // 内存恢复：answer 撤销 → 回到 before（新卡回 new）并回退 reps/lapses（与 replay 抵消语义一致）；
    // delete 撤销 → 取消软删
    card.fsrs = ev.before ? { ...ev.before } : target.action === 'answer' ? null : card.fsrs
    if (target.action === 'answer') {
      card.reps = Math.max(0, card.reps - 1)
      if (target.rating === 1) card.lapses = Math.max(0, card.lapses - 1)
      bumpDailyAgg(this.dailyAgg, target.deckId, target.t, target.rating, -1)
      if (target.t >= this.todayStartMs()) this.todayAnswers--
    }
    if (target.action === 'delete') card.deletedAt = null
    this.reindexCard(card, before)
    return {
      restoredCardId: card.id,
      card,
      remaining: this.remainingOf(card.deckId),
      todayCount: this.todayCount()
    }
  }

  // ---------- 卡片库 ----------

  queryCards(params: QueryParams): QueryResult {
    const nameById = new Map(this.decks.map((d) => [d.id, d.name]))
    let list = this.deckCards(params.deckId)
    list = filterByKeywords(list, params.keywords)
    if (params.state) {
      list = list.filter((c) => {
        if (params.state === 'suspended') return c.suspended
        return !c.suspended && displayState(c) === params.state
      })
    }
    if (params.dueAfter != null) list = list.filter((c) => c.fsrs != null && c.fsrs.due >= params.dueAfter!)
    if (params.dueBefore != null) list = list.filter((c) => c.fsrs != null && c.fsrs.due <= params.dueBefore!)
    const deckNameOf = (c: Card) => nameById.get(c.deckId) ?? ''
    list = [...list].sort((a, b) => compareByKeys(a, b, params.sort, deckNameOf))
    const offset = params.offset ?? 0
    return {
      rows: list.slice(offset, offset + (params.limit ?? 5000)).map((c) => toRow(c, deckNameOf(c))),
      total: list.length
    }
  }

  getCard(cardId: string): Card | null {
    return this.cards.get(cardId) ?? null
  }

  // ---------- 统计 ----------

  getStats(params: StatsParams) {
    return computeStats({
      cards: [...this.cards.values()],
      dailyAgg: this.dailyAgg,
      deckId: params.deckId,
      range: params.range,
      now: Date.now()
    })
  }
}

function sortCounts(c: DeckCounts, _now: number): DeckCounts {
  return c
}

// 抑制未使用告警（MONTH_MS 预留给日志切月策略）
void MONTH_MS
