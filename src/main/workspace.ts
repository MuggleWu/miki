// WorkspaceService：主进程唯一写入口（需求 NF1，技术栈 §2/§4）
// 内存态 = 启动时从工作区文件重放；写路径：先更新内存，再落盘（原子写/追加）。
// 卡片 delta 行写入的是「当下全量内容」（contentRow 序列化当前内存态），内存先行的
// 窗口期不影响落盘正确性；崩溃恰好落在「内存已改、追加未执行」之间时，重启重放回
// 旧值——即该次写操作整体未发生，不会出现半新半旧的混合态。
// 拆分模块：workspace-io（路径规则/NDJSON 行读/卡片行序列化）、schedule-index（牌组调度
// 索引）、workspace-watcher（外部变更轮询）——本文件仍是唯一状态所有者，公共 API 不变。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './atomic-write'
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
} from '../shared/types'
import { FsrScheduler } from '../core/fsrs'
import { applyEvent } from '../core/replay'
import { filterCards, sortByKeys, toRow } from '../core/query'
import type { MikiConfigPatch } from '../shared/ipc'
import { endOfLocalDay, localDateKey } from '../core/stats'
import { ScheduleIndex } from '../shared/schedule-index'
import { SessionLog } from '../shared/session-log'
import { StatsLedger } from './stats-ledger'
import {
  WorkspacePaths,
  contentRow,
  iterateNdjson,
  newLoadIssues,
  noteDamaged,
  snapshotRow,
  type CardCheckpointRow,
  type LoadIssues
} from './workspace-io'
import type { DamageReport } from '../shared/workspace'
import { WorkspaceWatcher } from './workspace-watcher'

/** delta 压实阈值（行）：追加超过它、或启动时发现 delta 现存行数超过它，就把该牌组压实。
 * 取 200 的理由：真实牌组的 delta 长期停在百行量级不动（没有阈值就永不压实），而一次压实
 * 代价是单牌组基文件重写（真实数据最大 3668 行，实测 <20ms），200 行意味着最坏情况积压可控、
 * 又不会频繁重写文件搅动 git 历史 */
const DELTA_COMPACT_ROWS = 200

/** 删除/移出「待落盘」计数达到它即自动压实该牌组。
 *
 * 为什么删除要单独有个更低的阈值：删卡只写 review-log（唯一真理）与内存，**完全不碰卡片文件**
 * ——基文件里那张行还在、deletedAt 仍是 null。于是「只读卡片文件」的程序（MCP 工具、AI、脚本）
 * 会把已删除的卡当成还在：真实数据里基文件 6716 行 vs 应用可见 6657 张，差 59 张全部是这种
 * 幽灵卡，而文件里没有任何线索指向 review-log。跨牌组移动的墓碑行同理（源基文件仍留着那张卡）。
 * 压实会把内存态（含 deletedAt）写回基文件，所以让它及时发生，文件才真的是「内容真理」。
 * 阈值取 20 而不是 1：压实要全量重写基文件，逐次删除都重写太费；20 能把漂移压在用户可忽略的量级 */
const PENDING_DELETE_COMPACT = 20

export class WorkspaceService {
  root!: string
  config!: MikiConfig
  decks: Deck[] = []
  cards = new Map<string, Card>()
  /** 仅本会话事件（undo 查找用）；历史事件流式重放后不驻留（需求 §19 L1） */
  /** 会话事件日志（事件 + seq 水位 + 撤销栈）：见 session-log.ts */
  private session = new SessionLog()

