import { useSyncExternalStore } from 'react'
import type { CropRect, NormalizedLayoutRect } from './previewGeometry'

export interface PreviewEditDraftValue {
  text?: Record<string, { x: number; y: number }>
  layout?: Record<string, NormalizedLayoutRect>
  crop?: { id: string; rect: CropRect }
}

export class PreviewEditDraft {
  private value: PreviewEditDraftValue | null = null
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.value

  set(value: PreviewEditDraftValue | null) {
    this.value = value
    this.listeners.forEach((listener) => listener())
  }
}

export function usePreviewEditDraft(draft: PreviewEditDraft) {
  return useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
}
