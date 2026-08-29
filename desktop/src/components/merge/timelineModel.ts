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

export interface TimelinePositionUpdate {
  id: string
  startTime: number
}

export interface TimelineGap {
  start: number
  end: number
  duration: number
}

/**
 * Finds the gaps which are empty on every video track at the same time.
 * Intervals are intentionally unioned across tracks: an interval covered by
 * even one video track is not removable because removing it would break the
 * global composition's timing.
 */
export function globalVideoTimelineGaps(
  layouts: Array<{ start: number; end: number; trackId?: string }>,
): TimelineGap[] {
  const intervals = layouts
    .filter((layout) => Number.isFinite(layout.start) && Number.isFinite(layout.end) && layout.end > layout.start)
    .map((layout) => ({ start: Math.max(0, layout.start), end: Math.max(0, layout.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  if (intervals.length === 0) return []

  const epsilon = 0.0005
  const gaps: TimelineGap[] = []
  let cursor = 0
  for (const interval of intervals) {
    if (interval.start > cursor + epsilon) {
      gaps.push({ start: cursor, end: interval.start, duration: interval.start - cursor })
    }
    cursor = Math.max(cursor, interval.end)
  }
  return gaps.filter((gap) => gap.duration > epsilon)
}

/**
 * Maps absolute starts through global timeline gaps. A clip beginning before
 * a gap is left intact (including clips crossing a gap); only starts at or
 * after a gap's end move earlier. This makes the operation non-destructive
 * and keeps all media/text tracks in sync with one shared mapping.
 */
export function timelineGapPositionUpdates(
  gaps: TimelineGap[],
  items: Array<{ id: string; start: number }>,
): TimelinePositionUpdate[] {
  if (gaps.length === 0 || items.length === 0) return []
  const epsilon = 0.0005
  return items.flatMap(({ id, start }) => {
    const shift = gaps
      .filter((gap) => start >= gap.end - epsilon)
      .reduce((sum, gap) => sum + gap.duration, 0)
    const next = Math.max(0, start - shift)
    return Math.abs(next - start) > epsilon ? [{ id, startTime: next }] : []
  })
}

/**
 * Reorders and deterministically compacts the complete target track after a
 * same-track drop. Exchanges are an explicit compact operation: the resulting
 * track always starts at zero and contains no internal holes.
 *
 * The timeline intentionally stores absolute starts, so exchanging two clips
 * is not just swapping their start values: clips with different durations
 * must be laid out again across the full track. This pure helper
 * keeps that rule shared by video and audio interactions and makes it possible
 * to verify without mounting the editor.
 */
export function timelineExchangeUpdates<
  T extends { item: { id: string }; trackId: string; start: number; duration: number },
>(
  layouts: T[],
  movingId: string,
  targetTrackId: string,
  _requestedStart: number,
  _movingDuration: number,
  targetClipId?: string | null,
): TimelinePositionUpdate[] | null {
  const next = timelineExchangeOrder(layouts, movingId, targetTrackId, targetClipId)
  if (!next) return null
  // Reflow the entire track from zero. This removes both the old swap's large
  // trailing hole and any pre-existing gap before the exchange point.
  let cursor = 0
  const updates = next.map((layout) => {
    const update = { id: layout.item.id, startTime: cursor }
    cursor += Math.max(0.001, layout.duration)
    return update
  })
  const originalStarts = new Map(
    layouts
      .filter((layout) => layout.trackId === targetTrackId)
      .map((layout) => [layout.item.id, layout.start]),
  )
  return updates.filter((update) => Math.abs((originalStarts.get(update.id) ?? update.startTime) - update.startTime) > 0.0005)
}

/**
 * Returns the target track's order after exchanging the two explicitly hit
 * clips.  Keeping this separate from the start-time calculation is important:
 * when clips overlap or share a start, geometry alone cannot express which
 * clip is first, so their array order must still change for the UI to show the
 * exchange.
 */
export function timelineExchangeOrder<
  T extends { item: { id: string }; trackId: string; start: number; duration: number },
>(
  layouts: T[],
  movingId: string,
  targetTrackId: string,
  targetClipId?: string | null,
): T[] | null {
  const moving = layouts.find((layout) => layout.item.id === movingId)
  if (!moving || moving.trackId !== targetTrackId || !targetClipId) return null
  // The DOM hit id is authoritative. Never infer a target from the moving
  // interval: a long clip may span several neighbours and the user must be
  // able to describe the exchange as “drop on clip X”.
  const target = layouts.find((layout) => (
    layout.item.id === targetClipId
      && layout.item.id !== movingId
      && layout.trackId === targetTrackId
  ))
  if (!target) return null

  const ordered = layouts
    .filter((layout) => layout.trackId === targetTrackId)
    .sort((left, right) => left.start - right.start || left.item.id.localeCompare(right.item.id))
  const from = ordered.findIndex((layout) => layout.item.id === movingId)
  const to = ordered.findIndex((layout) => layout.item.id === target.item.id)
  if (from < 0 || to < 0 || from === to) return null

  const next = [...ordered]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
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
