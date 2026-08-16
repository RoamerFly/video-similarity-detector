import { describe, expect, it } from 'vitest'

import { requestMediaSeek } from './MediaSeekCoordinator'

class FakeMedia {
  currentTime = 0
  seeking = false
  writes: number[] = []
  private listeners: Array<() => void> = []

  addEventListener(_: 'seeked', listener: () => void) {
    this.listeners.push(listener)
  }

  completeSeek() {
    this.seeking = false
    const listeners = this.listeners.splice(0)
    listeners.forEach((listener) => listener())
  }

  setTime(time: number) {
    this.currentTime = time
    this.writes.push(time)
  }
}

function trackedMedia() {
  const media = new FakeMedia()
  return new Proxy(media, {
    set(target, property, value) {
      if (property === 'currentTime') {
        target.setTime(value as number)
        return true
      }
      return Reflect.set(target, property, value)
    },
  })
}

describe('requestMediaSeek', () => {
  it('coalesces rapid scrub targets until the active seek completes', () => {
    const media = trackedMedia()
    requestMediaSeek(media, 4)
    media.seeking = true
    requestMediaSeek(media, 8)
    requestMediaSeek(media, 12)

    expect(media.currentTime).toBe(4)
    media.currentTime = 4
    media.completeSeek()

    expect(media.currentTime).toBe(12)
  })

  it('does not seek again when the target is within tolerance', () => {
    const media = trackedMedia()
    media.setTime(5)
    media.writes.length = 0

    expect(requestMediaSeek(media, 5.004)).toBe(false)
    expect(media.writes).toEqual([])
  })

  it('normalizes invalid and negative targets', () => {
    const media = trackedMedia()
    media.setTime(3)
    media.writes.length = 0

    expect(requestMediaSeek(media, Number.NaN)).toBe(true)
    expect(media.writes).toEqual([0])
  })
})
