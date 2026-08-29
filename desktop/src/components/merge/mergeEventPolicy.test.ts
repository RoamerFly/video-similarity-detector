import { describe, expect, it } from 'vitest'

import { shouldAcceptMergeProgress } from './mergeEventPolicy'

describe('merge event policy', () => {
  it('rejects delayed progress after a terminal event while idle', () => {
    expect(shouldAcceptMergeProgress(true, false)).toBe(false)
  })

  it('accepts progress for an explicitly started new task', () => {
    expect(shouldAcceptMergeProgress(true, true)).toBe(true)
  })
})
