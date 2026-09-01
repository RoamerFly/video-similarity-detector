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
  timelineExchangeUpdates,
  timelineExchangeOrder,
  globalVideoTimelineGaps,
  timelineGapPositionUpdates,
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
    const active = index.activeVideosAt(7_654.5)
    expect(index.structureKeyAt(7_654.5, active)).toBe('clip-7654::')
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

  it('reflows different-length clips over the complete track', () => {
    const make = (id: string, start: number, duration: number) => ({
      item: { id }, trackId: 'track-1', start, duration, end: start + duration,
    })
    expect(timelineExchangeUpdates([
      make('a', 0, 2), make('b', 2, 5), make('c', 7, 1),
    ], 'a', 'track-1', 3, 2, 'b')).toEqual([
      { id: 'b', startTime: 0 }, { id: 'a', startTime: 5 },
    ])
  })

  it('exchanges non-adjacent clips and compacts the complete track', () => {
    const make = (id: string, start: number, duration: number) => ({
      item: { id }, trackId: 'track-1', start, duration, end: start + duration,
    })
    expect(timelineExchangeUpdates([
      make('a', 0, 1), make('b', 1, 2), make('c', 3, 3), make('d', 6, 1),
    ], 'd', 'track-1', 4, 1, 'c')).toEqual([
      { id: 'd', startTime: 3 }, { id: 'c', startTime: 4 },
    ])
  })

  it('does not exchange when dropping on another track', () => {
    const make = (id: string, trackId: string) => ({
      item: { id }, trackId, start: 0, duration: 2, end: 2,
    })
    expect(timelineExchangeUpdates([
      make('a', 'track-1'), make('b', 'track-2'),
    ], 'a', 'track-2', 0, 2)).toBeNull()
  })

  it('applies the same exchange rule to audio layouts', () => {
    const audio = [
      { item: { id: 'music-a' }, trackId: 'audio-1', start: 0, duration: 3, end: 3 },
      { item: { id: 'music-b' }, trackId: 'audio-1', start: 3, duration: 1, end: 4 },
    ]
    expect(timelineExchangeUpdates(audio, 'music-a', 'audio-1', 3.2, 3, 'music-b')).toEqual([
      { id: 'music-b', startTime: 0 }, { id: 'music-a', startTime: 1 },
    ])
  })

  it('reflows A to C and C to A into a zero-based compact track', () => {
    const make = (id: string, start: number, duration: number) => ({
      item: { id }, trackId: 'track-1', start, duration, end: start + duration,
    })
    const layouts = [make('a', 2, 2), make('b', 4, 3), make('c', 7, 1), make('d', 11, 2)]
    expect(timelineExchangeUpdates(layouts, 'a', 'track-1', 7, 2, 'c')).toEqual([
      { id: 'c', startTime: 0 }, { id: 'b', startTime: 1 }, { id: 'a', startTime: 4 }, { id: 'd', startTime: 6 },
    ])
    expect(timelineExchangeUpdates(layouts, 'c', 'track-1', 2, 1, 'a')).toEqual([
      { id: 'c', startTime: 0 }, { id: 'b', startTime: 1 }, { id: 'a', startTime: 4 }, { id: 'd', startTime: 6 },
    ])
  })

  it('exchanges only the clip explicitly hit by the pointer', () => {
    const make = (id: string, start: number, duration: number) => ({
      item: { id }, trackId: 'track-1', start, duration, end: start + duration,
    })
    expect(timelineExchangeUpdates([
      make('a', 0, 5), make('b', 5, 2), make('c', 7, 1),
    ], 'a', 'track-1', 5, 5, 'c')).toEqual([
      { id: 'c', startTime: 0 }, { id: 'b', startTime: 1 }, { id: 'a', startTime: 3 },
    ])
  })

  it('changes persistent order when equal-duration clips exchange positions', () => {
    const make = (id: string, start: number) => ({
      item: { id }, trackId: 'track-1', start, duration: 2, end: start + 2,
    })
    const layouts = [make('a', 0), make('b', 2), make('c', 4)]
    expect(timelineExchangeUpdates(layouts, 'a', 'track-1', 2, 2, 'b')).toEqual([
      { id: 'b', startTime: 0 }, { id: 'a', startTime: 2 },
    ])
    expect(timelineExchangeOrder(layouts, 'a', 'track-1', 'b')?.map((layout) => layout.item.id)).toEqual(['b', 'a', 'c'])
  })

  it('finds leading and multiple gaps in the union of all video tracks', () => {
    expect(globalVideoTimelineGaps([
      { trackId: 'v1', start: 2, end: 4 },
      { trackId: 'v2', start: 3, end: 5 },
      { trackId: 'v1', start: 8, end: 9 },
      { trackId: 'v2', start: 10, end: 12 },
    ])).toEqual([
      { start: 0, end: 2, duration: 2 },
      { start: 5, end: 8, duration: 3 },
      { start: 9, end: 10, duration: 1 },
    ])
  })

  it('does not remove a gap covered by another video track and shifts all media equally', () => {
    const gaps = globalVideoTimelineGaps([
      { trackId: 'v1', start: 0, end: 4 },
      { trackId: 'v1', start: 8, end: 10 },
      { trackId: 'v2', start: 4, end: 8 },
    ])
    expect(gaps).toEqual([])

    const actualGaps = globalVideoTimelineGaps([
      { trackId: 'v1', start: 0, end: 2 },
      { trackId: 'v2', start: 0, end: 2 },
      { trackId: 'v1', start: 5, end: 7 },
      { trackId: 'v2', start: 5, end: 7 },
    ])
    expect(timelineGapPositionUpdates(actualGaps, [
      { id: 'video-after', start: 9 },
      { id: 'audio-after', start: 9 },
      { id: 'text-after', start: 9 },
      { id: 'audio-crossing', start: 4 },
    ])).toEqual([
      { id: 'video-after', startTime: 6 },
      { id: 'audio-after', startTime: 6 },
      { id: 'text-after', startTime: 6 },
    ])
  })

  it('returns no updates when the global video union has no empty interval', () => {
    const gaps = globalVideoTimelineGaps([
      { start: 0, end: 3 },
      { start: 2.9999, end: 8 },
    ])
    expect(gaps).toEqual([])
    expect(timelineGapPositionUpdates(gaps, [{ id: 'a', start: 4 }])).toEqual([])
  })
})
