// FSRS-6 调度器：从 py-fsrs v6.3.2（fsrs/scheduler.py）逐行移植。
// 比对基线：tools/ 下脚本用 py-fsrs 官方实现生成的期望输出（enable_fuzzing=false）。
// 时间约定：全用毫秒时间戳 number；"天差"复刻 Python timedelta.days 的 floor 语义。

import type { CardSnapshot, FsrsStateEnum, Rating } from '../shared/types'
import { FSRS_STATE } from '../shared/types'

export const DAY_MS = 86_400_000

const FSRS_DEFAULT_DECAY = 0.1542
export const DEFAULT_PARAMETERS: number[] = [
  0.212,
  1.2931,
  2.3065,
  8.2956,
  6.4133,
  0.8334,
  3.0194,
  0.001,
  1.8722,
  0.1666,
  0.796,
  1.4835,
  0.0614,
  0.2629,
  1.6483,
  0.6014,
  1.8729,
  0.5425,
  0.0912,
  0.0658,
  FSRS_DEFAULT_DECAY
]

const STABILITY_MIN = 0.001
const MIN_DIFFICULTY = 1.0
const MAX_DIFFICULTY = 10.0

export interface FsrsParams {
  parameters: number[]
  desiredRetention: number
  /** 秒；对齐 py-fsrs 默认 [1min, 10min] / [10min] */
  learningStepsSec: number[]
  relearningStepsSec: number[]
  maximumInterval: number
  enableFuzzing: boolean
}

export const DEFAULT_FSRS_PARAMS: FsrsParams = {
  parameters: DEFAULT_PARAMETERS,
  desiredRetention: 0.9,
  learningStepsSec: [60, 600],
  relearningStepsSec: [600],
  maximumInterval: 36500,
  enableFuzzing: true
}

const FUZZ_RANGES: { start: number; end: number; factor: number }[] = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 }
]

