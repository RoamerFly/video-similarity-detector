export interface DriftCorrection {
  seek: boolean
  playbackRate: number
}

/**
 * Keeps media close to the project clock without seeking for small decoder
 * jitter. The result is pure so sync thresholds stay reproducible.
 */
export function driftCorrection(
  targetTime: number,
  mediaTime: number,
  seekThreshold = 0.4,
  rateGain = 0.12,
  minimumRate = 0.97,
  maximumRate = 1.03,
): DriftCorrection {
  const drift = targetTime - mediaTime
  if (Math.abs(drift) > seekThreshold) return { seek: true, playbackRate: 1 }
  return { seek: false, playbackRate: Math.max(minimumRate, Math.min(maximumRate, 1 + drift * rateGain)) }
}

export function targetMediaTime(trimStart: number, timelineTime: number, layoutStart: number) {
  return trimStart + Math.max(0, timelineTime - layoutStart)
}

/**
 * A media event is allowed to resume playback only when it belongs to the
 * latest playback session and remains active.  This is deliberately pure so
 * delayed loadedmetadata events can be covered without browser media mocks.
 */
export function canResumeMedia(
  eventGeneration: number,
  currentGeneration: number,
  playing: boolean,
  activeIds: Iterable<string>,
  mediaId: string,
) {
  if (!playing || eventGeneration !== currentGeneration) return false
  for (const id of activeIds) if (id === mediaId) return true
  return false
}
