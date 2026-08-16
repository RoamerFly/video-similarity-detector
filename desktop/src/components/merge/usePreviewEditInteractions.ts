
/**
 * Stable boundary for preview editing. The page supplies project mutations;
 * this hook owns pointer listeners and the begin/draft/commit lifecycle.
 */
export function usePreviewEditInteractions() {
  const withPointerLifecycle = <T extends HTMLElement>(
    _event: { currentTarget: T },
    applyDraft: (event: PointerEvent) => void,
    commit: (event: PointerEvent) => void,
    clearDraft: () => void,
  ) => {
    let latest: PointerEvent | null = null
    let frame: number | null = null
    const move = (pointerEvent: PointerEvent) => {
      latest = pointerEvent
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (latest) applyDraft(latest)
      })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (frame !== null) window.cancelAnimationFrame(frame)
      commit(pointerEvent)
      clearDraft()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  return { withPointerLifecycle }
}