/** Python round() 的 banker's rounding，保证与移植基线一致 */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff > 0.5) return f + 1
  if (diff < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** 复刻 Python (dt - dt2).days：对负数也向下取整 */
function daysBetween(laterMs: number, earlierMs: number): number {
  return Math.floor((laterMs - earlierMs) / DAY_MS)
}

export class FsrScheduler {
  readonly params: FsrsParams
  private readonly w: number[]
  private readonly DECAY: number
  private readonly FACTOR: number

  constructor(params: FsrsParams = DEFAULT_FSRS_PARAMS) {
    if (params.parameters.length !== 21) {
      throw new Error(`expected 21 parameters, got ${params.parameters.length}`)
    }
    this.params = params
    this.w = params.parameters
    this.DECAY = -this.w[20]
    this.FACTOR = Math.pow(0.9, 1 / this.DECAY) - 1
  }

  private clampStability(s: number): number {
    return Math.max(s, STABILITY_MIN)
  }

  private clampDifficulty(d: number): number {
    return Math.min(Math.max(d, MIN_DIFFICULTY), MAX_DIFFICULTY)
  }

  /** schedulable retrievability；对齐 get_card_retrievability（elapsed = max(0, floor(days))） */
  retrievability(card: CardSnapshot, now: number): number {
    if (card.lastReview == null || card.stability == null) return 0
    const elapsed = Math.max(0, daysBetween(now, card.lastReview))
    return Math.pow(1 + (this.FACTOR * elapsed) / card.stability, this.DECAY)
  }

  private initialStability(rating: Rating): number {
    return this.clampStability(this.w[rating - 1])
  }

  private initialDifficulty(rating: Rating, clamp: boolean): number {
    const d = this.w[4] - Math.exp(this.w[5] * (rating - 1)) + 1
    return clamp ? this.clampDifficulty(d) : d
  }

  private nextIntervalDays(stability: number): number {
    const raw = (stability / this.FACTOR) * (Math.pow(this.params.desiredRetention, 1 / this.DECAY) - 1)
    return Math.min(Math.max(pyRound(raw), 1), this.params.maximumInterval)
  }

  private shortTermStability(stability: number, rating: Rating): number {
    let inc = Math.exp(this.w[17] * (rating - 3 + this.w[18])) * Math.pow(stability, -this.w[19])
    if (rating >= 2) inc = Math.max(inc, 1.0)
    return this.clampStability(stability * inc)
  }

  private nextDifficulty(difficulty: number, rating: Rating): number {
    const linearDamping = (delta: number, d: number): number => ((10.0 - d) * delta) / 9.0
    const meanReversion = (a1: number, a2: number): number => this.w[7] * a1 + (1 - this.w[7]) * a2

    const arg1 = this.initialDifficulty(4, false)
    const delta = -(this.w[6] * (rating - 3))
    const arg2 = difficulty + linearDamping(delta, difficulty)
    return this.clampDifficulty(meanReversion(arg1, arg2))
  }

  private nextRecallStability(difficulty: number, stability: number, retrievability: number, rating: Rating): number {
    const hardPenalty = rating === 2 ? this.w[15] : 1
    const easyBonus = rating === 4 ? this.w[16] : 1
    return (
      stability *
      (1 +
        Math.exp(this.w[8]) *
          (11 - difficulty) *
          Math.pow(stability, -this.w[9]) *
          (Math.exp((1 - retrievability) * this.w[10]) - 1) *
          hardPenalty *
          easyBonus)
    )
  }

  private nextForgetStability(difficulty: number, stability: number, retrievability: number): number {
    const longTerm =
      this.w[11] *
      Math.pow(difficulty, -this.w[12]) *
      (Math.pow(stability + 1, this.w[13]) - 1) *
      Math.exp((1 - retrievability) * this.w[14])
    const shortTerm = stability / Math.exp(this.w[17] * this.w[18])
    return Math.min(longTerm, shortTerm)
  }

  private nextStability(difficulty: number, stability: number, retrievability: number, rating: Rating): number {
    const s =
      rating === 1
        ? this.nextForgetStability(difficulty, stability, retrievability)
        : this.nextRecallStability(difficulty, stability, retrievability, rating)
    return this.clampStability(s)
  }

  private fuzzIntervalDays(days: number): number {
    if (days < 2.5) return days
    let delta = 1.0
    for (const r of FUZZ_RANGES) {
      delta += r.factor * Math.max(Math.min(days, r.end) - r.start, 0.0)
    }
    let minIvl = Math.max(2, pyRound(days - delta))
    const maxIvl = Math.min(pyRound(days + delta), this.params.maximumInterval)
    minIvl = Math.min(minIvl, maxIvl)
    const fuzzed = Math.random() * (maxIvl - minIvl + 1) + minIvl
    return Math.min(pyRound(fuzzed), this.params.maximumInterval)
  }

  /**
   * 对齐 py-fsrs Scheduler.review_card。
   * 输入卡可以是新卡（state='new' 语义：fsrs=null），内部先落为 Learning+step=0。
   */
  review(card: CardSnapshot | null, rating: Rating, now: number): CardSnapshot {
    const c: CardSnapshot = card
      ? { ...card }
      : { state: FSRS_STATE.Learning, step: 0, stability: null, difficulty: null, due: now, lastReview: null }

    const daysSinceLast = c.lastReview != null ? daysBetween(now, c.lastReview) : null
    const shortTerm = daysSinceLast != null && daysSinceLast < 1

    let nextIntervalMs: number

    if (c.state === FSRS_STATE.Learning) {
      if (c.stability == null || c.difficulty == null) {
        c.stability = this.initialStability(rating)
        c.difficulty = this.initialDifficulty(rating, true)
      } else if (shortTerm) {
        c.stability = this.shortTermStability(c.stability, rating)
        c.difficulty = this.nextDifficulty(c.difficulty, rating)
      } else {
        c.stability = this.nextStability(c.difficulty, c.stability, this.retrievability(c, now), rating)
        c.difficulty = this.nextDifficulty(c.difficulty, rating)
      }

      const steps = this.params.learningStepsSec
      const step = c.step ?? steps.length
      if (steps.length === 0 || (step >= steps.length && rating >= 2)) {
        c.state = FSRS_STATE.Review
        c.step = null
        nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
      } else if (rating === 1) {
        c.step = 0
        nextIntervalMs = steps[0] * 1000
      } else if (rating === 2) {
        if (step === 0 && steps.length === 1) {
          nextIntervalMs = steps[0] * 1.5 * 1000
        } else if (step === 0 && steps.length >= 2) {
          nextIntervalMs = ((steps[0] + steps[1]) / 2.0) * 1000
        } else {
          nextIntervalMs = steps[step] * 1000
        }
      } else if (rating === 3) {
        if (step + 1 === steps.length) {
          c.state = FSRS_STATE.Review
          c.step = null
          nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
        } else {
          c.step = step + 1
          nextIntervalMs = steps[c.step] * 1000
        }
      } else {
        c.state = FSRS_STATE.Review
        c.step = null
        nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
      }
    } else if (c.state === FSRS_STATE.Review) {
      if (shortTerm) {
        c.stability = this.shortTermStability(c.stability!, rating)
      } else {
        c.stability = this.nextStability(c.difficulty!, c.stability!, this.retrievability(c, now), rating)
      }
      c.difficulty = this.nextDifficulty(c.difficulty!, rating)

      if (rating === 1) {
        const steps = this.params.relearningStepsSec
        if (steps.length === 0) {
          nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
        } else {
          c.state = FSRS_STATE.Relearning
          c.step = 0
          nextIntervalMs = steps[0] * 1000
        }
      } else {
        nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
      }
    } else if (c.state === FSRS_STATE.Relearning) {
      if (shortTerm) {
        c.stability = this.shortTermStability(c.stability!, rating)
        c.difficulty = this.nextDifficulty(c.difficulty!, rating)
      } else {
        c.stability = this.nextStability(c.difficulty!, c.stability!, this.retrievability(c, now), rating)
        c.difficulty = this.nextDifficulty(c.difficulty!, rating)
      }

      const steps = this.params.relearningStepsSec
      const step = c.step ?? steps.length
      if (steps.length === 0 || (step >= steps.length && rating >= 2)) {
        c.state = FSRS_STATE.Review
        c.step = null
        nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
      } else if (rating === 1) {
        c.step = 0
        nextIntervalMs = steps[0] * 1000
      } else if (rating === 2) {
        if (step === 0 && steps.length === 1) {
          nextIntervalMs = steps[0] * 1.5 * 1000
        } else if (step === 0 && steps.length >= 2) {
          nextIntervalMs = ((steps[0] + steps[1]) / 2.0) * 1000
        } else {
          nextIntervalMs = steps[step] * 1000
        }
      } else if (rating === 3) {
        if (step + 1 === steps.length) {
          c.state = FSRS_STATE.Review
          c.step = null
          nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
        } else {
          c.step = step + 1
          nextIntervalMs = steps[c.step] * 1000
        }
      } else {
        c.state = FSRS_STATE.Review
        c.step = null
        nextIntervalMs = this.nextIntervalDays(c.stability) * DAY_MS
      }
    } else {
      throw new Error(`unknown card state: ${c.state}`)
    }

    if (this.params.enableFuzzing && c.state === FSRS_STATE.Review) {
      nextIntervalMs = this.fuzzIntervalDays(nextIntervalMs / DAY_MS) * DAY_MS
    }

    c.due = now + nextIntervalMs
    c.lastReview = now
    return c
  }
}

export type { FsrsStateEnum }
