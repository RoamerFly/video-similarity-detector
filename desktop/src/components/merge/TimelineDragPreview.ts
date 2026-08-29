import { useSyncExternalStore } from 'react'

export type TimelineDragPreviewValue = {
  id: string
  kind: 'video' | 'audio' | 'text'
  start: number
  duration?: number
  label?: string
  pointerX?: number
  pointerY?: number
  grabOffsetX?: number
  grabOffsetY?: number
  height?: number
  targetClipId?: string | null
  phase?: 'dragging' | 'settling' | 'reverting'
  /** Trim previews update the committed geometry only after pointerup. */
  mode?: 'move' | 'trim-start' | 'trim-end'
  /** Target track under the pointer; used only for the transient ghost. */
  trackId?: string
  /** Whether the current target can accept the clip. */
  valid?: boolean
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
      && this.value?.duration === value?.duration
      && this.value?.label === value?.label
      && this.value?.pointerX === value?.pointerX
      && this.value?.pointerY === value?.pointerY
      && this.value?.grabOffsetX === value?.grabOffsetX
      && this.value?.grabOffsetY === value?.grabOffsetY
      && this.value?.height === value?.height
      && this.value?.targetClipId === value?.targetClipId
      && this.value?.phase === value?.phase
      && this.value?.mode === value?.mode
      && this.value?.trackId === value?.trackId
      && this.value?.valid === value?.valid) return
    this.value = value
    this.listeners.forEach((listener) => listener())
  }
}

export function useTimelineDragPreview(preview: TimelineDragPreview) {
  return useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot)
}
