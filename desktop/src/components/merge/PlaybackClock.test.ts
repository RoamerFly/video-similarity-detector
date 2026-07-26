import { describe, expect, it, vi } from 'vitest'

import { PlaybackClock } from './PlaybackClock'

describe('PlaybackClock', () => {
  it('normalizes time, deduplicates snapshots, and supports unsubscribe', () => {
    const clock = new PlaybackClock()
    const listener = vi.fn()
    const unsubscribe = clock.subscribe(listener)

    clock.setTime(1.25)
    clock.setTime(1.25)
    clock.setTime(Number.NaN)
    clock.setTime(-5)
    unsubscribe()
    clock.setTime(2)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(clock.getSnapshot()).toBe(2)
  })

  it('ignores sub-frame floating point noise', () => {
    const clock = new PlaybackClock()
    const listener = vi.fn()
    clock.subscribe(listener)

    clock.setTime(10)
    clock.setTime(10.00001)

    expect(listener).toHaveBeenCalledOnce()
    expect(clock.getSnapshot()).toBe(10)
  })
})
