import type { PointerEvent as ReactPointerEvent } from 'react'
import { Minus, Pause, Play, Plus, RotateCcw, SkipBack } from 'lucide-react'
import { Translated } from '@/i18n/Translated'
import { PlaybackClock, usePlaybackTime } from './PlaybackClock'

interface MergePlaybackControlsProps {
  playing: boolean
  totalDuration: number
  previewStart: number | null
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNudge: (direction: -1 | 1) => void
}

export function MergePlaybackControls({
  playing,
  totalDuration,
  previewStart,
  onSeek,
  onTogglePlayback,
  onNudge,
}: MergePlaybackControlsProps) {
  return (
    <Translated>
    <div className="editor-player-controls">
      <button type="button" title="回到时间线起点" onClick={() => onSeek(0)}><SkipBack /></button>
      <button className="primary" type="button" title={playing ? '暂停' : '播放'} onClick={onTogglePlayback}>
        {playing ? <Pause /> : <Play />}
      </button>
      <button
        type="button"
        title="回到当前片段起点"
        disabled={previewStart === null}
        onClick={() => previewStart !== null && onSeek(previewStart)}
      >
        <RotateCcw />
      </button>
      <button type="button" title="后退一帧" disabled={totalDuration <= 0} onClick={() => onNudge(-1)}>
        <Minus />
      </button>
      <button type="button" title="前进一帧" disabled={totalDuration <= 0} onClick={() => onNudge(1)}>
        <Plus />
      </button>
    </div>
    </Translated>
  )
}

interface MergeTimelinePlayheadProps {
  clock: PlaybackClock
  pixelsPerSecond: number
  dragging: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

export function MergeTimelinePlayhead({
  clock,
  pixelsPerSecond,
  dragging,
  onPointerDown,
}: MergeTimelinePlayheadProps) {
  const playhead = usePlaybackTime(clock)

  return (
    <Translated>
    <div
      className={`timeline-playhead ${dragging ? 'dragging' : ''}`}
      style={{ left: `${Math.max(0, playhead * pixelsPerSecond)}px` }}
    >
      <button
        type="button"
        className="timeline-playhead-handle"
        aria-label="长按并拖动播放头"
        title="长按倒三角后拖动播放位置"
        onPointerDown={onPointerDown}
      >
        <i />
      </button>
    </div>
    </Translated>
  )
}
