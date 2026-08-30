import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Film, RotateCcw } from 'lucide-react'

import { localFileSrc, type VideoMetadata } from '@/services/backend'
import type {
  MergeQueueItem,
  MergeSettings,
  MergeTextItem,
} from '@/stores/mergeStore'
import { MergeCropMasks } from './MergeCropMasks'
import { MergePlaybackControls } from './MergePlaybackControls'
import { PreviewEditDraft, usePreviewEditDraft } from './PreviewEditDraft'
import { PlaybackClock } from './PlaybackClock'
import { clamp, normalizePath } from './mergeFormat'
import {
  boundingLayoutRect,
  cropRectFromClip,
  cropSelectionStyle,
  previewExportVideoStyle,
  type CropGeometry,
  type CropHandle,
  type PreviewCanvasGeometry,
} from './previewGeometry'
import type { ClipLayout } from './timelineModel'

interface MutableRef<T> {
  current: T
}

interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

interface MergePreviewCanvasProps {
  previewScreenRef: MutableRef<HTMLDivElement | null>
  outputCanvasRef: MutableRef<HTMLDivElement | null>
  previewRef: MutableRef<HTMLVideoElement | null>
  editDraft: PreviewEditDraft
  previewVideoRefs: MutableRef<Map<string, HTMLVideoElement>>
  outputCanvasGeometry: PreviewCanvasGeometry | null
  settings: Pick<MergeSettings, 'canvasBackground' | 'fitMode' | 'height' | 'width' | 'fps'>
  previewLayouts: ClipLayout[]
  previewCells: PreviewCanvasGeometry[]
  metadata: Record<string, VideoMetadata>
  effectiveSelectedClipId: string
  activeLayoutCount: number
  previewClip: MergeQueueItem | null
  activeTextItems: MergeTextItem[]
  selectedTextId: string
  groupEditing: boolean
  activeGroupPixelRect: PixelRect | null
  cropEditing: boolean
  cropGeometry: CropGeometry | null
  playing: boolean
  totalDuration: number
  clock: PlaybackClock
  suspendMedia?: boolean
  previewStart: number | null
  resolutionPreview?: { path: string; start: number; duration: number } | null
  resolutionPreviewMode?: 'live' | 'computed'
  resolutionPreviewCalculating?: boolean
  onOpenResolutionPreview?: () => void
  onResolutionPreviewModeChange?: (mode: 'live' | 'computed') => void
  onPreviewLayoutPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    layout: ClipLayout,
    layoutIndex: number,
  ) => void
  onPreviewTextPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    item: MergeTextItem,
  ) => void
  onPreviewTextResizePointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: MergeTextItem,
    handle: CropHandle,
  ) => void
  onPreviewTextContextMenu: (event: React.MouseEvent<HTMLDivElement>, item: MergeTextItem) => void
  onGroupLayoutPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    handle: CropHandle,
  ) => void
  onCropPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    handle: CropHandle,
  ) => void
  onResetCropSelection: () => void
  onPreviewMetadataLoaded: () => void
  onPreviewVideoReady: (layout: ClipLayout, video: HTMLVideoElement) => void
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNudge: (direction: -1 | 1) => void
  onFullscreenError?: (message: string) => void
}

