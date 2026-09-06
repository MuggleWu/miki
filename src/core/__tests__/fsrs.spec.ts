// FSRS-6 移植对拍：tools/fsrs-vectors.json 由 py-fsrs v6.3.2 生成
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
}

const vectorsPath = resolve(__dirname, '../../../tools/fsrs-vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as {
  cases: VecCase[]
}

const sched = new FsrScheduler({ ...DEFAULT_FSRS_PARAMS, enableFuzzing: false })

function approx(a: number | null, b: number | null, rel = 1e-9): boolean {
  if (a == null || b == null) return a === b
  if (a === b) return true
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b))
}

describe('FSRS-6 py-fsrs 对拍', () => {
  it('向量文件存在且非空', () => {
    expect(vectors.cases.length).toBeGreaterThan(30)
  })

  for (const c of vectors.cases) {
    it(c.name, () => {
      const out = sched.review(c.before, c.rating, c.t)
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
    })
  }
})
