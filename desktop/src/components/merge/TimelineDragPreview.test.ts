import { describe, expect, it, vi } from 'vitest'

import { TimelineDragPreview } from './TimelineDragPreview'

describe('TimelineDragPreview', () => {
  it('only notifies the timeline subscriber when the local draft changes', () => {
    const preview = new TimelineDragPreview()
    const listener = vi.fn()
    preview.subscribe(listener)

    preview.set({ id: 'clip-1', kind: 'video', start: 12 })
    preview.set({ id: 'clip-1', kind: 'video', start: 12 })
    preview.set({ id: 'clip-1', kind: 'video', start: 12.5 })
    preview.set({ id: 'clip-1', kind: 'video', start: 12.5, duration: 4 })
    preview.set(null)

    expect(listener).toHaveBeenCalledTimes(4)
    expect(preview.getSnapshot()).toBeNull()
  })
})