const resizeHandles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function MergePreviewCanvas({
  previewScreenRef,
  outputCanvasRef,
  previewRef,
  editDraft,
  previewVideoRefs,
  outputCanvasGeometry,
  settings,
  previewLayouts,
  previewCells,
  metadata,
  effectiveSelectedClipId,
  activeLayoutCount,
  previewClip,
  activeTextItems,
  selectedTextId,
  groupEditing,
  activeGroupPixelRect,
  cropEditing,
  cropGeometry,
  playing,
  totalDuration,
  clock,
  suspendMedia = false,
  previewStart,
  resolutionPreview = null,
  resolutionPreviewMode = 'live',
  resolutionPreviewCalculating = false,
  onOpenResolutionPreview,
  onResolutionPreviewModeChange,
  onPreviewLayoutPointerDown,
  onPreviewTextPointerDown,
  onPreviewTextResizePointerDown,
  onPreviewTextContextMenu,
  onGroupLayoutPointerDown,
  onCropPointerDown,
  onResetCropSelection,
  onPreviewMetadataLoaded,
  onPreviewVideoReady,
  onSeek,
  onTogglePlayback,
  onNudge,
  onFullscreenError,
}: MergePreviewCanvasProps) {
  const fullscreenRef = useRef<HTMLDivElement | null>(null)
  const previewStageRef = useRef<HTMLDivElement | null>(null)
  const computedPreviewRef = useRef<HTMLVideoElement | null>(null)
  const fallbackFullscreenRef = useRef(false)
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false)
  const [computedPreviewPlaying, setComputedPreviewPlaying] = useState(false)
  const [computedPreviewTime, setComputedPreviewTime] = useState(0)
  const draft = usePreviewEditDraft(editDraft)
  useEffect(() => {
    const stage = previewStageRef.current
    if (!stage) return undefined
    const measure = () => setPreviewStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    measure()
    return () => observer.disconnect()
  }, [])
  const previewFrameSize = useMemo(() => {
    const availableWidth = previewStageSize.width
    const availableHeight = previewStageSize.height
    if (availableWidth <= 0 || availableHeight <= 0) return null
    const outputRatio = Math.max(0.01, settings.width / Math.max(1, settings.height))
    return availableWidth / availableHeight > outputRatio
      ? { width: availableHeight * outputRatio, height: availableHeight }
      : { width: availableWidth, height: availableWidth / outputRatio }
  }, [previewStageSize.height, previewStageSize.width, settings.height, settings.width])
  useEffect(() => {
    if (!previewFrameSize) return undefined
    const frame = window.requestAnimationFrame(onPreviewMetadataLoaded)
    return () => window.cancelAnimationFrame(frame)
  }, [onPreviewMetadataLoaded, previewFrameSize])

  useEffect(() => {
    const target = fullscreenRef.current
    if (!target) return undefined
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === target
      if (active) {
        fallbackFullscreenRef.current = false
        setFallbackFullscreen(false)
      }
      setIsFullscreen(active || fallbackFullscreenRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    onFullscreenChange()
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    if (!fallbackFullscreen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      fallbackFullscreenRef.current = false
      setFallbackFullscreen(false)
      setIsFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fallbackFullscreen])

  const toggleFullscreen = async () => {
    const target = fullscreenRef.current
    if (!target) return
    if (fallbackFullscreen) {
      fallbackFullscreenRef.current = false
      setFallbackFullscreen(false)
      setIsFullscreen(false)
      return
    }
    if (document.fullscreenElement === target) {
      try {
        await document.exitFullscreen()
      } catch {
        setFallbackFullscreen(false)
        setIsFullscreen(false)
      }
      return
    }
    try {
      if (typeof target.requestFullscreen !== 'function') throw new Error('Fullscreen API unavailable')
      await target.requestFullscreen()
    } catch {
      // Tauri/WebView builds may deny the standard API.  A fixed overlay keeps
      // the interaction usable and, unlike a stale fullscreen flag, is fully
      // reversible with the same button.
      fallbackFullscreenRef.current = true
      setFallbackFullscreen(true)
      setIsFullscreen(true)
      onFullscreenError?.('系统全屏不可用，已切换到窗口内全屏预览。')
    }
  }

  useEffect(() => {
    const computed = computedPreviewRef.current
    if (!computed) return
    if (resolutionPreviewMode === 'computed') {
      previewVideoRefs.current.forEach((video) => video.pause())
      if (computed.readyState >= 1) {
        computed.currentTime = Math.min(computed.currentTime, Math.max(0, (resolutionPreview?.duration ?? 0) - 0.01))
      }
    } else {
      computed.pause()
    }
  }, [previewVideoRefs, resolutionPreview?.duration, resolutionPreviewMode])
  const computedOnToggle = () => {
    const computed = computedPreviewRef.current
    if (!computed || !resolutionPreview) return
    if (computed.paused) {
      if (computed.currentTime >= Math.max(0, resolutionPreview.duration - 0.02)) computed.currentTime = 0
      void computed.play().then(() => setComputedPreviewPlaying(true)).catch(() => setComputedPreviewPlaying(false))
    } else {
      computed.pause()
      setComputedPreviewPlaying(false)
    }
  }
  const computedOnSeek = (time: number) => {
    const computed = computedPreviewRef.current
    if (!computed || !resolutionPreview) return
    const next = clamp(time, 0, resolutionPreview.duration)
    if (computed.readyState < 1) return
    computed.currentTime = next
    setComputedPreviewTime(next)
  }
  const draftGroup = draft?.layout && outputCanvasGeometry
    ? boundingLayoutRect(previewLayouts.map((layout, index) => draft.layout?.[layout.item.id] ?? {
      x: (previewCells[index]?.left ?? 0) / Math.max(1, outputCanvasGeometry.width),
      y: (previewCells[index]?.top ?? 0) / Math.max(1, outputCanvasGeometry.height),
      width: (previewCells[index]?.width ?? 0) / Math.max(1, outputCanvasGeometry.width),
      height: (previewCells[index]?.height ?? 0) / Math.max(1, outputCanvasGeometry.height),
    }))
    : null
  const displayedGroupPixelRect = draftGroup && outputCanvasGeometry ? {
    left: draftGroup.x * outputCanvasGeometry.width,
    top: draftGroup.y * outputCanvasGeometry.height,
    width: draftGroup.width * outputCanvasGeometry.width,
    height: draftGroup.height * outputCanvasGeometry.height,
  } : activeGroupPixelRect
  return (
    <div ref={fullscreenRef} className={`editor-preview-fullscreen-shell ${fallbackFullscreen ? 'is-fullscreen-fallback' : ''}`}>
      <div
        ref={previewStageRef}
        className="editor-preview-stage"
      >
        <div
          ref={previewScreenRef}
          className={`frame-image-box video-box editor-preview-screen ${cropEditing ? 'crop-editing' : ''}`}
          style={previewFrameSize ? { width: previewFrameSize.width, height: previewFrameSize.height, minHeight: 0 } : undefined}
        >
        <div
          ref={outputCanvasRef}
          className="editor-output-canvas"
          style={outputCanvasGeometry ? {
            left: outputCanvasGeometry.left,
            top: outputCanvasGeometry.top,
            right: 'auto',
            bottom: 'auto',
            width: outputCanvasGeometry.width,
            height: outputCanvasGeometry.height,
            background: settings.canvasBackground === 'white' ? '#fff' : '#000',
          } : undefined}
        >
          {previewLayouts.length > 0 ? previewLayouts.map((layout, index) => {
            const info = metadata[normalizePath(layout.item.path)]
            const cell = previewCells[index]
            const layoutDraft = draft?.layout?.[layout.item.id]
            const displayedCell = cell && layoutDraft && outputCanvasGeometry ? {
              left: layoutDraft.x * outputCanvasGeometry.width,
              top: layoutDraft.y * outputCanvasGeometry.height,
              width: layoutDraft.width * outputCanvasGeometry.width,
              height: layoutDraft.height * outputCanvasGeometry.height,
            } : cell
            const localCell = displayedCell
              ? { left: 0, top: 0, width: displayedCell.width, height: displayedCell.height }
              : undefined
            return (
              <div
                className={[
                  'editor-preview-item',
                  effectiveSelectedClipId === layout.item.id ? 'selected' : '',
                  activeLayoutCount > 1 && !cropEditing ? 'draggable' : '',
                ].filter(Boolean).join(' ')}
                key={layout.item.id}
                title={activeLayoutCount > 1
                  ? `${layout.item.name}：拖动可调整画面位置`
                  : layout.item.name}
                style={displayedCell ? {
                  left: displayedCell.left,
                  top: displayedCell.top,
                  width: displayedCell.width,
                  height: displayedCell.height,
                } : undefined}
                onPointerDown={(event) => onPreviewLayoutPointerDown(event, layout, index)}
              >
                {!suspendMedia && <video
                  ref={(node) => {
                    if (node) {
                      previewVideoRefs.current.set(layout.item.id, node)
                      if (layout.item.id === previewClip?.id) previewRef.current = node
                    } else {
                      previewVideoRefs.current.delete(layout.item.id)
                      if (previewRef.current?.dataset.clipId === layout.item.id) previewRef.current = null
                    }
                  }}
                  data-clip-id={layout.item.id}
                  src={localFileSrc(layout.item.path)}
                  crossOrigin="anonymous"
                  style={previewExportVideoStyle(
                    layout.item,
                    info?.width ?? 0,
                    info?.height ?? 0,
                    localCell,
                    settings.fitMode,
                    cropEditing,
                  )}
                  muted={layout.item.muted}
                  preload="metadata"
                  playsInline
                  onLoadedMetadata={() => {
                    if (layout.item.id === previewClip?.id) onPreviewMetadataLoaded()
                    const video = previewVideoRefs.current.get(layout.item.id)
                    if (video) onPreviewVideoReady(layout, video)
                  }}
                >
                  <track kind="captions" />
                </video>}
              </div>
            )
          }) : (
            <div className="editor-preview-empty">
              <Film />
              <strong>将视频拖入窗口或点击“添加视频”</strong>
            </div>
          )}

          {outputCanvasGeometry && activeTextItems.map((item) => {
            const textDraft = draft?.text?.[item.id]
            const textFontSize = textDraft?.fontSize ?? item.fontSize
            return (
              <div
                key={item.id}
                className={`editor-preview-text ${selectedTextId === item.id ? 'selected' : ''}`}
                style={{
                  left: (textDraft?.x ?? item.x) * outputCanvasGeometry.width,
                  top: (textDraft?.y ?? item.y) * outputCanvasGeometry.height,
                  fontSize: clamp(
                    textFontSize / Math.max(1, settings.width) * outputCanvasGeometry.width,
                    10,
                    240,
                  ),
                  color: item.color,
                  backgroundColor: item.backgroundColor,
                }}
                title="拖动调整文本位置，右键打开属性编辑内容和样式"
                onPointerDown={(event) => onPreviewTextPointerDown(event, item)}
                onContextMenu={(event) => onPreviewTextContextMenu(event, item)}
              >
                {item.text}
                {selectedTextId === item.id && resizeHandles.map((handle) => (
                  <button
                    type="button"
                    key={handle}
                    className={`editor-preview-text-resize-handle ${handle}`}
                    aria-label={`调整文本大小 ${handle}`}
                    onPointerDown={(event) => onPreviewTextResizePointerDown(event, item, handle)}
                  />
                ))}
              </div>
            )
          })}

          {suspendMedia && previewLayouts.length > 0 && (
            <div className="editor-preview-suspended" role="status">
              <Film />
              <strong>正在后台处理视频</strong>
              <span>预览解码已暂停，以释放内存和处理器资源</span>
            </div>
          )}

          {groupEditing && !cropEditing && displayedGroupPixelRect && (
            <div
              className="editor-group-selection"
              style={displayedGroupPixelRect}
              onPointerDown={(event) => onGroupLayoutPointerDown(event, 'move')}
            >
              <span>组合画面</span>
              {resizeHandles.map((handle) => (
                <button
                  type="button"
                  key={handle}
                  className={`editor-group-handle ${handle}`}
                  aria-label={`调整组合画面 ${handle}`}
                  onPointerDown={(event) => onGroupLayoutPointerDown(event, handle)}
                />
              ))}
            </div>
          )}

          {previewClip && cropEditing && cropGeometry && (
            <div
              className="video-crop-layer editing"
              style={{
                left: cropGeometry.left,
                top: cropGeometry.top,
                width: cropGeometry.width,
                height: cropGeometry.height,
              }}
              onPointerDown={(event) => onCropPointerDown(event, 'draw')}
            >
              <MergeCropMasks
                rect={draft?.crop?.id === previewClip.id ? draft.crop.rect : cropRectFromClip(previewClip, cropGeometry)}
                geometry={cropGeometry}
              />
              <div
                className="video-crop-selection"
                style={cropSelectionStyle(draft?.crop?.id === previewClip.id ? draft.crop.rect : cropRectFromClip(previewClip, cropGeometry), cropGeometry)}
                onPointerDown={(event) => onCropPointerDown(event, 'move')}
              >
                <span>导出区域</span>
                {resizeHandles.map((handle) => (
                  <button
                    type="button"
                    key={handle}
                    className={`video-crop-handle ${handle}`}
                    aria-label={`调整选区 ${handle}`}
                    onPointerDown={(event) => onCropPointerDown(event, handle)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {resolutionPreviewMode === 'computed' && resolutionPreview && outputCanvasGeometry && (
          <>
            <video
              ref={computedPreviewRef}
              className="editor-preview-computed-video"
              src={localFileSrc(resolutionPreview.path)}
              aria-label={`已计算真实分辨率预览，时长 ${resolutionPreview.duration.toFixed(1)} 秒`}
              style={{ left: 0, top: 0, width: outputCanvasGeometry.width, height: outputCanvasGeometry.height }}
              preload="auto"
              playsInline
              onPlay={() => setComputedPreviewPlaying(true)}
              onPause={() => setComputedPreviewPlaying(false)}
              onTimeUpdate={(event) => setComputedPreviewTime(event.currentTarget.currentTime)}
              onEnded={() => { setComputedPreviewPlaying(false); setComputedPreviewTime(resolutionPreview.duration) }}
            />
            <span className="editor-preview-computed-label">已计算预览 · {settings.width} × {settings.height} · {resolutionPreview.duration.toFixed(1)} 秒</span>
          </>
        )}

        {previewClip && cropEditing && (
          <button
            type="button"
            className="video-crop-reset-button"
            title="将裁剪框恢复到完整视频画面"
            onClick={onResetCropSelection}
          >
            <RotateCcw />重置裁剪框
          </button>
        )}
        </div>
      </div>

      <MergePlaybackControls
        clock={clock}
        playing={resolutionPreviewMode === 'computed' ? computedPreviewPlaying : playing}
        totalDuration={resolutionPreviewMode === 'computed' && resolutionPreview ? resolutionPreview.duration : totalDuration}
        currentTime={resolutionPreviewMode === 'computed' ? computedPreviewTime : undefined}
        previewStart={resolutionPreviewMode === 'computed' ? 0 : previewStart}
        onSeek={resolutionPreviewMode === 'computed' ? computedOnSeek : onSeek}
        onTogglePlayback={resolutionPreviewMode === 'computed' ? computedOnToggle : onTogglePlayback}
        onNudge={resolutionPreviewMode === 'computed' ? ((direction) => computedOnSeek(computedPreviewTime + direction / Math.max(1, settings.fps || 30))) : onNudge}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => void toggleFullscreen()}
        resolutionPreviewCalculating={resolutionPreviewCalculating}
        resolutionPreviewReady={Boolean(resolutionPreview)}
        resolutionPreviewMode={resolutionPreviewMode}
        onOpenResolutionPreview={onOpenResolutionPreview}
        onResolutionPreviewModeChange={onResolutionPreviewModeChange}
      />
    </div>
  )
}
