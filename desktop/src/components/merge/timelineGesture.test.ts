import { describe, expect, it } from 'vitest'

import { timelineDragOverlayPosition, transitionTimelineGesture } from './timelineGesture'

describe('timeline gesture state machine', () => {
  it('does not turn quick movement into scrubbing before long press', () => {
    let phase = transitionTimelineGesture('idle', 'pointerdown')
    phase = transitionTimelineGesture(phase, 'move')
    expect(phase).toBe('pending')
    expect(transitionTimelineGesture(phase, 'pointerup')).toBe('ended')
  })

  it('starts dragging only after the long-press transition and cancels safely', () => {
    const dragging = transitionTimelineGesture(
      transitionTimelineGesture('pending', 'longpress'),
      'move',
    )
    expect(dragging).toBe('dragging')
    expect(transitionTimelineGesture(dragging, 'pointercancel')).toBe('ended')
    expect(transitionTimelineGesture(dragging, 'blur')).toBe('ended')
  })

  it('preserves the pointer grab offset for both axes', () => {
    expect(timelineDragOverlayPosition(180, 260, 24, 9)).toEqual({ left: 156, top: 251 })
  })
})
