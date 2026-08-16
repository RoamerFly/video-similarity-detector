import type { VideoMetadata } from '@/services/backend'
import type {
  MergeAudioItem,
  MergeQueueItem,
  MergeTextItem,
} from '@/stores/mergeStore'
import { clamp, normalizePath } from './mergeFormat'

export const timelineMinimumWidth = 720

export interface ClipLayout {
  item: MergeQueueItem
  trackId: string
  start: number
  duration: number
  end: number
}

export interface AudioClipLayout {
  item: MergeAudioItem
  trackId: string
  start: number
  duration: number
  end: number
}

export function buildClipLayouts(
  items: MergeQueueItem[],
  trackIds: string[],
  metadata: Record<string, VideoMetadata>,
) {
  const cursors = new Map(trackIds.map((trackId) => [trackId, 0]))
  return items.map<ClipLayout>((item) => {
    const trackId = trackIds.includes(item.trackId) ? item.trackId : trackIds[0] ?? item.trackId
    const duration = clipDuration(item, metadata[normalizePath(item.path)])
    const start = item.startTime === null ? cursors.get(trackId) ?? 0 : Math.max(0, item.startTime)
    const end = start + duration
    cursors.set(trackId, Math.max(cursors.get(trackId) ?? 0, end))
    return { item, trackId, start, duration, end }
  })
}

export function buildAudioLayouts(
  items: MergeAudioItem[],
  trackIds: string[],
  durations: Record<string, number>,
  metadata: Record<string, VideoMetadata>,
) {
  const cursors = new Map(trackIds.map((trackId) => [trackId, 0]))
  return items.map<AudioClipLayout>((item) => {
    const trackId = trackIds.includes(item.trackId) ? item.trackId : trackIds[0] ?? item.trackId
    const duration = audioDuration(item, durations, metadata)
    const start = item.startTime === null ? cursors.get(trackId) ?? 0 : Math.max(0, item.startTime)
    const end = start + duration
    cursors.set(trackId, Math.max(cursors.get(trackId) ?? 0, end))
    return { item, trackId, start, duration, end }
  })
}

export function activeLayoutsAt(layouts: ClipLayout[], time: number, trackIds: string[]) {
  const trackOrder = new Map(trackIds.map((trackId, index) => [trackId, index]))
  return layouts
    .filter((layout) => time >= layout.start && time < layout.end)
    .sort((left, right) => (
      (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0)
      || left.start - right.start
    ))
}

export function playbackStructureKey(
  layouts: ClipLayout[],
  textItems: MergeTextItem[],
  time: number,
  trackIds: string[],
) {
  const videoKey = activeLayoutsAt(layouts, time, trackIds)
    .map((layout) => layout.item.id)
    .join('|')
  const textKey = textItems
    .filter((item) => time >= item.startTime && time < item.startTime + item.duration)
    .map((item) => item.id)
    .join('|')
  return `${videoKey}::${textKey}`
}

export function createTimelinePlaybackIndex(
  layouts: ClipLayout[],
  textItems: MergeTextItem[],
  trackIds: string[],
  audioLayouts: AudioClipLayout[] = [],
) {
  const trackOrder = new Map(trackIds.map((trackId, index) => [trackId, index]))
  const videos = createIntervalIndex(layouts, (layout) => layout.start, (layout) => layout.end)
  const texts = createIntervalIndex(textItems, (item) => item.startTime, (item) => item.startTime + item.duration)
  const audios = createIntervalIndex(audioLayouts, (layout) => layout.start, (layout) => layout.end)
  const activeVideosAt = (time: number) => videos.query(time).sort((left, right) => (
    (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0)
    || left.start - right.start
  ))
  return {
    activeVideosAt,
    activeAudiosAt: (time: number) => audios.query(time),
    structureKeyAt(time: number) {
      const videoKey = activeVideosAt(time).map((layout) => layout.item.id).join('|')
      const textKey = texts.query(time).map((item) => item.id).join('|')
      return `${videoKey}::${textKey}`
    },
  }
}

function createIntervalIndex<T>(items: T[], startOf: (item: T) => number, endOf: (item: T) => number) {
  const sorted = [...items].sort((left, right) => startOf(left) - startOf(right))
  const prefixMaxEnd: number[] = []
  sorted.forEach((item, index) => {
    prefixMaxEnd[index] = Math.max(index === 0 ? Number.NEGATIVE_INFINITY : prefixMaxEnd[index - 1], endOf(item))
  })
  return {
    query(time: number) {
      let low = 0
      let high = sorted.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (startOf(sorted[middle]) <= time) low = middle + 1
        else high = middle
      }
      const active: T[] = []
      for (let index = low - 1; index >= 0; index -= 1) {
        if (prefixMaxEnd[index] <= time) break
        const item = sorted[index]
        if (time >= startOf(item) && time < endOf(item)) active.push(item)
      }
      return active.reverse()
    },
  }
}

export function resolveTimelineDragStart<
  T extends { item: { id: string }; trackId: string; start: number; duration: number; end: number },
>(
  requestedStart: number,
  duration: number,
  movingId: string,
  targetTrackId: string,
  layouts: T[],
  allowCrossTrackOverlap: boolean,
) {
  const start = Math.max(0, requestedStart)
  const shouldAvoidOverlap = !allowCrossTrackOverlap || layouts.some((layout) => (
    layout.item.id === movingId && layout.trackId === targetTrackId
  ))
  if (!shouldAvoidOverlap) return start
  return nearestNonOverlappingStart(start, duration, layouts.filter((layout) => (
    layout.item.id !== movingId && layout.trackId === targetTrackId
  )))
}

