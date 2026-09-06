// WorkspaceService：主进程唯一写入口（需求 NF1，技术栈 §2/§4）
// 内存态 = 启动时从工作区文件重放；所有写路径：先落盘（原子写/追加），后更新内存。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  type Card,
  type CardContent,
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
import { deckCounts, pickNext, remainingCount } from '../core/queue'
import { replayCard } from '../core/replay'
import { compareByKeys, displayState, filterByKeywords, toRow } from '../core/query'
import type { MikiConfigPatch } from '../shared/ipc'
import { computeStats, endOfLocalDay } from '../core/stats'

const MONTH_MS = 31 * 86_400_000

function atomicWrite(file: string, data: string): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
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
  events: ReviewEvent[] = []
  private seq = 0
  private scheduler!: FsrScheduler
  /** 预览专用（无 fuzz），评级按钮的到期提示用它保证展示稳定 */
  private previewScheduler!: FsrScheduler
  /** 会话 undo 栈（D2：不跨会话） */
  private sessionOps: { seq: number; cardId: string }[] = []

  // ---------- 路径 ----------

  private decksFile(): string {
    return path.join(this.root, 'decks.json')
  }

  private deckCardsFile(deckId: string): string {
    return path.join(this.root, 'cards', `${deckId}.ndjson`)
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
    this.loadEvents()
    this.replayAll()
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

  /** 读全部 review-log（按月文件名序 + 行序），重编全局 seq */
  private loadEvents(): void {
    const dir = path.join(this.root, 'review-log')
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()
      : []
    this.events = []
    this.seq = 0
    for (const f of files) {
      for (const line of readNdjson(path.join(dir, f))) {
        try {
          const ev = JSON.parse(line) as ReviewEvent
          ev.seq = ++this.seq
          this.events.push(ev)
        } catch {
          // 跳过损坏行
        }
      }
    }
  }

  private replayAll(): void {
    this.cards = new Map()
    const byCard = new Map<string, ReviewEvent[]>()
    for (const ev of this.events) {
      const list = byCard.get(ev.cardId)
      if (list) list.push(ev)
      else byCard.set(ev.cardId, [ev])
    }
    for (const deck of this.decks) {
      for (const line of readNdjson(this.deckCardsFile(deck.id))) {
        let content: CardContent
        try {
          content = JSON.parse(line) as CardContent
        } catch {
          continue
        }
        this.cards.set(content.id, replayCard(content, deck.id, byCard.get(content.id) ?? []))
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

  // ---------- 只读视图 ----------

  now(): number {
    return Date.now()
  }

  endOfToday(): number {
    return endOfLocalDay(Date.now())
  }

  deckInfos(): DeckInfo[] {
    const now = Date.now()
    const eot = this.endOfToday()
    return this.decks
      .filter((d) => !d.deletedAt)
      .map((d) => {
        const list: Card[] = []
        for (const c of this.cards.values()) if (c.deckId === d.id) list.push(c)
        return { ...d, counts: deckCounts(list, eot) }
      })
      .map((x) => ({ ...x, counts: sortCounts(x.counts, now) }))
  }

  todayCount(): number {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const undone = new Set(this.events.filter((e) => e.action === 'undo' && e.targetSeq != null).map((e) => e.targetSeq!))
    return this.events.filter(
      (e) => e.action === 'answer' && !undone.has(e.seq) && e.t >= start.getTime()
    ).length
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

  private saveDeckCards(deckId: string): void {
    const lines: string[] = []
    for (const c of this.cards.values()) {
      if (c.deckId !== deckId) continue
      const { deckId: _d, fsrs: _f, reps: _r, lapses: _l, ...content } = c
      lines.push(JSON.stringify(content))
    }
    lines.sort()
    atomicWrite(this.deckCardsFile(deckId), lines.length ? lines.join('\n') + '\n' : '')
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
    this.saveDeckCards(deckId)
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
    this.saveDeckCards(deckId)
    return cards
  }

  /** 批量更新内容：按牌组分组一次落盘；返回更新数与不存在的 ID 数 */
  updateCards(items: { cardId: string; front: string; back: string }[]): { updated: number; missing: number } {
    const now = Date.now()
    let updated = 0
    let missing = 0
    const touched = new Set<string>()
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
      touched.add(card.deckId)
    }
    for (const deckId of touched) this.saveDeckCards(deckId)
    return { updated, missing }
  }

  /** 批量软删：每张一个 delete 事件（可撤销），按牌组去重一次落盘 */
  deleteCards(cardIds: string[]): { deleted: number; missing: number } {
    const now = Date.now()
    const evs: ReviewEvent[] = []
    let missing = 0
    for (const id of cardIds) {
      const card = this.cards.get(id)
      if (!card || card.deletedAt) {
        missing++
        continue
      }
      evs.push({ seq: ++this.seq, t: now, action: 'delete', cardId: id, deckId: card.deckId, before: card.fsrs })
      card.deletedAt = now
    }
    if (evs.length === 0) return { deleted: 0, missing }
    this.appendEvents(evs)
    for (const ev of evs) this.sessionOps.push({ seq: ev.seq, cardId: ev.cardId })
    for (const deckId of new Set(evs.map((e) => e.deckId))) this.saveDeckCards(deckId)
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
    this.saveDeckCards(card.deckId)
    return card
  }

  setCardSuspended(cardId: string, suspended: boolean): Card | null {
    const card = this.cards.get(cardId)
    if (!card) return null
    card.suspended = suspended
    this.saveDeckCards(card.deckId)
    return card
  }

  /** 批量移动卡片到目标牌组：deckId 是内容字段，保留调度进度，不进调度事件 */
  moveCards(cardIds: string[], targetDeckId: string): number {
    if (!this.decks.some((d) => d.id === targetDeckId && !d.deletedAt)) return 0
    const now = Date.now()
    const touched = new Set<string>([targetDeckId])
    let moved = 0
    for (const id of cardIds) {
      const c = this.cards.get(id)
      if (!c || c.deletedAt || c.deckId === targetDeckId) continue
      touched.add(c.deckId)
      c.deckId = targetDeckId
      c.updatedAt = now
      moved++
    }
    if (moved > 0) for (const deckId of touched) this.saveDeckCards(deckId)
    return moved
  }

  /** 批量重置进度：调度/统计清零并解除暂停，变回新卡；追加 reset 事件（不可撤销） */
  resetProgress(cardIds: string[]): number {
    const now = Date.now()
    const evs: ReviewEvent[] = []
    for (const id of cardIds) {
      const c = this.cards.get(id)
      if (!c || c.deletedAt) continue
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
    }
    if (evs.length === 0) return 0
    this.appendEvents(evs)
    // reset 不可撤销：把该卡的会话撤销栈一并作废
    const resetIds = new Set(evs.map((e) => e.cardId))
    this.sessionOps = this.sessionOps.filter((op) => !resetIds.has(op.cardId))
    for (const deckId of new Set(evs.map((e) => e.deckId))) this.saveDeckCards(deckId)
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
    const ev: ReviewEvent = { seq: ++this.seq, t: now, action: 'delete', cardId, deckId: card.deckId, before: card.fsrs }
    this.appendEvents([ev])
    card.deletedAt = now
    this.saveDeckCards(card.deckId)
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
    const list = this.deckCards(deckId)
    return {
      card: pickNext(list, now),
      remaining: remainingCount(list, this.endOfToday()),
      todayCount: this.todayCount()
    }
  }

  answer(cardId: string, rating: Rating, durationMs?: number): StudyPayload & { answeredCardId: string } {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) throw new Error(`card not found: ${cardId}`)
    const now = Date.now()
    const before = card.fsrs
    const after = this.scheduler.review(before, rating, now)
    const ev: ReviewEvent = { seq: ++this.seq, t: now, action: 'answer', cardId, deckId: card.deckId, rating, before, after, durationMs }
    this.appendEvents([ev])
    card.fsrs = after
    card.reps++
    if (rating === 1) card.lapses++
    // leech：累计重来次数达到阈值（>0 时启用）自动暂停，不再进入调度
    if (this.config.leechThreshold > 0 && !card.suspended && card.lapses >= this.config.leechThreshold) {
      card.suspended = true
      this.saveDeckCards(card.deckId)
    }
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
    const ev: ReviewEvent = {
      seq: ++this.seq,
      t: now,
      action: 'undo',
      cardId: card.id,
      deckId: card.deckId,
      targetSeq: target.seq,
      before: target.before ?? null
    }
    this.appendEvents([ev])
    // 内存恢复：answer 撤销 → 回到 before（新卡回 new）并回退 reps/lapses（与 replay 抵消语义一致）；
    // delete 撤销 → 取消软删
    card.fsrs = ev.before ? { ...ev.before } : target.action === 'answer' ? null : card.fsrs
    if (target.action === 'answer') {
      card.reps = Math.max(0, card.reps - 1)
      if (target.rating === 1) card.lapses = Math.max(0, card.lapses - 1)
    }
    if (target.action === 'delete') card.deletedAt = null
    this.saveDeckCards(card.deckId)
    const list = this.deckCards(card.deckId)
    return {
      restoredCardId: card.id,
      card,
      remaining: remainingCount(list, this.endOfToday()),
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
      events: this.events,
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
