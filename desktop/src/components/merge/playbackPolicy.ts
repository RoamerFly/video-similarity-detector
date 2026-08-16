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
