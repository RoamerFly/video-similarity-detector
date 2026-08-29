export type TimelineGesturePhase = 'idle' | 'pending' | 'dragging' | 'scrubbing' | 'ended'

export type TimelineGestureEvent =
  | 'pointerdown'
  | 'longpress'
  | 'move'
  | 'scrub'
  | 'pointerup'
  | 'pointercancel'
  | 'blur'
  | 'unmount'

/** Small, explicit state machine shared by video/audio/text pointer gestures. */
export function transitionTimelineGesture(
  phase: TimelineGesturePhase,
  event: TimelineGestureEvent,
): TimelineGesturePhase {
  if (phase === 'ended') return 'ended'
  if (event === 'pointerup' || event === 'pointercancel' || event === 'blur' || event === 'unmount') return 'ended'
  if (phase === 'idle' && event === 'pointerdown') return 'pending'
  if (phase === 'pending' && event === 'longpress') return 'dragging'
  if (phase === 'pending' && event === 'scrub') return 'scrubbing'
  if (phase === 'dragging' && event === 'scrub') return 'dragging'
  return phase
}

/** Keeps the exact pointer-to-clip grab point stable while an overlay moves. */
export function timelineDragOverlayPosition(
  pointerX: number,
  pointerY: number,
  grabOffsetX: number,
  grabOffsetY: number,
) {
  return {
    left: pointerX - grabOffsetX,
    top: pointerY - grabOffsetY,
  }
}