export function nearestNonOverlappingStart(
  requestedStart: number,
  duration: number,
  others: Array<{ start: number; end: number }>,
) {
  const start = Math.max(0, requestedStart)
  if (!timeRangeOverlaps(start, start + duration, others)) return start
  const candidates = [0]
  others.forEach((layout) => {
    candidates.push(layout.end, layout.start - duration)
  })
  return candidates
    .filter((candidate) => candidate >= 0 && !timeRangeOverlaps(candidate, candidate + duration, others))
    .sort((left, right) => Math.abs(left - start) - Math.abs(right - start) || left - right)[0] ?? start
}

export function timeRangeOverlaps(
  start: number,
  end: number,
  others: Array<{ start: number; end: number }>,
) {
  const epsilon = 0.0005
  return others.some((layout) => start < layout.end - epsilon && end > layout.start + epsilon)
}

export function timelineTimeFromClientX(
  clientX: number,
  rect: Pick<DOMRect, 'left' | 'width'>,
  totalDuration: number,
  pixelsPerSecond: number,
) {
  if (rect.width <= 0 || totalDuration <= 0 || pixelsPerSecond <= 0) return 0
  return clamp((clientX - rect.left) / pixelsPerSecond, 0, totalDuration)
}

export function previousTrackLayout(
  layouts: ClipLayout[],
  layout: ClipLayout,
  direction: -1 | 1,
) {
  const trackLayouts = layouts
    .filter((candidate) => candidate.trackId === layout.trackId)
    .sort((left, right) => left.start - right.start)
  const index = trackLayouts.findIndex((candidate) => candidate.item.id === layout.item.id)
  return trackLayouts[index + direction] ?? null
}

export function findLayoutAt(layouts: ClipLayout[], time: number) {
  return layouts.find((layout) => time >= layout.start && time < layout.end)
}

export function sourceDurationForClip(item: MergeQueueItem, info?: VideoMetadata) {
  return info?.readable ? info.duration : Math.max(item.trimEnd, item.trimStart + 1)
}

export function timeTicks(duration: number, width = timelineMinimumWidth) {
  if (duration <= 0) return [0]
  const targetTicks = clamp(Math.floor(width / 100), 1, 60)
  const raw = duration / targetTicks
  const units = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  const step = units.find((unit) => unit >= raw) ?? Math.ceil(raw / 3600) * 3600
  const ticks = []
  for (let value = 0; value <= duration; value += step) ticks.push(value)
  return ticks
}

export function timelinePixel(time: number, pixelsPerSecond: number) {
  return `${Math.max(0, time * pixelsPerSecond)}px`
}

export function timelineLength(duration: number, pixelsPerSecond: number) {
  return `${Math.max(2, duration * pixelsPerSecond)}px`
}

/**
 * Returns the logical time window that needs DOM nodes.  The range is kept
 * independent of React so scrolling/virtualization behavior is deterministic
 * and cheap to test.
 */
export function timelineVisibleRange(
  scrollLeft: number,
  viewportWidth: number,
  totalDuration: number,
  pixelsPerSecond: number,
  overscanPixels: number,
) {
  if (viewportWidth <= 0 || pixelsPerSecond <= 0) return { start: 0, end: totalDuration }
  return {
    start: Math.max(0, (scrollLeft - overscanPixels) / pixelsPerSecond),
    end: Math.min(totalDuration, (scrollLeft + viewportWidth + overscanPixels) / pixelsPerSecond),
  }
}

export function timelineLayoutsInRange<T extends { start: number; end: number }>(
  layouts: T[],
  range: { start: number; end: number },
) {
  return layouts.filter((layout) => layout.end >= range.start && layout.start <= range.end)
}

export function canSplitClipAt(
  layout: ClipLayout,
  timelineTime: number,
  metadata: Record<string, VideoMetadata>,
) {
  const sourceTime = layout.item.trimStart + clamp(
    timelineTime - layout.start,
    0,
    layout.duration,
  )
  const sourceEnd = clipSourceEnd(layout.item, metadata[normalizePath(layout.item.path)])
  return sourceTime > layout.item.trimStart + 0.05 && sourceTime < sourceEnd - 0.05
}

function clipDuration(item: MergeQueueItem, info?: VideoMetadata) {
  if (!info?.readable) return Math.max(0.1, item.trimEnd - item.trimStart || 1)
  return Math.max(0.1, clipSourceEnd(item, info) - item.trimStart)
}

export function clipSourceEnd(item: MergeQueueItem, info?: VideoMetadata) {
  const duration = info?.readable ? info.duration : Math.max(item.trimEnd, item.trimStart + 1)
  return item.trimEnd > item.trimStart ? Math.min(item.trimEnd, duration) : duration
}

function audioDuration(
  audio: MergeAudioItem,
  durations: Record<string, number>,
  metadata: Record<string, VideoMetadata>,
) {
  const duration = durations[audio.id] ?? metadata[normalizePath(audio.path)]?.duration ?? 30
  const end = audio.trimEnd > audio.trimStart ? Math.min(audio.trimEnd, duration) : duration
  return Math.max(0.1, end - audio.trimStart)
}