  /** 本会话事件数：验收「历史事件重放后不驻留内存」用（见 minevents.spec / 需求 §19 L1） */
  sessionEventCount(): number {
    return this.session.length
  }
  private scheduler!: FsrScheduler
  /** 预览专用（无 fuzz），评级按钮的到期提示用它保证展示稳定 */
  private previewScheduler!: FsrScheduler
  /** 会话 undo 栈（D2：不跨会话） */
  private sessionOps: { seq: number; cardId: string }[] = []
  /** 统计账本（聚合 + 今日/累计计数 + 结果缓存）：见 stats-ledger.ts */
  private ledger!: StatsLedger
  /** 受管文件路径规则（init 时按工作区根目录创建） */
  private paths!: WorkspacePaths
  /** 牌组调度索引（due 最小堆 + 增量计数器）：卡库/卡桶/软删牌组经 host 回调每次取当前值——
   * 热加载会整体替换 cards/byDeck 的 Map 实例，绝不能在构造时快照引用 */
  private sched!: ScheduleIndex
  /** 外部变更轮询（指纹 + 冷却合并）：检出变化后回调本服务执行整条重载链 */
  private watcher!: WorkspaceWatcher
  /** 牌组分桶：deckId → 该牌组全部卡（含软删卡，消费方自行过滤）。
   * 按牌组取卡/建堆/压实/到期计数走桶，把 O(全库) 扫描降到 O(牌组卡数)；
   * loadCardsWithCheckpoint 全量重建，addCard(s) 追加、moveCards 跨牌组迁移 */
  private byDeck = new Map<string, Card[]>()
  /** 搜索小写缓存：cardId → [lowerFront, lowerBack]，卡内容只在编辑时变，
   * 查询热路径反复 toLowerCase 是纯重复分配；无条目=未缓存（惰性建） */
  private lowerCache = new Map<string, [string, string]>()
  /** 各牌组基文件检查点 seq（该 seq 及之前的事件已反映在快照行里） */
  private deckCheckpoints = new Map<string, number>()
  /** 各牌组 delta 行数（压实阈值触发） */
  private deltaCounts = new Map<string, number>()
  /** 启动时数出的各牌组 delta 行数（loadCardsWithCheckpoint 顺带计数，零额外 IO）。
   * 与 deltaCounts 不同：这个是「文件里现存的待压实行数」，跨重启累加——deltaCounts 是
   * 本会话的追加次数、热加载时清零，所以小 delta 永远等不到 2000 的阈值 */
  private deltaRowsOnLoad = new Map<string, number>()
  /** 软删牌组 id 集（调度索引/学习页/首页共用）：这些牌组下的卡不算学习计数、不进学习队列。
   * 缓存复用避免热路径每次重分配；deleteDeck/loadDecks 时失效 */
  private hiddenCache: Set<string> | null = null
  /** 最近一次全量加载发现的文件级损坏（无法解析的行 / 末尾缺换行）。UI 据此提示用户，
   * 否则坏行只会被静默 continue 掉，用户看到的是「数字对不上」而不是「有数据坏了」 */
  private loadIssues: LoadIssues = newLoadIssues()
  /** JSON 文档层损坏（decks.json / config.json 解析失败）：NDJSON 坏行之外的一层，
   *  不报出来的话用户只会看到「库空了」+「加载正常」 */
  private corruptDocs = new Set<string>()
  /** 热加载作废撤销栈时的通知回调（丢掉的步数） */
  private undoDiscardedCbs: ((dropped: number) => void)[] = []
  /** 加载时基文件的删除标记快照（id → deletedAt 是否非空）。
   * 判据：内存态认为已删 ⇒ 基文件必须已标删除。必须**在 delta 合并前**采样基文件——
   * delta 的内容覆盖行会改写 deletedAt，合完就看不出基文件本身有没有落盘了 */
  private baseDeletedOnLoad = new Map<string, boolean>()
  /** 启动时数出的「已删但基文件仍显示存活」的卡数（按牌组） */
  private staleDeletesOnLoad = new Map<string, number>()
  /** 各牌组「改了卡片文件之外的东西」的待落盘计数（删卡 / 跨牌组移出的墓碑）。
   * 这些操作不写卡片文件，只有压实才会把内存态写回去；计数到 PENDING_DELETE_COMPACT 就压实，
   * 免得文件长期把已删除的卡显示成还在 */
  private pendingDeletes = new Map<string, number>()

  // ---------- 加载 ----------

  init(root: string, overrides?: Partial<MikiConfig>): void {
    this.root = root
    this.paths = new WorkspacePaths(root)
    this.ledger = new StatsLedger(this.paths, {
      dayKeyOf: (t) => localDateKey(t),
      todayStartMs: () => this.todayStartMs()
    })
    this.sched = new ScheduleIndex({
      cards: () => this.cards,
      bucket: (deckId) => this.byDeck.get(deckId),
      hiddenDeckIds: () => this.hiddenDeckIds(),
      onDayRollover: () => {
        this.ledger.clearToday()
      }
    })
    this.watcher = new WorkspaceWatcher(this.paths, () => this.reloadFromDisk())
    fs.mkdirSync(path.join(this.root, 'cards'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'review-log'), { recursive: true })
    this.config = this.loadConfig(overrides)
    this.scheduler = this.buildScheduler(this.config)
    this.previewScheduler = this.buildScheduler(this.config, true)
    this.loadDecks()
    this.loadStatsCheckpoint()
    this.loadIssues = newLoadIssues()
    this.loadCardsWithCheckpoint(this.loadIssues)
    this.streamEvents(this.loadIssues)
    this.ensureDay()
    this.ensureGitignore()
    // 启动结算积压的 delta（幂等，无积压时一次 fs.existsSync 都不写盘）
    this.compactOversizedDeltas()
    // 启动结算「删除尚未落盘」的历史积压（幂等：没有积压时一次写盘都不发生）
    this.compactStaleDeletions()
    // 启动完成即建快照基线：后续轮询只认真外部变更，不把启动加载当变化
    this.watcher.initStamps()
  }

