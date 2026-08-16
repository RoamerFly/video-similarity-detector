import { useSyncExternalStore } from 'react'

export type TimelineDragPreviewValue = {
  id: string
  kind: 'video' | 'audio' | 'text'
  start: number
  duration?: number
} | null

/** A lightweight render channel for pointer-drag previews, kept outside page state. */
export class TimelineDragPreview {
  private value: TimelineDragPreviewValue = null

  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.value

  set(value: TimelineDragPreviewValue) {
    if (this.value?.id === value?.id
      && this.value?.kind === value?.kind
      && this.value?.start === value?.start
      && this.value?.duration === value?.duration) return
    this.value = value
    this.listeners.forEach((listener) => listener())
  }
}

export function useTimelineDragPreview(preview: TimelineDragPreview) {
  return useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot)
}
