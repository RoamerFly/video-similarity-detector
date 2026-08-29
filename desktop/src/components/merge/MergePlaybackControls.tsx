import type { PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, Minimize2, Minus, Monitor, Pause, Play, Plus, RotateCcw, SkipBack } from 'lucide-react'
import { Translated } from '@/i18n/Translated'
import { PlaybackClock, usePlaybackTime } from './PlaybackClock'

interface MergePlaybackControlsProps {
  clock: PlaybackClock
  playing: boolean
  totalDuration: number
  currentTime?: number
  previewStart: number | null
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNudge: (direction: -1 | 1) => void
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  resolutionPreviewCalculating?: boolean
  resolutionPreviewReady?: boolean
  resolutionPreviewMode?: 'live' | 'computed'
  onOpenResolutionPreview?: () => void
  onResolutionPreviewModeChange?: (mode: 'live' | 'computed') => void
}

export function MergePlaybackControls({
  clock,
  playing,
  totalDuration,
  currentTime,
  previewStart,
  onSeek,
  onTogglePlayback,
  onNudge,
  isFullscreen = false,
  onToggleFullscreen,
  resolutionPreviewCalculating = false,
  resolutionPreviewReady = false,
  resolutionPreviewMode = 'live',
  onOpenResolutionPreview,
  onResolutionPreviewModeChange,
}: MergePlaybackControlsProps) {
  const clockTime = usePlaybackTime(clock)
  const progressTime = Number.isFinite(currentTime) ? (currentTime ?? 0) : clockTime
  return (
    <Translated>
    <div className="editor-player-controls">
      <label className="editor-player-progress">
        <input
          type="range"
          min="0"
          max={Math.max(0, totalDuration)}
          step="0.01"
          value={Math.min(Math.max(0, progressTime), Math.max(0, totalDuration))}
          disabled={totalDuration <= 0}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="播放进度"
        />
      </label>
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
      {onToggleFullscreen && (
        <button type="button" title={isFullscreen ? '退出全屏' : '全屏预览'} aria-label={isFullscreen ? '退出全屏' : '全屏预览'} onClick={onToggleFullscreen}>
          {isFullscreen ? <Minimize2 /> : <Maximize2 />}
        </button>
      )}
      {onOpenResolutionPreview && (
        <button
          type="button"
          className={resolutionPreviewCalculating ? 'resolution-simulation-active' : ''}
          title={resolutionPreviewCalculating ? '正在计算真实分辨率预览' : '模拟真实分辨率清晰度'}
          aria-label={resolutionPreviewCalculating ? '正在计算真实分辨率预览' : '模拟真实分辨率清晰度'}
          disabled={resolutionPreviewCalculating}
          onClick={onOpenResolutionPreview}
        >
          <Monitor />
        </button>
      )}
      {resolutionPreviewReady && onResolutionPreviewModeChange && (
        <div className="resolution-preview-mode-tabs" role="tablist" aria-label="预览来源">
          <button type="button" role="tab" aria-selected={resolutionPreviewMode === 'live'} className={resolutionPreviewMode === 'live' ? 'active' : ''} onClick={() => onResolutionPreviewModeChange('live')}>实时</button>
          <button type="button" role="tab" aria-selected={resolutionPreviewMode === 'computed'} className={resolutionPreviewMode === 'computed' ? 'active' : ''} onClick={() => onResolutionPreviewModeChange('computed')}>已计算</button>
        </div>
      )}
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
