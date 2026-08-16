import { describe, expect, it, vi } from 'vitest'

import { PreviewEditDraft } from './PreviewEditDraft'

describe('PreviewEditDraft', () => {
  it('notifies only its preview subscribers without project-store writes', () => {
    const draft = new PreviewEditDraft()
    const listener = vi.fn()
    draft.subscribe(listener)
    draft.set({ text: { title: { x: 0.2, y: 0.8 } } })
    draft.set({ layout: { clip: { x: 0, y: 0, width: 0.5, height: 1 } } })
    draft.set(null)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(draft.getSnapshot()).toBeNull()
  })
})
