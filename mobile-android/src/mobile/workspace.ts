// 移动版工作区：语义对齐桌面端 src/main/workspace.ts，IO 全部换成异步 FileStore。
//
// 复用边界（设计文档「复用边界」节）：core 的 FSRS/重放/队列/查询/统计原样复用，
// shared 的 scheduling 索引、会话日志、行序列化原样复用；本文件是移动端**唯一**的状态
// 所有者与唯一写入口，负责把「读文件 → 重放 → 内存态」与「改内存 → 追加落盘」这两条链
// 接起来。
//
// 与桌面端的**有意差异**（设计决策 5：移动端 v1 只追加、不压实）：
// - 不压实：不重写卡片基文件、不删 delta、不写 __mikiCheckpoint 元行（这些留给桌面端）
// - 不读不写 stats.json：统计数据直接从 review-log 全量聚合（几百行到几万行都可忽略）
// - 不写 config.json：学习参数只读展示；本机偏好（主题/字号/同步配置）走 Capacitor Preferences
// - 不做 2 秒轮询：工作区是本 App 独占的私有目录，唯一的外部变更来源是同步拉取，
//   由回前台时的一次全量 reload() 覆盖（见 api.ts）
//
// 写路径只有三种，全部是追加（错的就会污染跨机数据，见设计文档「数据契约」）：
//   答题/撤销/删除/暂停/重置 → review-log/<当月>.ndjson 追加一行
//   编辑已有卡片              → cards/<deck>.delta.ndjson 追加一行全量内容
//   新增卡片                  → cards/<deck>.ndjson 追加一行内容
import {
  DEFAULT_CONFIG,
  type Card,
  type CardContent,
  type Deck,
  type DeckInfo,
  type DeckTableCounts,
  type MikiConfig,
  type QueryParams,
  type QueryResult,
  type Rating,
  type ReviewEvent,
  type StatsParams,
  type StatsPayload,
  type StudyPayload,
  type UndoResult
} from '@shared/types'
import {
  contentRow,
  iterateNdjsonText,
  newLoadIssues,
  noteDamaged,
  type CardCheckpointRow,
  type LoadIssues
} from '@shared/workspace-io'
import { ScheduleIndex } from '@shared/schedule-index'
import { SessionLog } from '@shared/session-log'
import { FsrScheduler } from '@core/fsrs'
import { applyEvent } from '@core/replay'
import { filterCards, sortByKeys, toRow } from '@core/query'
import { bumpDailyAgg, computeStats, endOfLocalDay, localDateKey, statsCacheKey, type DailyAgg } from '@core/stats'
import { readTexts, type FileStore } from './fs'
import type { MobilePaths } from './paths'

/** WebView 里的 UUID（crypto.randomUUID 在 https 与 localhost 下可用；Capacitor 默认 androidScheme=https） */
function newId(): string {
  return globalThis.crypto.randomUUID()
}

/** 取路径最后一段：与目录列举结果（只有文件名）比对时用 */
function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/**
 * 牌组按名称排序，与桌面端 `sortedDecks` 完全一致（`localeCompare` 带 `zh` 与 `numeric`）。
 *
 * 为什么必须一样：牌组文件的顺序是"创建/落盘顺序"，两端各自用它就会排出两个不一样的列表，
 * 同一个牌组在手机和电脑上位置不同，看着像两套数据。`numeric` 是为了「第 2 章」排在
 * 「第 10 章」前面——键盘/拼音顺序下 10 会跑到 2 前面。
 */
export function sortDecksByName<T extends { name: string }>(decks: T[]): T[] {
  return [...decks].sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }))
}

/** 一次全量加载的分段耗时（毫秒） */
export interface LoadTiming {
  config: number
  decks: number
  cards: number
  /** 「卡片」那一段里"读文件"占的比重（诊断用：剩下的是解析与建索引） */
  cardsRead: number
  events: number
  index: number
  total: number
  eventCount: number
}

const now = (): number => Math.round(performance.now())

