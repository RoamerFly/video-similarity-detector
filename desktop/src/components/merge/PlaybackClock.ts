import { useSyncExternalStore } from 'react'

type PlaybackClockListener = () => void

export class PlaybackClock {
  private time = 0

  private readonly listeners = new Set<PlaybackClockListener>()

  readonly getSnapshot = () => this.time

  readonly subscribe = (listener: PlaybackClockListener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setTime(time: number) {
    const next = Number.isFinite(time) ? Math.max(0, time) : 0
    if (Math.abs(next - this.time) < 0.0001) return
    this.time = next
    this.listeners.forEach((listener) => listener())
  }
}

export function usePlaybackTime(clock: PlaybackClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot)
}
