import { memo, useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { Clock3, Film, GripVertical, Music2, RotateCw, SquareDashedMousePointer, Type, VolumeX } from 'lucide-react'
import { MergeTimelinePlayhead } from './MergePlaybackControls'
import { PlaybackClock } from './PlaybackClock'
import { TimelineDragPreview, useTimelineDragPreview } from './TimelineDragPreview'
import {
  formatPreciseTime,
  formatTick,
} from './mergeFormat'
import {
  timelineLength,
  timelineLayoutsInRange,
  timelinePixel,
  timelineVisibleRange,
  timeTicks,
  type AudioClipLayout,
  type ClipLayout,
} from './timelineModel'
import type { MergeTextItem, MergeTrack } from '@/stores/mergeStore'

interface MergeTimelineProps {
  clock: PlaybackClock
  dragPreview: TimelineDragPreview
  timelineRef: RefObject<HTMLDivElement | null>
  timelineScrollRef: RefObject<HTMLDivElement | null>
  videoTracks: MergeTrack[]
  audioTracks: MergeTrack[]
  textTracks: MergeTrack[]
  clipLayouts: ClipLayout[]
  audioLayouts: AudioClipLayout[]
  textItems: MergeTextItem[]
  totalDuration: number
  contentWidth: number
  contentHeight: number
  tracksTemplate: string
  pixelsPerSecond: number
  selectedClipId: string
  selectedAudioId: string
  selectedTextId: string
  draggedClipId: string
  draggedAudioId: string
  draggedTextId: string
  playheadDragging: boolean
  onTracksPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPlayheadPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
  onTrackContextMenu: (event: React.MouseEvent, kind: 'video' | 'audio' | 'text', trackId: string) => void
  onTextTrackContextMenu: (event: React.MouseEvent, trackId: string) => void
  onVideoPointerDown: (event: React.PointerEvent, layout: ClipLayout) => void
  onVideoContextMenu: (event: React.MouseEvent, layout: ClipLayout) => void
  onVideoTrimPointerDown: (event: React.PointerEvent, layout: ClipLayout, edge: 'start' | 'end') => void
  onAudioPointerDown: (event: React.PointerEvent, layout: AudioClipLayout) => void
  onAudioContextMenu: (event: React.MouseEvent, layout: AudioClipLayout) => void
  onTextPointerDown: (event: React.PointerEvent, item: MergeTextItem) => void
  onTextContextMenu: (event: React.MouseEvent, item: MergeTextItem) => void
}

const overscanPixels = 360

/**
 * The timeline is intentionally isolated from the editor page. Playback updates
 * the external clock (and therefore only the playhead subscriber); this memoized
 * component only recalculates clip DOM when the visible window or structure changes.
 */
export const MergeTimeline = memo(function MergeTimeline({
  clock,
  dragPreview,
  timelineRef,
  timelineScrollRef,
  videoTracks,
  audioTracks,
  textTracks,
  clipLayouts,
  audioLayouts,
  textItems,
  totalDuration,
  contentWidth,
  contentHeight,
  tracksTemplate,
  pixelsPerSecond,
  selectedClipId,
  selectedAudioId,
  selectedTextId,
  draggedClipId,
  draggedAudioId,
  draggedTextId,
  playheadDragging,
  onTracksPointerDown,
  onPlayheadPointerDown,
  onTrackContextMenu,
  onTextTrackContextMenu,
  onVideoPointerDown,
  onVideoContextMenu,
  onVideoTrimPointerDown,
  onAudioPointerDown,
  onAudioContextMenu,
  onTextPointerDown,
  onTextContextMenu,
}: MergeTimelineProps) {
  const dragPreviewValue = useTimelineDragPreview(dragPreview)
  const [viewport, setViewport] = useState({ left: 0, width: 0 })

  const measureViewport = useCallback(() => {
    const node = timelineScrollRef.current
    if (!node) return
    setViewport((current) => {
      const next = { left: node.scrollLeft, width: node.clientWidth }
      return current.left === next.left && current.width === next.width ? current : next
    })
  }, [timelineScrollRef])

  useEffect(() => {
    const node = timelineScrollRef.current
    if (!node) return undefined
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        measureViewport()
      })
    }
    node.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    schedule()
    return () => {
      node.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [measureViewport, timelineScrollRef])

  const visibleRange = useMemo(() => {
    return timelineVisibleRange(viewport.left, viewport.width, totalDuration, pixelsPerSecond, overscanPixels)
  }, [pixelsPerSecond, totalDuration, viewport.left, viewport.width])
  const isVisible = useCallback((start: number, end: number) => (
    end >= visibleRange.start && start <= visibleRange.end
  ), [visibleRange.end, visibleRange.start])

  const visibleClips = useMemo(() => timelineLayoutsInRange(clipLayouts, visibleRange), [clipLayouts, visibleRange])
  const visibleAudio = useMemo(() => timelineLayoutsInRange(audioLayouts, visibleRange), [audioLayouts, visibleRange])
  const visibleText = useMemo(() => textItems.filter((item) => isVisible(item.startTime, item.startTime + item.duration)), [isVisible, textItems])
  const clipByTrack = useMemo(() => groupByTrack(visibleClips), [visibleClips])
  const audioByTrack = useMemo(() => groupByTrack(visibleAudio), [visibleAudio])
  const textByTrack = useMemo(() => {
    const grouped = new Map<string, MergeTextItem[]>()
    visibleText.forEach((item) => {
      const values = grouped.get(item.trackId)
      if (values) values.push(item)
      else grouped.set(item.trackId, [item])
    })
    return grouped
  }, [visibleText])

  return (
    <div className="timeline-workspace">
      <div className="timeline-track-labels">
        <span><Clock3 />时间线</span>
        <div className="timeline-track-label-list" style={{ gridTemplateRows: tracksTemplate }}>
          {videoTracks.map((track) => (
            <button type="button" key={track.id} title="右键新建视频线" onContextMenu={(event) => onTrackContextMenu(event, 'video', track.id)}>
              <Film />{track.name}
            </button>
          ))}
          {audioTracks.map((track) => (
            <button type="button" key={track.id} title="右键新建音频线" onContextMenu={(event) => onTrackContextMenu(event, 'audio', track.id)}>
              <Music2 />{track.name}
            </button>
          ))}
          {textTracks.map((track) => (
            <button type="button" key={track.id} title="右键新建或管理文本线" onContextMenu={(event) => onTextTrackContextMenu(event, track.id)}>
              <Type />{track.name}
            </button>
          ))}
        </div>
      </div>
      <div ref={timelineScrollRef} className="timeline-scroll-viewport">
        <div ref={timelineRef} className="timeline-scroll-content" style={{ width: contentWidth, minWidth: '100%', minHeight: contentHeight }}>
          <div className="timeline-ruler">
            {timeTicks(totalDuration, totalDuration * pixelsPerSecond).map((tick) => (
              <time key={tick} style={{ left: timelinePixel(tick, pixelsPerSecond) }}>{formatTick(tick)}</time>
            ))}
          </div>
          <div className="timeline-tracks" style={{ gridTemplateRows: tracksTemplate }} onPointerDown={onTracksPointerDown}>
            {videoTracks.map((track) => {
              const layouts = clipByTrack.get(track.id) ?? []
              return (
                <div className="timeline-video-track" key={track.id} data-track-id={track.id} data-track-kind="video" onContextMenu={(event) => {
                  if ((event.target as Element).closest('.timeline-video-clip')) return
                  event.preventDefault()
                  onTrackContextMenu(event, 'video', track.id)
                }}>
                  {layouts.map((layout) => (
                    <button type="button" key={layout.item.id} className={['timeline-video-clip', selectedClipId === layout.item.id ? 'selected' : '', draggedClipId === layout.item.id ? 'long-press-dragging' : ''].filter(Boolean).join(' ')} style={{ left: timelinePixel(dragPreviewValue?.kind === 'video' && dragPreviewValue.id === layout.item.id ? dragPreviewValue.start : layout.start, pixelsPerSecond), width: timelineLength(dragPreviewValue?.kind === 'video' && dragPreviewValue.id === layout.item.id && dragPreviewValue.duration !== undefined ? dragPreviewValue.duration : layout.duration, pixelsPerSecond) }} title={`${layout.item.name}\n${formatPreciseTime(layout.duration)}\n短按或拖动定位播放头`} onPointerDown={(event) => onVideoPointerDown(event, layout)} onContextMenu={(event) => onVideoContextMenu(event, layout)}>
                      <span className="timeline-clip-trim-handle start" aria-hidden="true" onPointerDown={(event) => onVideoTrimPointerDown(event, layout, 'start')} />
                      <span className="timeline-clip-grip" aria-hidden="true"><GripVertical /></span>
                      <span>{layout.item.name}</span>
                      {layout.item.rotation !== 0 && <RotateCw className="timeline-transform-icon" aria-label={`右旋 ${layout.item.rotation} 度`} />}
                      {layout.item.cropEnabled && <SquareDashedMousePointer className="timeline-transform-icon" aria-label="该片段已裁剪" />}
                      {layout.item.muted && <VolumeX className="timeline-muted-icon" aria-label="该片段已静音" />}
                      <small>{formatPreciseTime(layout.duration)}</small>
                      <span className="timeline-clip-trim-handle end" aria-hidden="true" onPointerDown={(event) => onVideoTrimPointerDown(event, layout, 'end')} />
                    </button>
                  ))}
                </div>
              )
            })}
            {audioTracks.map((track) => {
              const layouts = audioByTrack.get(track.id) ?? []
              const trackIsEmpty = audioLayouts.every((layout) => layout.trackId !== track.id)
              return (
                <div className={`timeline-audio-track ${trackIsEmpty ? 'empty' : ''}`} key={track.id} data-track-id={track.id} data-track-kind="audio" onContextMenu={(event) => {
                  if ((event.target as Element).closest('.timeline-audio-clip')) return
                  event.preventDefault()
                  onTrackContextMenu(event, 'audio', track.id)
                }}>
                  {trackIsEmpty && <span className="timeline-empty-hint">拖入音频，或右键视频片段提取音频</span>}
                  {layouts.map((layout) => (
                    <button type="button" key={layout.item.id} className={['timeline-audio-clip', selectedAudioId === layout.item.id ? 'selected' : '', draggedAudioId === layout.item.id ? 'long-press-dragging' : ''].filter(Boolean).join(' ')} style={{ left: timelinePixel(dragPreviewValue?.kind === 'audio' && dragPreviewValue.id === layout.item.id ? dragPreviewValue.start : layout.start, pixelsPerSecond), width: timelineLength(layout.duration, pixelsPerSecond) }} title={`${layout.item.name}\n长按后拖动可调整时间线位置`} onPointerDown={(event) => onAudioPointerDown(event, layout)} onContextMenu={(event) => onAudioContextMenu(event, layout)}>
                      <Music2 /><span>{layout.item.name}</span>
                    </button>
                  ))}
                </div>
              )
            })}
            {textTracks.map((track) => {
              const items = textByTrack.get(track.id) ?? []
              const trackIsEmpty = textItems.every((item) => item.trackId !== track.id)
              return (
                <div className={`timeline-text-track ${trackIsEmpty ? 'empty' : ''}`} key={track.id} data-track-id={track.id} data-track-kind="text" onContextMenu={(event) => {
                  if ((event.target as Element).closest('.timeline-text-clip')) return
                  event.preventDefault()
                  onTextTrackContextMenu(event, track.id)
                }}>
                  {trackIsEmpty && <span className="timeline-empty-hint">右键添加文本片段</span>}
                  {items.map((item) => (
                    <button type="button" key={item.id} className={['timeline-text-clip', selectedTextId === item.id ? 'selected' : '', draggedTextId === item.id ? 'long-press-dragging' : ''].filter(Boolean).join(' ')} style={{ left: timelinePixel(dragPreviewValue?.kind === 'text' && dragPreviewValue.id === item.id ? dragPreviewValue.start : item.startTime, pixelsPerSecond), width: timelineLength(item.duration, pixelsPerSecond) }} title={`${item.text}\n长按后拖动可调整时间线位置`} onPointerDown={(event) => onTextPointerDown(event, item)} onContextMenu={(event) => onTextContextMenu(event, item)}>
                      <Type /><span>{item.text}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          {totalDuration > 0 && <MergeTimelinePlayhead clock={clock} pixelsPerSecond={pixelsPerSecond} dragging={playheadDragging} onPointerDown={onPlayheadPointerDown} />}
        </div>
      </div>
    </div>
  )
})

function groupByTrack<T extends { trackId: string }>(layouts: T[]) {
  const grouped = new Map<string, T[]>()
  layouts.forEach((layout) => {
    const values = grouped.get(layout.trackId)
    if (values) values.push(layout)
    else grouped.set(layout.trackId, [layout])
  })
  return grouped
}