export class MobileWorkspace {
  config!: MikiConfig
  decks: Deck[] = []
  cards = new Map<string, Card>()

  /** 仅本会话事件（撤销栈 / seq 水位），历史事件流式重放后不驻留 */
  private session = new SessionLog()
  private scheduler!: FsrScheduler
  /** 预览专用（关 fuzz）：评级按钮的下次间隔提示要稳定 */
  private previewScheduler!: FsrScheduler
  private sched!: ScheduleIndex
  private byDeck = new Map<string, Card[]>()
  private lowerCache = new Map<string, [string, string]>()
  /** 各牌组基文件检查点水位（该 seq 及之前的事件已反映在快照行里） */
  private deckCheckpoints = new Map<string, number>()
  private hiddenCache: Set<string> | null = null
  private loadIssues: LoadIssues = newLoadIssues()
  /** 最近一次全量加载的分段耗时（启动速度的观测口） */
  private loadTiming: LoadTiming | null = null

  // 统计聚合（对应桌面端 StatsLedger 的运行期部分，没有 stats.json 检查点与落盘）
  private dailyAgg: DailyAgg = new Map()
  private todayAnswers = 0
  private totalAnsweredCount = 0
  private statsCache = new Map<string, StatsPayload>()

  constructor(
    private readonly store: FileStore,
    private readonly paths: MobilePaths
  ) {}

  // ---------- 加载 ----------

  async init(): Promise<void> {
    // 调度索引必须在加载链之前接好宿主回调：它按需向宿主取「当前」的 cards/byDeck 实例，
    // 而加载链会整体替换这两个 Map（重载同理），所以只能传 getter 不能传快照引用
    this.sched = new ScheduleIndex({
      cards: () => this.cards,
      bucket: (deckId) => this.byDeck.get(deckId),
      hiddenDeckIds: () => this.hiddenDeckIds(),
      onDayRollover: () => {
        // 会话内跨天：今日计数清零（累计数与聚合不变）；重导在 ensureDay 里做
        this.todayAnswers = 0
      }
    })
    await this.store.mkdir(this.paths.cardsDir())
    await this.store.mkdir(this.paths.logDir())
    await this.loadAll()
  }

  /** 全量重载（回前台同步拉取后调用）：与启动加载链逐段同语义——文件是唯一真理，内存态是缓存 */
  async reload(): Promise<void> {
    await this.loadAll()
  }

  private async loadAll(): Promise<void> {
    // 逐段计时：手机上"启动慢"只可能慢在这四段里，不把数字打出来就只能靠猜
    const t0 = now()
    this.config = await this.loadConfig()
    this.scheduler = this.buildScheduler(this.config)
    this.previewScheduler = this.buildScheduler(this.config, true)
    const t1 = now()
    await this.loadDecks()
    const t2 = now()
    this.loadIssues = newLoadIssues()
    const cardsRead = await this.loadCardsWithCheckpoint(this.loadIssues)
    const t3 = now()
    const events = await this.streamEvents(this.loadIssues)
    const t4 = now()
    // 跨天检测：首次调用即全量建索引（tie 分配 + 各牌组计数）
    this.sched.ensureDay()
    // 重载时必须**强制**全量重建，不能只靠 ensureDay 的跨天语义：
    // 同一天里第二次加载时 ensureDay 会直接早退，而卡对象与卡桶已经整体换新，
    // 索引计数器会保留上一次的旧值（表现：同步拉取后/回前台重载后，牌组列表的
    // 「新」与「总数」显示 0，而「待复习」因为走的是现场扫桶路径仍然正确）。
    // 桌面端 reloadFromDisk 末尾同样有这一步，这里是把它对齐过来。
    this.sched.forceRebuild(localDateKey(Date.now()), Date.now())
    const t5 = now()
    this.loadTiming = {
      config: t1 - t0,
      decks: t2 - t1,
      cards: t3 - t2,
      cardsRead,
      events: t4 - t3,
      index: t5 - t4,
      total: t5 - t0,
      eventCount: events
    }
    const liveDecks = this.decks.filter((d) => !d.deletedAt).length
    console.log(
      `[miki-load] 合计 ${this.loadTiming.total}ms` +
        `（config ${this.loadTiming.config} / 牌组 ${this.loadTiming.decks} / 卡片 ${this.loadTiming.cards}` +
        `（其中读文件 ${cardsRead}）` +
        ` / 重放 ${this.loadTiming.events}（${events} 条事件）/ 建索引 ${this.loadTiming.index}）` +
        // 计数一起打出来：排查"读到的和桌面端不一样"时不必翻 UI，
        // 也让真机上的对账可以直接读 logcat（不必截图，卡片内容不会外泄）
        `｜活牌组 ${liveDecks} / 内存卡片 ${this.cards.size} / 事件 ${events}`
    )
  }

