import { describe, expect, it } from 'vitest'

import type { VideoMetadata } from '@/services/backend'
import type { MergeQueueItem, MergeTextItem } from '@/stores/mergeStore'
import type { AudioClipLayout } from './timelineModel'
import {
  activeLayoutsAt,
  buildClipLayouts,
  canSplitClipAt,
  createTimelinePlaybackIndex,
  clipSourceEnd,
  nearestNonOverlappingStart,
  playbackStructureKey,
  resolveTimelineDragStart,
  timelineLayoutsInRange,
  timelineVisibleRange,
  timelineTimeFromClientX,
  timeTicks,
} from './timelineModel'

function clip(
  id: string,
  trackId: string,
  trimEnd: number,
  startTime: number | null = null,
): MergeQueueItem {
  return {
    id,
    path: `C:\\media\\${id}.mp4`,
    name: `${id}.mp4`,
    trackId,
    startTime,
    trimStart: 0,
    trimEnd,
    muted: false,
    volume: 1,
    rotation: 0,
    cropEnabled: false,
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1,
    layoutCustom: false,
    layoutX: 0,
    layoutY: 0,
    layoutWidth: 1,
    layoutHeight: 1,
  }
}

function metadataFor(item: MergeQueueItem): VideoMetadata {
  return {
    path: item.path,
    width: 1920,
    height: 1080,
    duration: item.trimEnd,
    fps: 30,
    frameCount: item.trimEnd * 30,
    readable: true,
    error: '',
  }
}

function metadata(items: MergeQueueItem[]) {
  return Object.fromEntries(items.map((item) => [
    item.path.replaceAll('\\', '/').toLowerCase(),
    metadataFor(item),
  ]))
}

describe('timeline layout behavior', () => {
  it('places implicit clips after the track cursor and keeps explicit starts', () => {
    const items = [
      clip('first', 'video-1', 4),
      clip('second', 'video-1', 3),
      clip('overlay', 'video-2', 2, 1.5),
      clip('fallback', 'missing-track', 1),
    ]

    const layouts = buildClipLayouts(items, ['video-1', 'video-2'], metadata(items))

    expect(layouts.map(({ trackId, start, end }) => ({ trackId, start, end }))).toEqual([
      { trackId: 'video-1', start: 0, end: 4 },
      { trackId: 'video-1', start: 4, end: 7 },
      { trackId: 'video-2', start: 1.5, end: 3.5 },
      { trackId: 'video-1', start: 7, end: 8 },
    ])
  })

  it('uses half-open boundaries for active video and text structures', () => {
    const items = [
      clip('first', 'video-1', 2, 0),
      clip('second', 'video-1', 4, 2),
    ]
    const layouts = buildClipLayouts(items, ['video-1'], metadata(items))
    const text: MergeTextItem[] = [{
      id: 'title',
      text: 'Title',
      trackId: 'text-1',
      startTime: 1,
      duration: 1,
      x: 0.5,
      y: 0.5,
      fontSize: 48,
      color: '#ffffff',
      backgroundColor: '#000000',
    }]

    expect(activeLayoutsAt(layouts, 2, ['video-1']).map((layout) => layout.item.id)).toEqual(['second'])
    expect(playbackStructureKey(layouts, text, 1.5, ['video-1'])).toBe('first::title')
    expect(playbackStructureKey(layouts, text, 2, ['video-1'])).toBe('second::')
  })

  it('snaps collisions on the same track but allows cross-track overlap', () => {
    expect(nearestNonOverlappingStart(2, 2, [
      { start: 0, end: 3 },
      { start: 5, end: 7 },
    ])).toBe(3)

    const sameTrack = [
      { item: { id: 'moving' }, trackId: 'video-1', start: 0, duration: 2, end: 2 },
      { item: { id: 'other' }, trackId: 'video-1', start: 1, duration: 2, end: 3 },
    ]
    expect(resolveTimelineDragStart(1, 2, 'moving', 'video-1', sameTrack, false)).toBe(3)

    const crossTrack = [
      { item: { id: 'moving' }, trackId: 'video-1', start: 0, duration: 2, end: 2 },
      { item: { id: 'other' }, trackId: 'video-2', start: 1, duration: 2, end: 3 },
    ]
    expect(resolveTimelineDragStart(1, 2, 'moving', 'video-2', crossTrack, true)).toBe(1)
  })

  it('maps pointer positions to clamped timeline time', () => {
    const rect = { left: 100, width: 500 }

    expect(timelineTimeFromClientX(220, rect, 30, 12)).toBe(10)
    expect(timelineTimeFromClientX(40, rect, 30, 12)).toBe(0)
    expect(timelineTimeFromClientX(1000, rect, 30, 12)).toBe(30)
  })

  it('keeps an overscanned visible range bounded to the complete timeline', () => {
    expect(timelineVisibleRange(240, 360, 120, 12, 120)).toEqual({ start: 10, end: 60 })
    expect(timelineVisibleRange(0, 360, 120, 12, 120)).toEqual({ start: 0, end: 40 })
    expect(timelineVisibleRange(1400, 360, 120, 12, 120)).toEqual({ start: 106.66666666666667, end: 120 })
  })

  it('limits a large timeline to intersecting items while retaining boundary overlaps', () => {
    const layouts = Array.from({ length: 10_000 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 2,
      index,
    }))

    const visible = timelineLayoutsInRange(layouts, { start: 4_001, end: 4_019 })

    expect(visible.map((layout) => layout.index)).toEqual([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009])
  })

  it('queries active structures from an indexed large timeline', () => {
    const items = Array.from({ length: 10_000 }, (_, index) => clip(`clip-${index}`, 'video-1', 1, index))
    const layouts = buildClipLayouts(items, ['video-1'], metadata(items))
    const index = createTimelinePlaybackIndex(layouts, [], ['video-1'])

    expect(index.activeVideosAt(7_654.5).map((layout) => layout.item.id)).toEqual(['clip-7654'])
    expect(index.structureKeyAt(7_654.5)).toBe('clip-7654::')
    expect(index.activeVideosAt(10_000)).toEqual([])
  })

  it('queries active audio without scanning every audio layout', () => {
    const audio = Array.from({ length: 5_000 }, (_, index) => ({
      item: { id: `audio-${index}` }, trackId: 'audio-1', start: index, duration: 0.5, end: index + 0.5,
    })) as AudioClipLayout[]
    const index = createTimelinePlaybackIndex([], [], [], audio)
    expect(index.activeAudiosAt(200.25).map((layout) => layout.item.id)).toEqual(['audio-200'])
    expect(index.activeAudiosAt(200.75)).toEqual([])
  })

  it('keeps timeline ticks deterministic for a fit-to-width timeline', () => {
    expect(timeTicks(0)).toEqual([0])
    expect(timeTicks(10, 500)).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('only splits inside the trimmed clip range', () => {
    const item = clip('trimmed', 'video-1', 8, 2)
    item.trimStart = 2
    const info = metadataFor(item)
    info.duration = 10
    const layout = buildClipLayouts([item], ['video-1'], metadata([item]))[0]
    const rows = { [item.path.replaceAll('\\', '/').toLowerCase()]: info }

    expect(clipSourceEnd(item, info)).toBe(8)
    expect(canSplitClipAt(layout, 2.01, rows)).toBe(false)
    expect(canSplitClipAt(layout, 4, rows)).toBe(true)
    expect(canSplitClipAt(layout, layout.end - 0.01, rows)).toBe(false)
  })
})
