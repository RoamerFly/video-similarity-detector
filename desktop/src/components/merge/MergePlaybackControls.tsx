import type { PointerEvent as ReactPointerEvent } from 'react'
import { Minus, Pause, Play, Plus, RotateCcw, SkipBack } from 'lucide-react'
import { Translated } from '@/i18n/Translated'
import { PlaybackClock, usePlaybackTime } from './PlaybackClock'

interface MergePlaybackControlsProps {
  clock: PlaybackClock
  playing: boolean
  totalDuration: number
  previewStart: number | null
  previewDuration: number
  formatTime: (seconds: number) => string
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNudge: (direction: -1 | 1) => void
}

export function MergePlaybackControls({
  clock,
  playing,
  totalDuration,
  previewStart,
  previewDuration,
  formatTime,
  onSeek,
  onTogglePlayback,
  onNudge,
}: MergePlaybackControlsProps) {
  const playhead = usePlaybackTime(clock)
  const timelineMaximum = Math.max(0.01, totalDuration)
  const clipMaximum = Math.max(0.01, previewDuration)
  const previewLocalTime = previewStart === null
    ? 0
    : Math.min(Math.max(0, playhead - previewStart), previewDuration)

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
      <div style={{ gridColumn: '6 / span 2', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, paddingLeft: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <time title={`片段 ${formatTime(previewLocalTime)} / ${formatTime(previewDuration)}`} style={{ flexBasis: '180px', flexShrink: 0 }}>
            {`片段 ${formatTime(previewLocalTime)} / ${formatTime(previewDuration)}`}
          </time>
          <input
            type="range"
            min={0}
            max={clipMaximum}
            step={0.001}
            value={Math.min(previewLocalTime, clipMaximum)}
            disabled={previewStart === null}
            onChange={(event) => {
              if (previewStart !== null) onSeek(previewStart + Number(event.target.value))
            }}
            title="片段播放进度"
            style={{ flex: 1, minWidth: 0, cursor: previewStart !== null ? 'pointer' : 'default' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <time title={`时间线 ${formatTime(playhead)} / ${formatTime(totalDuration)}`} style={{ flexBasis: '180px', flexShrink: 0 }}>
            <small style={{ fontSize: '12px' }}>{`时间线 ${formatTime(playhead)} / ${formatTime(totalDuration)}`}</small>
          </time>
          <input
            type="range"
            min={0}
            max={timelineMaximum}
            step={0.001}
            value={Math.min(playhead, timelineMaximum)}
            onChange={(event) => onSeek(Number(event.target.value))}
            title="总时间线播放进度"
            style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
          />
        </div>
      </div>
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