  /** 最近一次加载的分段耗时；自检页与设置页用它显示"启动都花在哪了" */
  loadTimingReport(): LoadTiming | null {
    return this.loadTiming
  }

  /** 读 config.json 并补齐默认值。移动端**不写回**这个文件（机器本地字段由桌面端管） */
  private async loadConfig(): Promise<MikiConfig> {
    const raw = await this.store.readText(this.paths.configFile())
    let stored: Partial<MikiConfig> = {}
    if (raw !== null) {
      try {
        stored = JSON.parse(raw) as Partial<MikiConfig>
      } catch {
        stored = {}
      }
    }
    const study = { ...DEFAULT_CONFIG.study, ...(stored.study ?? {}) }
    const api = { ...DEFAULT_CONFIG.api, ...(stored.api ?? {}) }
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      study,
      api,
      // 工作区路径是「本机的」，以移动端实际落的目录为准，不采信文件里的 mac 路径
      workspacePath: this.paths.root
    }
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

  private async loadDecks(): Promise<void> {
    this.hiddenCache = null
    const raw = await this.store.readText(this.paths.decksFile())
    if (raw === null) {
      this.decks = []
      return
    }
    try {
      this.decks = JSON.parse(raw) as Deck[]
    } catch {
      this.decks = []
    }
  }