  private loadConfig(overrides?: Partial<MikiConfig>): MikiConfig {
    const file = this.paths.configJson()
    let stored: Partial<MikiConfig> = {}
    let raw: string | null = null
    if (fs.existsSync(file)) {
      try {
        raw = fs.readFileSync(file, 'utf-8')
        stored = JSON.parse(raw)
      } catch {
        stored = {}
        // raw 保留原样：损坏内容也要参与下方「是否需要重写」判定
        this.corruptDocs.add('config.json')
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
    // 序列化结果与盘上逐字节一致才跳过回写：init/热加载是读路径，不该无谓翻动 config.json 的 mtime
    const serialized = JSON.stringify(config, null, 2)
    if (raw !== serialized) atomicWrite(file, serialized)
    // 跳过回写时也要收敛老版本的宽松权限（0600 含 token）；chmod 不改 mtime，不惊动变更检测
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
    atomicWrite(this.paths.configJson(), JSON.stringify(this.config, null, 2))
    this.watcher.noteWrite(this.paths.configJson())
    return this.config
  }

  private loadDecks(): void {
    this.hiddenCache = null
    const exists = fs.existsSync(this.paths.decksFile())
    if (exists) {
      try {
        this.decks = JSON.parse(fs.readFileSync(this.paths.decksFile(), 'utf-8'))
        return
      } catch {
        // 损坏：记账（以前这一层在健康报告里一条都不显示），但**不覆盖原文件**——
        // 当场写一份空数组会把牌组 id 永久抹掉、卡片全成孤儿，而半写/冲突标记往往是可救的。
        this.corruptDocs.add('decks.json')
      }
    }
    this.decks = []
    // 只有「文件不存在」才补一份空表（首次启动）；损坏时原样留着，等用户/同步决定怎么救
    if (!exists) this.saveDecks()
  }

  private saveDecks(): void {
    atomicWrite(this.paths.decksFile(), JSON.stringify(this.decks, null, 2))
    this.watcher.noteWrite(this.paths.decksFile())
  }

  /** 读统计聚合检查点（stats.json）；缺失/损坏 → 从头聚合（多读一遍事件，语义无损） */
  private loadStatsCheckpoint(): void {
    this.ledger.loadCheckpoint()
  }

  /** 读全部卡片：基文件（含检查点快照行）→ delta 覆盖/墓碑（行序=时序）→ 卡片内存态。
   * 每行跟踪 seq 水位：快照行自带 __mikiSeq，内容行继承基行水位，重放时按卡跳过水位前事件 */
  private loadCardsWithCheckpoint(issues: LoadIssues): void {
    this.cards = new Map()
    this.deckCheckpoints = new Map()
    this.byDeck = new Map()
    this.deltaRowsOnLoad = new Map()
    this.baseDeletedOnLoad = new Map()
    this.lowerCache = new Map() // 外部变更（git pull 等）可能改了卡面，小写缓存全清
    for (const deck of this.decks) {
      const rows = new Map<string, CardCheckpointRow>()
      let cp = 0
      let deltaRows = 0 // delta 现存行数：启动时据此决定要不要压实（见 compactOversizedDeltas）
      for (const line of iterateNdjson(this.paths.deckCardsFile(deck.id), issues)) {
        let row: CardCheckpointRow
        try {
          row = JSON.parse(line) as CardCheckpointRow
        } catch {
          noteDamaged(issues, this.paths.deckCardsFile(deck.id))
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
      // delta 合并前记下基文件的删除标记（合完会被覆盖行改写）
      for (const row of rows.values()) this.baseDeletedOnLoad.set(row.id, row.deletedAt !== null)
      for (const line of iterateNdjson(this.paths.deckDeltaFile(deck.id), issues)) {
        let row: (CardCheckpointRow & { __mikiTombstone?: boolean }) | null
        try {
          row = JSON.parse(line) as CardCheckpointRow & { __mikiTombstone?: boolean }
        } catch {
          noteDamaged(issues, this.paths.deckDeltaFile(deck.id))
          continue
        }
        if (!row || typeof row.id !== 'string') continue
        deltaRows++
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
      this.deltaRowsOnLoad.set(deck.id, deltaRows)
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
        this.deckBucket(deck.id).push(card)
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
  private streamEvents(issues: LoadIssues): void {
    const dir = path.join(this.root, 'review-log')
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.ndjson'))
          .sort()
      : []
    this.session.reset()
    // 注：这里原先有一份「当日日期键」的单条目 memo（省每事件的 Date 构造+格式化），
    // 随统计计数一起并入 StatsLedger 后成了死代码，已删。账本那边每个事件调一次
    // localDateKey（实测 0.10µs/次，百万事件约 100ms，相对 JSON.parse 可忽略），
    // 换来的是「同一套计数逻辑只有一份」，不再有重放路径与运行期路径各写一遍的偏差。
    const win = new Map<
      number,
      { action: ReviewEvent['action']; rating?: Rating; t: number; deckId: string; durationMs?: number }
    >()
    for (const f of files) {
      for (const line of iterateNdjson(path.join(dir, f), issues)) {
        let ev: ReviewEvent
        try {
          ev = JSON.parse(line) as ReviewEvent
        } catch {
          noteDamaged(issues, path.join(dir, f))
          continue
        }
        ev.seq = this.session.nextSeq()
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
        if (ev.seq > this.ledger.checkpointSeq) {
          if (ev.action === 'answer') {
            this.ledger.recordAnswer(ev.deckId, ev.t, ev.rating, ev.durationMs)
          } else if (ev.action === 'undo' && wEntry?.action === 'answer') {
            this.ledger.undoAnswer(wEntry.deckId, wEntry.t, wEntry.rating, wEntry.durationMs)
          }
        }
        win.set(ev.seq, { action: ev.action, rating: ev.rating, t: ev.t, deckId: ev.deckId, durationMs: ev.durationMs })
        // 窗口外 undo 在重放侧丢失聚合抵消（统计差 1，compact 自愈）。40k→200k：单会话
        // 4 万事件（约 40 天千卡量）仍可撤销抵消；上限只约束重放瞬时内存（约 30MB 峰值）
        if (win.size > 200_000) {
          let n = 100_000
          for (const k of win.keys()) {
            win.delete(k)
            if (--n === 0) break
          }
        }
      }
    }
    // 重放已把删除事件应用进内存态，此刻比对基文件快照即可数出「已删但没落盘」的量
    this.collectStaleDeletions()
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

  // ---------- 工作区热加载（外部变更检测；git pull / 他机写入后内存态自动刷新） ----------

  /** 注册外部变更回调（主进程把它转发给渲染进程刷新 UI） */
  onExternalChange(cb: () => void): void {
    this.watcher.onExternalChange(cb)
  }

  /** 注册「热加载作废了撤销栈」回调（参数为丢掉的步数），主进程转发给渲染层提示 */
  onUndoDiscarded(cb: (dropped: number) => void): void {
    this.undoDiscardedCbs.push(cb)
  }

  startWatching(intervalMs = 2000): void {
    this.watcher.startWatching(intervalMs)
  }

  stopWatching(): void {
    this.watcher.stopWatching()
  }

  /** 轮询一次：快照对比发现外部变化 → 热加载（冷却期内合并到下次）。测试直接调用。 */
  pollOnce(): void {
    this.watcher.pollOnce()
  }

  /** 全量重载内存态——与启动加载链逐段同语义（「文件是唯一真理，内存态是运行时缓存」）。
   * 调用方保证 done 后 UI 会被通知刷新。 */
  reloadFromDisk(): void {
    // 必须在 streamEvents 之前取：撤销栈是「本会话事件」的一部分，而 streamEvents 开头
    // 就会 session.reset()，到那时再读一律是 0（这正是本通知第一次实现时的 bug）
    const droppedUndo = this.session.undoableCount
    this.config = this.loadConfig()
    this.scheduler = this.buildScheduler(this.config)
    this.previewScheduler = this.buildScheduler(this.config, true)
    this.loadDecks()
    this.loadStatsCheckpoint()
    this.loadIssues = newLoadIssues()
    this.loadCardsWithCheckpoint(this.loadIssues)
    this.streamEvents(this.loadIssues)
    // 卡对象/调度状态全换新：索引含 due key 与 tie 分配，必须全量重建（不走跨天清零语义，
    // todayAnswers 已由 loadStatsCheckpoint 从聚合重导；与跨天/启动同路径）
    this.sched.forceRebuild(localDateKey(Date.now()), Date.now())
    // 撤销栈已在 streamEvents 的 reset 里作废（外部变更后旧撤销目标可能已失效）。
    // 静默作废在键盘上表现为「⌘Z 没反应」，所以把丢掉的步数显式交给 UI 提示一次
    if (droppedUndo > 0) this.undoDiscardedCbs.forEach((cb) => cb(droppedUndo))
    // 与重启一致：压实阈值从零重新计数；不主动压实——避免热加载改写他人刚同步的文件
    this.deltaCounts = new Map()
    this.pendingDeletes = new Map()
    // 重载完成即重建基线（含本链自身的 config 写入），后续轮询只认真外部变化，并通知 UI 刷新
    this.watcher.rebase()
    this.watcher.notify()
  }

  // ---------- 牌组调度索引与共享缓存（索引本体在 schedule-index.ts） ----------

  private hiddenDeckIds(): Set<string> {
    if (this.hiddenCache === null) {
      this.hiddenCache = new Set(this.decks.filter((d) => d.deletedAt).map((d) => d.id))
    }
    return this.hiddenCache
  }

  /** 跨天检测：日期变化时全量重建索引并清零今日计数（重建同时自愈任何计数漂移） */
  ensureDay(now = Date.now()): void {
    this.sched.ensureDay(now)
  }

  /** 取卡面小写文本（搜索用）：命中缓存直接返回，未命中现算并落缓存 */
  private lowerTextOf(c: Card): [string, string] {
    let hit = this.lowerCache.get(c.id)
    if (hit === undefined) {
      hit = [c.front.toLowerCase(), c.back.toLowerCase()]
      this.lowerCache.set(c.id, hit)
    }
    return hit
  }

  /** 取该牌组的卡桶，不存在则建空桶 */
  private deckBucket(deckId: string): Card[] {
    let b = this.byDeck.get(deckId)
    if (!b) {
      b = []
      this.byDeck.set(deckId, b)
    }
    return b
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
    const active = this.decks.filter((d) => !d.deletedAt)
    // 到期列的读时计算与「未建堆牌组单趟扫描」的合并优化都在 ScheduleIndex 内部
    // （deckCounts 的注释），这里只负责组装展示结构。
    const now = Date.now()
    const counts = this.sched.deckCounts(
      active.map((d) => d.id),
      now
    )
    return active.map((d) => {
      const c = counts.get(d.id) ?? { total: 0, new: 0, due: 0 }
      const deckCounts: DeckTableCounts = { total: c.total, new: c.new, due: c.due }
      return { ...d, counts: deckCounts }
    })
  }

  private todayStartMs(): number {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  todayCount(): number {
    this.ensureDay()
    return this.ledger.todayCount()
  }

  /** 历史累计净答题数（undo 已抵消；启动时算一次，之后答题/撤销增量维护，O(1)） */
  totalAnswered(): number {
    return this.ledger.totalAnsweredCount()
  }

  /** 本次加载发现的文件损坏摘要（UI 启动提示用）。
   * 之前坏行被静默 continue 掉：app 照常启动、数字悄悄偏移，用户只会觉得「数字不对」
   * 而不知道有数据坏了。这里如实报出，并给出去重后的文件名（最多 5 个） */
  damageReport(): DamageReport {
    const damagedLines = [...this.loadIssues.damaged.values()].reduce((a, b) => a + b, 0)
    const rel = (p: string) => path.relative(this.root, p)
    return {
      damagedLines,
      truncatedFiles: [...this.loadIssues.truncated].map(rel),
      files: [...this.loadIssues.damaged.keys()].map(rel).slice(0, 5),
      corruptDocs: [...this.corruptDocs].sort()
    }
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
      // 统计缓存不含牌组名，rename 无需失效（此注释声明该不变量）
    }
    return deck ?? null
  }

  /** 牌组存在性判定（不含软删）。API 校验用：避免为查一个 id 而构建整份 deckInfos。 */
  deckExists(id: string): boolean {
    return this.decks.some((d) => d.id === id && !d.deletedAt)
  }

  deleteDeck(id: string): void {
    const deck = this.decks.find((d) => d.id === id && !d.deletedAt)
    if (deck) {
      deck.deletedAt = Date.now()
      this.hiddenCache = null
      this.saveDecks()
      // 统计缓存无需失效：hiddenDeckIds 进缓存键（getStats），软删后键变化自然重算，
      // 旧键留在缓存里也只是不再被命中
    }
  }

  // ---------- 卡片 ----------

  // ---------- 卡片文件写路径（追加 + 压实，需求 §19 L1） ----------

  /** 新卡行追加到基文件尾（纯新增、无调度历史，不走全量重写） */
  private appendCardRows(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    fs.appendFileSync(this.paths.deckCardsFile(deckId), cards.map((c) => contentRow(c)).join('\n') + '\n', 'utf-8')
    this.watcher.noteWrite(this.paths.deckCardsFile(deckId))
  }

  /** 内容变更追加到 delta 文件（启动时覆盖基行并继承其调度快照） */
  private appendCardDelta(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    fs.appendFileSync(this.paths.deckDeltaFile(deckId), cards.map((c) => contentRow(c)).join('\n') + '\n', 'utf-8')
    this.touchDelta(deckId)
    this.watcher.noteWrite(this.paths.deckDeltaFile(deckId))
  }

  /** 移入牌组：delta 追加带调度快照的完整行（目标可能没有该卡基行，快照须自带）；
   * __mikiSeq 记录快照水位，重放不再重复应用水位前事件 */
  private appendCardDeltaSnapshot(deckId: string, cards: Card[]): void {
    if (cards.length === 0) return
    const lines = cards.map((c) => {
      const { deckId: _d, tie: _t, seqApplied: _s, ...row } = c
      return JSON.stringify({ __mikiSeq: this.session.seq, ...row })
    })
    fs.appendFileSync(this.paths.deckDeltaFile(deckId), lines.join('\n') + '\n', 'utf-8')
    this.touchDelta(deckId)
    this.watcher.noteWrite(this.paths.deckDeltaFile(deckId))
  }

  /** 移出牌组的墓碑行（启动合并时删除对应基行；delta 内行序=时序，先移出后移回不会误删） */
  private appendCardTombstones(deckId: string, ids: string[]): void {
    if (ids.length === 0) return
    fs.appendFileSync(
      this.paths.deckDeltaFile(deckId),
      ids.map((id) => JSON.stringify({ id, __mikiTombstone: true })).join('\n') + '\n',
      'utf-8'
    )
    this.touchDelta(deckId)
    this.watcher.noteWrite(this.paths.deckDeltaFile(deckId))
    this.bumpPendingDeletes(deckId, ids.length)
  }

  /** 记若干条「只在内存里生效、需压实才落盘」的改动（n 默认 1），够数就压实该牌组。
   * n 按**条数**而不是调用次数：一次批量移动/删除可能带多个 id，按调用次数会严重低估 */
  private bumpPendingDeletes(deckId: string, n = 1): void {
    const total = (this.pendingDeletes.get(deckId) ?? 0) + n
    this.pendingDeletes.set(deckId, total)
    if (total >= PENDING_DELETE_COMPACT) {
      if (this.compactDeck(deckId)) this.writeStatsCheckpoint()
    }
  }

  private touchDelta(deckId: string): void {
    const n = (this.deltaCounts.get(deckId) ?? 0) + 1
    this.deltaCounts.set(deckId, n)
    if (n > DELTA_COMPACT_ROWS) {
      if (this.compactDeck(deckId)) this.writeStatsCheckpoint()
    }
  }

  /** 压实一个牌组：全量重写基文件（检查点 seq + 调度快照行）→ 清 delta。
   * 没有待落盘内容（delta 不存在且无删除/墓碑）→ 直接返回，连基文件都不重写：否则每次触发
   * 都要改写全部基文件，git 里全是噪声。返回是否真的压实了（调用方据此决定要不要落聚合检查点）。
   *
   * 注意「无 delta 也可能需要压实」：新增卡直接追加基文件、删卡与跨牌组移出只动内存态，
   * 三种都不建 delta，所以 delta 可能压根不存在，而基文件已经与内存态不一致——典型是
   * **软删卡的 deletedAt 还停在 null**（删卡只写 review-log 与内存）。老版本这里只看 delta
   * 是否存在，会让这条路径永远压不动，只读卡片文件的程序就一直把已删除的卡当成还在。
   * 注意压实**保留**软删行（行数不变，只是 deletedAt 落成时间戳）：内容要留着供撤销/查看 */
  private compactDeck(deckId: string): boolean {
    const hasDelta = fs.existsSync(this.paths.deckDeltaFile(deckId))
    if (!hasDelta && (this.pendingDeletes.get(deckId) ?? 0) === 0) return false
    const lines: string[] = [JSON.stringify({ __mikiCheckpoint: this.session.seq })]
    // 行序 = 卡 id 序：装饰排序（比 id 不比整行 JSON 串，短键比较），读取端按 id 建 Map 不依赖行序
    const cards = (this.byDeck.get(deckId) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const rows = cards.map((c) => snapshotRow(c))
    atomicWrite(this.paths.deckCardsFile(deckId), lines.join('\n') + '\n' + (rows.length ? rows.join('\n') + '\n' : ''))
    fs.rmSync(this.paths.deckDeltaFile(deckId), { force: true })
    this.deltaCounts.set(deckId, 0)
    // 内存态已全部写回基文件：待落盘计数（删除/墓碑）随之归零
    this.pendingDeletes.set(deckId, 0)
    this.deckCheckpoints.set(deckId, this.session.seq)
    this.watcher.noteWrite(this.paths.deckCardsFile(deckId))
    this.watcher.noteWrite(this.paths.deckDeltaFile(deckId))
    return true
  }

  /** 启动压实：delta 现存行数超过阈值的牌组做一次压实。
   * 为什么需要：touchDelta 的计数是本会话追加次数、热加载还会清零，小牌组永远等不到阈值，
   * 于是「基文件 = 内容真理」长期不成立——真实数据里 delta 停在 214 行不动、约 209 张卡的
   * 当前内容只存在于 delta。启动时结算一次，模型与 git 里看到的内容就重新对齐 */
  private compactOversizedDeltas(): void {
    let any = false
    for (const deck of this.decks) {
      if ((this.deltaRowsOnLoad.get(deck.id) ?? 0) > DELTA_COMPACT_ROWS && this.compactDeck(deck.id)) any = true
    }
    if (any) this.writeStatsCheckpoint()
  }

  /** 统计「内存态认为已删、基文件却仍显示存活」的卡（按牌组）。
   *
   * 为什么不变量成立不了：删除只写 review-log 与内存态，卡片文件那行仍是 deletedAt=null，
   * 且旧代码的压实前提是「delta 存在」，而删卡不产生 delta —— 于是这条路径根本走不到，
   * 删除可以永远不落盘。真实工作区里 6716 行基文件中只有 7 张标了删除，而应用认为已删的有 56 张。
   * 按最终结果比对（基文件快照 vs 重放后的内存态），比逐个去猜磁盘来源可靠 */
  private collectStaleDeletions(): void {
    this.staleDeletesOnLoad = new Map()
    for (const [id, cards] of this.byDeck) {
      let stale = 0
      for (const c of cards) {
        if (c.deletedAt !== null && this.baseDeletedOnLoad.get(c.id) === false) stale++
      }
      if (stale > 0) this.staleDeletesOnLoad.set(id, stale)
    }
    this.baseDeletedOnLoad = new Map() // 统计完即释放
  }

  /** 启动结算历史遗留的删除落盘积压：够阈值就压实，把 deletedAt 写进基文件。
   *
   * 为什么要单独一步：pendingDeletes 只对新产生的删除生效，而修复之前累积的删除没有计数可用，
   * 它们在基文件里只表现为 deletedAt=null —— 唯一来源是「基文件快照 vs 内存态」的比对。
   * 只结算一次（读加载期快照后清空），免得每次热加载都重写基文件搅动 git */
  private compactStaleDeletions(): void {
    let any = false
    for (const [deckId, stale] of this.staleDeletesOnLoad) {
      if (stale >= PENDING_DELETE_COMPACT) {
        // 先记进计数再压实：compactDeck 靠它决定「没有 delta」时是否也要重写
        this.pendingDeletes.set(deckId, stale)
        if (this.compactDeck(deckId)) any = true
      }
    }
    this.staleDeletesOnLoad = new Map()
    if (any) this.writeStatsCheckpoint()
  }

  /** 统计聚合检查点落盘（压实时调用，运行期不写避免高频重写） */
  private writeStatsCheckpoint(): void {
    this.ledger.saveCheckpoint(this.session.seq)
    this.ledger.advanceCheckpoint(this.session.seq)
    this.watcher.noteWrite(this.paths.statsFile())
  }

  /** 手动全量压实（运维入口；把所有牌组基文件、调度快照与聚合检查点对齐到当前 seq）。
   * 即使所有 delta 都空、一个牌组都没重写，也照写聚合检查点——调用方的意图是「把检查点
   * 落盘」，delta 是否为空是实现细节 */
  compact(): void {
    for (const d of this.decks) this.compactDeck(d.id)
    this.writeStatsCheckpoint()
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
    this.deckBucket(deckId).push(card)
    this.appendCardRows(deckId, [card])
    this.sched.reindexCard(card, null)
    // 加卡不走事件（不推 seq），统计缓存键感知不到新卡：状态分布的新卡数会 stale
    this.ledger.invalidate()
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
    for (const c of cards) {
      this.cards.set(c.id, c)
      this.deckBucket(deckId).push(c)
    }
    this.appendCardRows(deckId, cards)
    // 批量路径：reindexCard 的公共量（跨天检测/当日界/隐藏牌组/堆索引）hoist 出来，逐卡只做计数+入堆；
    // 新卡 deletedAt=null 且未暂停，走 addCardsNew 与逐卡调 reindexCard 完全同口径
    this.sched.addCardsNew(deckId, cards, now)
    this.ledger.invalidate() // 加卡不走事件（不推 seq），统计缓存键感知不到新卡
    return cards
  }

  /** 批量更新内容：delta 追加（O(变更)），按牌组分组一次落盘；front/back 未提供的字段保留原值；
   *  返回更新数与不存在的 ID 数 */
  updateCards(items: { cardId: string; front?: string; back?: string }[]): { updated: number; missing: number } {
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
      if (it.front === undefined && it.back === undefined) continue // 空 patch：无变化，不计入任何计数
      if (it.front !== undefined) card.front = it.front
      if (it.back !== undefined) card.back = it.back
      this.lowerCache.delete(card.id)
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
      evs.push({
        seq: this.session.nextSeq(),
        t: now,
        action: 'delete',
        cardId: id,
        deckId: card.deckId,
        before: card.fsrs
      })
      card.deletedAt = now
      touched.push({ card, before })
    }
    if (evs.length === 0) return { deleted: 0, missing }
    this.appendEvents(evs)
    this.session.pushUndoable(evs)
    this.sched.reindexBatch(touched)
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

  /** 单卡改内容：patch 未提供的字段保留原值（部分更新），提供的字段整体覆盖（含清空为空串）；
   * 软删卡拒改（与 updateCards/deleteCards 口径一致）；空 patch（两字段都未提供）为 no-op，不写盘 */
  updateCard(cardId: string, patch: { front?: string; back?: string }): Card | null {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return null
    if (patch.front === undefined && patch.back === undefined) return card
    if (patch.front !== undefined) card.front = patch.front
    if (patch.back !== undefined) card.back = patch.back
    this.lowerCache.delete(cardId)
    // 严格单调：updatedAt 同时是内容版本号（编辑弹窗的乐观锁基准）。纯 Date.now() 在同一
    // 毫秒内的两次写入会得到相同时间戳，乐观锁会把「刚被别处改过」误判成「没变」而放行覆盖。
    card.updatedAt = Math.max(Date.now(), card.updatedAt + 1)
    this.appendCardDelta(card.deckId, [card])
    return card
  }

  /** 乐观锁版单卡改内容（编辑弹窗用）。
   *
   * 弹窗从打开到提交之间隔着用户思考时间，期间主窗口可能已经改过同一张卡——没有版本校验时
   * 弹窗提交会带着打开时的旧内容整体覆盖，主窗口那次改动被静默丢弃（lost update）。
   * 这里比对调用方持有的 updatedAt：不一致即报冲突且**不写盘**，由 UI 提示用户。
   *
   * 与 updateCard 分开而不是加参数：卡片库的自动保存是「边打字边落盘」，天然没有长窗口，
   * 不该被版本校验挡下来。 */
  updateCardChecked(
    cardId: string,
    patch: { front?: string; back?: string },
    expectedUpdatedAt: number
  ): { status: 'ok'; card: Card } | { status: 'missing' } | { status: 'conflict'; card: Card } {
    const card = this.cards.get(cardId)
    if (!card || card.deletedAt) return { status: 'missing' }
    if (card.updatedAt !== expectedUpdatedAt) return { status: 'conflict', card }
    const next = this.updateCard(cardId, patch)
    return next ? { status: 'ok', card: next } : { status: 'missing' }
  }

  /** 暂停/解除：追加 suspend 事件（不可撤销，不入会话撤销栈），不重写卡片文件 */
  setCardSuspended(cardId: string, suspended: boolean): Card | null {
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
      this.appendEvents([ev])
      card.suspended = suspended
      this.sched.reindexCard(card, before)
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
      this.appendCardDeltaSnapshot(
        targetDeckId,
        touched.map((t) => t.card)
      )
      const bySource = new Map<string, string[]>()
      for (const t of touched) {
        const list = bySource.get(t.before.deckId) ?? []
        list.push(t.card.id)
        bySource.set(t.before.deckId, list)
      }
      // 分桶迁移：源桶一次性滤出被移动卡，目标桶逐张追加（O(源桶+移动数)）
      const movedIds = new Set(bySource.size === 1 ? bySource.values().next().value! : touched.map((t) => t.card.id))
      for (const srcId of bySource.keys()) {
        this.byDeck.set(
          srcId,
          (this.byDeck.get(srcId) ?? []).filter((c) => !movedIds.has(c.id))
        )
      }
      const targetBucket = this.deckBucket(targetDeckId)
      for (const t of touched) targetBucket.push(t.card)
      for (const [deckId, ids] of bySource) this.appendCardTombstones(deckId, ids)
      this.sched.reindexBatch(touched)
      this.ledger.invalidate() // 移卡不走事件（不推 seq），deckId 变化对统计缓存不可见
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
        seq: this.session.nextSeq(),
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
    this.session.dropUndoable(evs.map((e) => e.cardId))
    this.sched.reindexBatch(touched)
    return evs.length
  }

  private appendEvents(evs: ReviewEvent[]): void {
    const byFile = new Map<string, string[]>()
    for (const ev of evs) {
      const f = this.paths.logFile(ev.t)
      const list = byFile.get(f) ?? []
      list.push(JSON.stringify(ev))
      byFile.set(f, list)
    }
    for (const [f, lines] of byFile) {
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.appendFileSync(f, lines.join('\n') + '\n', 'utf-8')
      this.watcher.noteWrite(f)
    }
    this.session.append(evs)
  }

  deleteCard(cardId: string): void {
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
    this.appendEvents([ev])
    card.deletedAt = now
    this.sched.reindexCard(card, before)
    this.session.pushUndoable([ev])
    // 删除不进卡片文件（见 PENDING_DELETE_COMPACT）：计够数就压实，让基文件重新等于内容真理
    this.bumpPendingDeletes(card.deckId)
  }

  // ---------- 学习 ----------

  private deckCards(deckId: string | null): Card[] {
    const hidden = this.hiddenDeckIds()
    if (deckId != null) {
      const out: Card[] = []
      for (const c of this.byDeck.get(deckId) ?? []) {
        if (!c.deletedAt && !hidden.has(deckId)) out.push(c)
      }
      return out
    }
    const out: Card[] = []
    for (const [id, bucket] of this.byDeck) {
      if (hidden.has(id)) continue
      for (const c of bucket) {
        if (!c.deletedAt) out.push(c)
      }
    }
    return out
  }

  getStudy(deckId: string): StudyPayload {
    const now = Date.now()
    this.ensureDay(now)
    return {
      card: this.sched.pickNextIdx(deckId, now),
      remaining: this.sched.remainingOf(deckId),
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
    // leech：累计重来次数达到阈值（>0 时启用）自动暂停，不再进入调度；同样走 suspend 事件
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
    // 写盘失败要回滚：否则内存与日志分叉 —— 界面显示已答、调度器按新状态排下一张，
    // 磁盘上却什么都没有（下次重载才发现这次答题不存在）。回滚只是这次答题白做，
    // 用户当场能重试；渲染层负责把这次失败报出来。
    try {
      this.appendEvents(evs)
    } catch (e) {
      card.fsrs = beforeFsrs
      card.reps = before.reps
      card.lapses = before.lapses
      card.suspended = before.suspended
      throw e
    }
    this.ledger.recordAnswer(card.deckId, ev.t, rating, durationMs)
    this.sched.reindexCard(card, before)
    this.session.pushUndoable([ev])
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
    this.appendEvents([ev])
    // 内存恢复：answer 撤销 → 回到 before（新卡回 new）并回退 reps/lapses（与 replay 抵消语义一致）；
    // delete 撤销 → 取消软删
    card.fsrs = ev.before ? { ...ev.before } : target.action === 'answer' ? null : card.fsrs
    if (target.action === 'answer') {
      card.reps = Math.max(0, card.reps - 1)
      if (target.rating === 1) card.lapses = Math.max(0, card.lapses - 1)
      // durationMs 必须一并抵消：bumpDailyAgg 用「有耗时才动 timed」判断，
      // 只传 rating 会让 timed 减 1 而 durationSumMs 不减，均耗时被凭空抬高。
      this.ledger.undoAnswer(target.deckId, target.t, target.rating, target.durationMs)
    }
    // leech 还原：该 answer 触发的自动暂停事件紧跟其后（同一批次 seq+1），随撤销一并解除；
    // 之后再无 suspend 事件（最后一条就是它）才认领——手动暂停/解除过的不归这次撤销管。
    // 补一条 suspend(false) 事件保证重放一致（重放不含内存恢复逻辑，只认事件流）。
    if (target.action === 'answer' && target.rating === 1 && card.suspended) {
      const nxt = this.session.get(target.seq + 1)
      const auto = nxt && nxt.cardId === card.id && nxt.action === 'suspend' && nxt.suspended === true ? nxt : undefined
      if (auto && this.session.lastSuspend(card.id) === auto) {
        this.appendEvents([
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

  queryCards(params: QueryParams): QueryResult {
    const nameById = new Map(this.decks.map((d) => [d.id, d.name]))
    // 关键词/状态/到期窗口单趟合并过滤（B3），小写文本走缓存（A1）
    let list = filterCards(this.deckCards(params.deckId), params, (c) => this.lowerTextOf(c))
    const deckNameOf = (c: Card) => nameById.get(c.deckId) ?? ''
    list = sortByKeys(list, params.sort, deckNameOf)
    // 负 offset/limit clamp 到 0：slice 对负数语义是「从尾部数」，静默错位比报错更难排查
    const offset = Math.max(0, params.offset ?? 0)
    const limit = Math.max(0, params.limit ?? 5000)
    return {
      rows: list.slice(offset, offset + limit).map((c) => toRow(c, deckNameOf(c))),
      total: list.length
    }
  }

  getCard(cardId: string): Card | null {
    return this.cards.get(cardId) ?? null
  }

  // ---------- 统计 ----------

  getStats(params: StatsParams): StatsPayload {
    // 缓存键覆盖所有进 computeStats 的输入（含 desiredRetention、hiddenDeckIds——删牌组不推
    // session.seq，后者不进键就会命中删之前的旧统计）
    return this.ledger.query(params, {
      cards: this.cards.values(), // 迭代器直传：computeStats 内部边遍历边过滤，免去整库展开拷贝
      seq: this.session.seq,
      desiredRetention: this.config.desiredRetention,
      // 升序固定顺序：缓存键用它，顺序不定会让同一状态算出多个键（缓存白做）
      hiddenDeckIds: [...this.hiddenDeckIds()].sort()
    })
  }
}
