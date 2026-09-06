// FSRS-6 基准比对（golden test）：py-fsrs v6.3.2 作为参考实现，生成固定输入的期望输出，
// TS 移植实现跑同样输入后逐例比对。tools/fsrs-vectors.json 与 fsrs-vectors-random.json 均由其生成
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FsrScheduler, DEFAULT_FSRS_PARAMS } from '../fsrs'
import type { CardSnapshot, Rating } from '../../shared/types'

interface VecCase {
  name: string
  before: CardSnapshot | null
  rating: Rating
  t: number
  after: {
    state: number
    step: number | null
    stability: number | null
    difficulty: number | null
    due: number
    lastReview: number | null
  }
  /** 随机向量：该 case 的调度参数（参数/留存率/steps/上限），缺省 = 默认 */
  sched?: {
    retention: number
    learningSteps: number[]
    relearningSteps: number[]
    maximumInterval: number
    parameters: number[]
  }
}

const vectorsPath = resolve(__dirname, '../../../tools/fsrs-vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as {
  cases: VecCase[]
}

// 随机参数维度（tools/gen-fsrs-vectors-random.py 生成）：随机 21 参数、
// 随机留存率/steps/maximumInterval × 随机 rating 路径，固定种子可复现
const randomVectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../tools/fsrs-vectors-random.json'), 'utf-8')
) as { cases: VecCase[] }

const sched = new FsrScheduler({ ...DEFAULT_FSRS_PARAMS, enableFuzzing: false })
const schedCache = new Map<string, FsrScheduler>()

function schedFor(c: VecCase): FsrScheduler {
  if (!c.sched) return sched
  const key = JSON.stringify(c.sched)
  let s = schedCache.get(key)
  if (!s) {
    s = new FsrScheduler({
      parameters: c.sched.parameters,
      desiredRetention: c.sched.retention,
      learningStepsSec: c.sched.learningSteps,
      relearningStepsSec: c.sched.relearningSteps,
      maximumInterval: c.sched.maximumInterval,
      enableFuzzing: false
    })
    schedCache.set(key, s)
  }
  return s
}

function approx(a: number | null, b: number | null, rel = 1e-9): boolean {
  if (a == null || b == null) return a === b
  if (a === b) return true
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b))
}

function assertMatches(c: VecCase): void {
  const out = schedFor(c).review(c.before, c.rating, c.t)
  expect(out.state, `${c.name} state`).toBe(c.after.state)
  expect(out.step, `${c.name} step`).toBe(c.after.step)
  expect(
    approx(out.stability, c.after.stability),
    `${c.name} stability: got ${out.stability} want ${c.after.stability}`
  ).toBe(true)
  expect(
    approx(out.difficulty, c.after.difficulty),
    `${c.name} difficulty: got ${out.difficulty} want ${c.after.difficulty}`
  ).toBe(true)
  expect(
    approx(out.due, c.after.due, 1e-6),
    `${c.name} due: got ${out.due} want ${c.after.due}`
  ).toBe(true)
  expect(out.lastReview, `${c.name} lastReview`).toBe(c.after.lastReview)
}

describe('FSRS-6 与 py-fsrs 参考实现比对', () => {
  it('向量文件存在且非空', () => {
    expect(vectors.cases.length).toBeGreaterThan(30)
    expect(randomVectors.cases.length).toBeGreaterThan(300)
  })

  for (const c of vectors.cases) {
    it(c.name, () => assertMatches(c))
  }

  describe('随机参数维度', () => {
    for (const c of randomVectors.cases) {
      it(c.name, () => assertMatches(c))
    }
  })
})
