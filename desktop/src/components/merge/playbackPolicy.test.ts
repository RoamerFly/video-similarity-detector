import { describe, expect, it } from 'vitest'

import { canResumeMedia, driftCorrection, targetMediaTime } from './playbackPolicy'

describe('playbackPolicy', () => {
  it('uses bounded rate correction inside the seek threshold', () => {
    expect(driftCorrection(10.1, 10)).toEqual({ seek: false, playbackRate: 1.012 })
    expect(driftCorrection(20, 19.8).playbackRate).toBe(1.024)
  })

  it('seeks and resets the rate for significant decoder drift', () => {
    expect(driftCorrection(10.41, 10)).toEqual({ seek: true, playbackRate: 1 })
    expect(driftCorrection(10, 10.41)).toEqual({ seek: true, playbackRate: 1 })
  })

  it('maps a shared timeline time into trimmed source time', () => {
    expect(targetMediaTime(2.5, 12, 10)).toBe(4.5)
    expect(targetMediaTime(2.5, 8, 10)).toBe(2.5)
  })

  it('rejects stale or inactive media resume events', () => {
    expect(canResumeMedia(2, 3, true, ['clip-a'], 'clip-a')).toBe(false)
    expect(canResumeMedia(3, 3, false, ['clip-a'], 'clip-a')).toBe(false)
    expect(canResumeMedia(3, 3, true, ['clip-b'], 'clip-a')).toBe(false)
    expect(canResumeMedia(3, 3, true, ['clip-a'], 'clip-a')).toBe(true)
  })
})