  /** 读全部卡片：基文件（含检查点快照行）→ delta 覆盖/墓碑（行序=时序）→ 卡片内存态。
   *  返回"读文件"那部分的毫秒数，用来区分耗时是 IO 还是解析。 */
  private async loadCardsWithCheckpoint(issues: LoadIssues): Promise<number> {
    this.cards = new Map()
    this.deckCheckpoints = new Map()
    this.byDeck = new Map()
    this.lowerCache = new Map()
    // 先把所有卡片文件并发读回来再解析。这里的开销几乎全在**调用次数**上：
    // 读一个 2MB 的文件只要 66ms（探针 2），而每次跨桥调用有约 4ms 固定成本。
    // 所以先 list 一次目录、只对真实存在的文件发起读取——delta 文件通常不存在，
    // 200 个牌组就是 200 次白读，而且走的是异常路径（更慢）。
    const present = new Set((await this.store.list(this.paths.cardsDir())).map((e) => e.name))
    const filePaths: string[] = []
    for (const deck of this.decks) {
      const base = this.paths.deckCardsFile(deck.id)
      const delta = this.paths.deckDeltaFile(deck.id)
      if (present.has(baseNameOf(base))) filePaths.push(base)
      if (present.has(baseNameOf(delta))) filePaths.push(delta)
    }
    const readStart = now()
    const texts = await readTexts(this.store, filePaths)
    const readMs = now() - readStart

    for (const deck of this.decks) {
      const rows = new Map<string, CardCheckpointRow>()
      let cp = 0
      const baseFile = this.paths.deckCardsFile(deck.id)
      const baseText = texts.get(baseFile) ?? null
      if (baseText !== null) {
        for (const line of iterateNdjsonText(baseText, baseFile, issues)) {
          let row: CardCheckpointRow
          try {
            row = JSON.parse(line) as CardCheckpointRow
          } catch {
            noteDamaged(issues, baseFile)
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
      }

      const deltaFile = this.paths.deckDeltaFile(deck.id)
      const deltaText = texts.get(deltaFile) ?? null
      if (deltaText !== null) {
        for (const line of iterateNdjsonText(deltaText, deltaFile, issues)) {
          let row: (CardCheckpointRow & { __mikiTombstone?: boolean }) | null
          try {
            row = JSON.parse(line) as CardCheckpointRow & { __mikiTombstone?: boolean }
          } catch {
            noteDamaged(issues, deltaFile)
            continue
          }
          if (!row || typeof row.id !== 'string') continue
          if (row.__mikiTombstone) {
            rows.delete(row.id)
            continue
          }
          // 带水位的行（跨牌组移入的快照行）自带调度状态；内容变更行继承基行的快照与水位
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
      }

      this.deckCheckpoints.set(deck.id, cp)
      for (const row of rows.values()) {
        const card = row as unknown as Card
        card.deckId = deck.id
        card.fsrs = row.fsrs ?? null
        card.reps = row.reps ?? 0
        card.lapses = row.lapses ?? 0
        card.seqApplied = row.__mikiSeq ?? cp
        delete (card as unknown as CardCheckpointRow).__mikiSeq
        this.cards.set(card.id, card)
        this.deckBucket(deck.id).push(card)
      }
    }
    return readMs
  }

  /**
   * 流式重放 review-log（按月文件排序 = 时序）：一次顺序读，双水位消费。
   * 与桌面端的差异：移动端没有 stats.json 检查点，聚合水位恒为 0 → 每个 answer 都计入。
   * seq 不持久（文件里那个字段被丢弃、按「文件名序 + 行序」重派），跨机合并的正确性来自
   * 文件内行序，不来自 seq 值。
   */
  private async streamEvents(issues: LoadIssues): Promise<number> {
    let eventCount = 0
    this.session = new SessionLog()
    this.dailyAgg = new Map()
    this.todayAnswers = 0
    this.totalAnsweredCount = 0
    this.statsCache = new Map()

    const entries = await this.store.list(this.paths.logDir())
    const files = entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.ndjson'))
      .map((e) => e.name)
      .sort()

    const win = new Map<
      number,
      { action: ReviewEvent['action']; rating?: Rating; t: number; deckId: string; durationMs?: number }
    >()
    for (const f of files) {
      const file = `${this.paths.logDir()}/${f}`
      const text = await this.store.readText(file)
      if (text === null) continue
      for (const line of iterateNdjsonText(text, file, issues)) {
        let ev: ReviewEvent
        try {
          ev = JSON.parse(line) as ReviewEvent
        } catch {
          noteDamaged(issues, file)
          continue
        }
        ev.seq = this.session.nextSeq()
        eventCount++
        const card = this.cards.get(ev.cardId)
        const wEntry = ev.action === 'undo' && ev.targetSeq != null ? (win.get(ev.targetSeq) ?? null) : null
        if (card && ev.seq > (card.seqApplied ?? 0)) {
          const tgt = wEntry
            ? { action: wEntry.action, rating: wEntry.rating }
            : ev.targetAction
              ? { action: ev.targetAction, rating: ev.targetRating }
              : null
          applyEvent(card, ev, tgt)
          card.seqApplied = ev.seq
        }
        if (ev.action === 'answer') {
          this.recordAnswer(ev.deckId, ev.t, ev.rating, ev.durationMs)
        } else if (ev.action === 'undo' && wEntry?.action === 'answer') {
          this.undoAnswer(wEntry.deckId, wEntry.t, wEntry.rating, wEntry.durationMs)
        }
        win.set(ev.seq, { action: ev.action, rating: ev.rating, t: ev.t, deckId: ev.deckId, durationMs: ev.durationMs })
        // 窗口外 undo 在重放侧丢失聚合抵消（统计差 1）。上限只约束重放瞬时内存
        if (win.size > 200_000) {
          let n = 100_000
          for (const k of win.keys()) {
            win.delete(k)
            if (--n === 0) break
          }
        }
      }
    }
    return eventCount
  }

  // ---------- 统计聚合（对应桌面端 StatsLedger 的运行期语义） ----------

  private recordAnswer(deckId: string, t: number, rating: Rating | undefined, durationMs?: number): void {
    bumpDailyAgg(this.dailyAgg, deckId, t, rating, 1, durationMs)
    if (localDateKey(t) === localDateKey(Date.now())) this.todayAnswers++
    this.totalAnsweredCount++
  }

  private undoAnswer(deckId: string, t: number, rating: Rating | undefined, durationMs?: number): void {
    bumpDailyAgg(this.dailyAgg, deckId, t, rating, -1, durationMs)
    if (t >= this.todayStartMs()) this.todayAnswers--
    this.totalAnsweredCount--
  }

  /** 今日计数按聚合重导（聚合已含 undo 抵消），跨天时由 ensureDay 触发重建 */
  private reresolveToday(): void {
    const tk = localDateKey(Date.now())
    let today = 0
    for (const m of this.dailyAgg.values()) today += m.get(tk)?.total ?? 0
    this.todayAnswers = today
  }

  // ---------- 缓存/分桶 ----------

  private hiddenDeckIds(): Set<string> {
    if (this.hiddenCache === null) {
      this.hiddenCache = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    }
    return this.hiddenCache
  }

  private lowerTextOf(c: Card): [string, string] {
    let hit = this.lowerCache.get(c.id)
    if (hit === undefined) {
      hit = [c.front.toLowerCase(), c.back.toLowerCase()]
      this.lowerCache.set(c.id, hit)
    }
    return hit
  }

  private deckBucket(deckId: string): Card[] {
    let b = this.byDeck.get(deckId)
    if (!b) {
      b = []
      this.byDeck.set(deckId, b)
    }
    return b
  }

  private todayStartMs(): number {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  // ---------- 只读视图 ----------

  /** 跨天检测：日期翻页时重建索引并重导今日计数（重建同时自愈计数漂移） */
  ensureDay(now = Date.now()): void {
    this.sched.ensureDay(now)
    this.reresolveToday()
  }

  endOfToday(): number {
    return endOfLocalDay(Date.now())
  }

  deckInfos(): DeckInfo[] {
    this.ensureDay()
    const active = this.decks.filter((d) => !d.deletedAt)
    const counts = this.sched.deckCounts(
      active.map((d) => d.id),
      Date.now()
    )
    return sortDecksByName(
      active.map((d) => {
        const c = counts.get(d.id) ?? { total: 0, new: 0, due: 0 }
        const deckCounts: DeckTableCounts = { total: c.total, new: c.new, due: c.due }
        return { ...d, counts: deckCounts }
      })
    )
  }

  todayCount(): number {
    this.ensureDay()
    return this.todayAnswers
  }

  totalAnswered(): number {
    return this.totalAnsweredCount
  }

  /** 卡片总量（设置页与自检显示用） */
  cardCount(): number {
    return this.cards.size
  }

  /** 本会话还能撤销几步（撤销按钮的可用态；重启后为 0，这是有意的） */
  undoableCount(): number {
    return this.session.undoableCount
  }

  deckNameOf(deckId: string): string {
    return this.decks.find((d) => d.id === deckId)?.name ?? ''
  }

  deckExists(id: string): boolean {
    return this.decks.some((d) => d.id === id && !d.deletedAt)
  }

  /** 加载期数据损坏摘要（坏行被静默跳过时给用户一个可见出口） */
  damageReport(): { damagedLines: number; truncatedFiles: string[]; files: string[] } {
    const prefix = `${this.paths.root}/`
    const rel = (p: string): string => (p.startsWith(prefix) ? p.slice(prefix.length) : p)
    return {
      damagedLines: [...this.loadIssues.damaged.values()].reduce((a, b) => a + b, 0),
      truncatedFiles: [...this.loadIssues.truncated].map(rel),
      files: [...this.loadIssues.damaged.keys()].map(rel).slice(0, 5)
    }
  }

  getCard(cardId: string): Card | null {
    return this.cards.get(cardId) ?? null
  }

  // ---------- 牌组 ----------

  /** 新增牌组：decks.json 是全量数组（无追加语义），整份重写；移动端不做重命名/删除 */
  async addDeck(name: string): Promise<Deck> {
    const deck: Deck = { id: newId(), name, order: this.decks.length, createdAt: Date.now(), deletedAt: null }
    this.decks.push(deck)
    await this.saveDecks()
    return deck
  }

  private async saveDecks(): Promise<void> {
    await this.store.writeText(this.paths.decksFile(), JSON.stringify(this.decks, null, 2))
  }

  // ---------- 卡片写路径 ----------

  /** 新卡行追加到基文件尾（纯新增、无调度历史） */
  private async appendCardRows(deckId: string, cards: Card[]): Promise<void> {
    if (cards.length === 0) return
    await this.store.appendText(this.paths.deckCardsFile(deckId), cards.map((c) => contentRow(c)).join('\n') + '\n')
  }

  /** 内容变更追加到 delta（启动合并时覆盖基行并继承其调度快照）。
   * 关键：行里**不带 __mikiSeq**，继承基行水位——与桌面端 appendCardDelta 一致 */
  private async appendCardDelta(deckId: string, cards: Card[]): Promise<void> {
    if (cards.length === 0) return
    await this.store.appendText(this.paths.deckDeltaFile(deckId), cards.map((c) => contentRow(c)).join('\n') + '\n')
  }

  async addCard(deckId: string, front: string, back: string): Promise<Card> {
    const now = Date.now()
    const content: CardContent = {
      id: newId(),
      front,
      back,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      suspended: false
    }
    const card: Card = { ...content, deckId, fsrs: null, reps: 0, lapses: 0 }
    this.cards.set(card.id, card)
    this.deckBucket(deckId).push(card)
    await this.appendCardRows(deckId, [card])
    this.sched.reindexCard(card, null)
    this.statsCache.clear()
    return card
  }

  /** 单卡改内容：未提供的字段保留原值；软删卡拒改；空 patch 为 no-op（不写盘） */
  async updateCard(cardId: string, patch: { front?: string; back?: string }): Promise<Card | null> {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return null
    if (patch.front === undefined && patch.back === undefined) return card
    if (patch.front !== undefined) card.front = patch.front
    if (patch.back !== undefined) card.back = patch.back
    this.lowerCache.delete(cardId)
    // 严格单调：updatedAt 同时是内容版本号（乐观锁基准），同毫秒两次写入不能被误判成「没变」
    card.updatedAt = Math.max(Date.now(), card.updatedAt + 1)
    await this.appendCardDelta(card.deckId, [card])
    return card
  }

  /** 乐观锁版改卡：调用方持有的 updatedAt 对不上即报冲突且**不写盘**（与桌面端同语义） */
  async updateCardChecked(
    cardId: string,
    patch: { front?: string; back?: string },
    expectedUpdatedAt: number
  ): Promise<{ status: 'ok'; card: Card } | { status: 'missing' } | { status: 'conflict'; card: Card }> {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return { status: 'missing' }
    if (card.updatedAt !== expectedUpdatedAt) return { status: 'conflict', card }
    const next = await this.updateCard(cardId, patch)
    return next ? { status: 'ok', card: next } : { status: 'missing' }
  }

  private async appendEvents(evs: ReviewEvent[]): Promise<void> {
    const byFile = new Map<string, string[]>()
    for (const ev of evs) {
      const f = this.paths.logFile(ev.t)
      const list = byFile.get(f) ?? []
      list.push(JSON.stringify(ev))
      byFile.set(f, list)
    }
    for (const [f, lines] of byFile) {
      await this.store.appendText(f, lines.join('\n') + '\n')
    }
    this.session.append(evs)
  }

  /** 暂停/解除：追加 suspend 事件（不可撤销，不入会话撤销栈），不重写卡片文件 */
  async setCardSuspended(cardId: string, suspended: boolean): Promise<Card | null> {
    const card = this.cards.get(cardId)
    if (!card) return null
    if (card.suspended !== suspended) {
      const before = { ...card }
      const ev: ReviewEvent = {
        seq: this.session.nextSeq(),
        t: Date.now(),
        action: 'suspend',
        cardId: card.id,
        deckId: card.deckId,
        suspended
      }
      await this.appendEvents([ev])
      card.suspended = suspended
      this.sched.reindexCard(card, before)
    }
    return card
  }

  /** 删除（软删，可撤销）：只追加 review-log，不碰卡片文件（压实留给桌面端） */
  async deleteCard(cardId: string): Promise<void> {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return
    const now = Date.now()
    const before = { ...card }
    const ev: ReviewEvent = {
      seq: this.session.nextSeq(),
      t: now,
      action: 'delete',
      cardId,
      deckId: card.deckId,
      before: card.fsrs
    }
    await this.appendEvents([ev])
    card.deletedAt = now
    this.sched.reindexCard(card, before)
    this.session.pushUndoable([ev])
  }

  // ---------- 学习 ----------

  getStudy(deckId: string): StudyPayload {
    const now = Date.now()
    this.ensureDay(now)
    return {
      card: this.sched.pickNextIdx(deckId, now),
      remaining: this.sched.remainingOf(deckId),
      todayCount: this.todayCount()
    }
  }

  /** 四档评级各自的下次到期预览（不落盘；关 fuzz 保证展示稳定） */
  previewIntervals(cardId: string): number[] {
    const card = this.cards.get(cardId)
    if (!card) return [0, 0, 0, 0]
    const now = Date.now()
    return ([1, 2, 3, 4] as Rating[]).map((r) => this.previewScheduler.review(card.fsrs, r, now).due)
  }

  async answer(
    cardId: string,
    rating: Rating,
    durationMs?: number
  ): Promise<StudyPayload & { answeredCardId: string }> {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) throw new Error(`card not found: ${cardId}`)
    const now = Date.now()
    const before = { ...card }
    const beforeFsrs = card.fsrs
    const after = this.scheduler.review(beforeFsrs, rating, now)
    const ev: ReviewEvent = {
      seq: this.session.nextSeq(),
      t: now,
      action: 'answer',
      cardId,
      deckId: card.deckId,
      rating,
      before: beforeFsrs,
      after,
      durationMs
    }
    const evs: ReviewEvent[] = [ev]
    card.fsrs = after
    card.reps++
    if (rating === 1) card.lapses++
    // leech：累计重来达阈值（>0 启用）自动暂停；同样走 suspend 事件，重放才自洽
    if (this.config.leechThreshold > 0 && !card.suspended && card.lapses >= this.config.leechThreshold) {
      card.suspended = true
      evs.push({
        seq: this.session.nextSeq(),
        t: now,
        action: 'suspend',
        cardId: card.id,
        deckId: card.deckId,
        suspended: true
      })
    }
    await this.appendEvents(evs)
    this.recordAnswer(card.deckId, ev.t, rating, durationMs)
    this.sched.reindexCard(card, before)
    this.session.pushUndoable([ev])
    return { answeredCardId: cardId, ...this.getStudy(card.deckId) }
  }

  /**
   * 撤销上一笔可撤销操作。事件自带 targetAction/targetRating（跨端可重放），
   * targetSeq 只在本会话内有意义——这正是它必须一起写进去的原因。
   */
  async undo(): Promise<UndoResult> {
    const op = this.session.popUndoable()
    if (!op) {
      return { restoredCardId: null, card: null, remaining: 0, todayCount: this.todayCount() }
    }
    const target = this.session.get(op.seq)
    if (!target) throw new Error(`session event missing: ${op.seq}`)
    const card = this.cards.get(op.cardId)
    if (!card) throw new Error(`card missing: ${op.cardId}`)
    const now = Date.now()
    const before = { ...card }
    const ev: ReviewEvent = {
      seq: this.session.nextSeq(),
      t: now,
      action: 'undo',
      cardId: card.id,
      deckId: card.deckId,
      targetSeq: target.seq,
      targetAction: target.action,
      targetRating: target.rating,
      before: target.before ?? null
    }
    await this.appendEvents([ev])
    card.fsrs = ev.before ? { ...ev.before } : target.action === 'answer' ? null : card.fsrs
    if (target.action === 'answer') {
      card.reps = Math.max(0, card.reps - 1)
      if (target.rating === 1) card.lapses = Math.max(0, card.lapses - 1)
      // durationMs 必须一并抵消：否则 timed 减 1 而 durationSumMs 不减，均耗时被凭空抬高
      this.undoAnswer(target.deckId, target.t, target.rating, target.durationMs)
    }
    // leech 还原：这次 answer 触发的自动暂停事件紧跟其后，随撤销一并解除；
    // 手动暂停过的不归这次撤销管（要求它仍是该卡最后一条 suspend 事件）
    if (target.action === 'answer' && target.rating === 1 && card.suspended) {
      const nxt = this.session.get(target.seq + 1)
      const auto = nxt && nxt.cardId === card.id && nxt.action === 'suspend' && nxt.suspended === true ? nxt : undefined
      if (auto && this.session.lastSuspend(card.id) === auto) {
        await this.appendEvents([
          {
            seq: this.session.nextSeq(),
            t: now,
            action: 'suspend',
            cardId: card.id,
            deckId: card.deckId,
            suspended: false
          }
        ])
        card.suspended = false
      }
    }
    if (target.action === 'delete') card.deletedAt = null
    this.sched.reindexCard(card, before)
    return {
      restoredCardId: card.id,
      card,
      remaining: this.sched.remainingOf(card.deckId),
      todayCount: this.todayCount()
    }
  }

  // ---------- 卡片库 ----------

  private deckCards(deckId: string | null): Card[] {
    const hidden = this.hiddenDeckIds()
    if (deckId != null) {
      const out: Card[] = []
      if (hidden.has(deckId)) return out
      for (const c of this.byDeck.get(deckId) ?? []) if (!c.deletedAt) out.push(c)
      return out
    }
    const out: Card[] = []
    for (const [id, bucket] of this.byDeck) {
      if (hidden.has(id)) continue
      for (const c of bucket) if (!c.deletedAt) out.push(c)
    }
    return out
  }

  queryCards(params: QueryParams): QueryResult {
    const nameById = new Map(this.decks.map((d) => [d.id, d.name]))
    let list = filterCards(this.deckCards(params.deckId), params, (c) => this.lowerTextOf(c))
    const deckNameOf = (c: Card): string => nameById.get(c.deckId) ?? ''
    list = sortByKeys(list, params.sort, deckNameOf)
    const offset = Math.max(0, params.offset ?? 0)
    const limit = Math.max(0, params.limit ?? 5000)
    return {
      rows: list.slice(offset, offset + limit).map((c) => toRow(c, deckNameOf(c))),
      total: list.length
    }
  }

  // ---------- 统计 ----------

  getStats(params: StatsParams): StatsPayload {
    const input = {
      cards: this.cards.values(),
      dailyAgg: this.dailyAgg,
      deckId: params.deckId,
      hiddenDeckIds: [...this.hiddenDeckIds()].sort(),
      range: params.range,
      now: Date.now(),
      desiredRetention: this.config.desiredRetention
    }
    const key = statsCacheKey(input, this.session.seq)
    const hit = this.statsCache.get(key)
    if (hit) return hit
    const payload = computeStats(input)
    // 上限 8 组，超出即全清（统计页每次开/切条件都要重算，全库扫描不便宜）
    if (this.statsCache.size >= 8) this.statsCache.clear()
    this.statsCache.set(key, payload)
    return payload
  }
}
