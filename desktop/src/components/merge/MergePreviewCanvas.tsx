import type { PointerEvent as ReactPointerEvent } from 'react'
import { Film, RotateCcw } from 'lucide-react'

import { localFileSrc, type VideoMetadata } from '@/services/backend'
import type {
  MergeQueueItem,
  MergeSettings,
  MergeTextItem,
} from '@/stores/mergeStore'
import { MergeCropMasks } from './MergeCropMasks'
import { MergePlaybackControls } from './MergePlaybackControls'
import type { PlaybackClock } from './PlaybackClock'
import { clamp, formatPreciseTime, normalizePath } from './mergeFormat'
import {
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

interface PreviewSize {
  width: number
  height: number
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
  previewVideoRefs: MutableRef<Map<string, HTMLVideoElement>>
  previewSize: PreviewSize
  outputCanvasGeometry: PreviewCanvasGeometry | null
  settings: Pick<MergeSettings, 'canvasBackground' | 'fitMode' | 'width'>
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
  playbackClock: PlaybackClock
  playing: boolean
  totalDuration: number
  previewStart: number | null
  previewDuration: number
  onPreviewLayoutPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    layout: ClipLayout,
    layoutIndex: number,
  ) => void
  onPreviewTextPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    item: MergeTextItem,
  ) => void
  onEditText: (item: MergeTextItem) => void
  onGroupLayoutPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    handle: CropHandle,
  ) => void
  onCropPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    handle: CropHandle,
  ) => void
  onResetCropSelection: () => void
  onResetPreviewSize: () => void
  onPreviewResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPreviewMetadataLoaded: () => void
  onSeek: (time: number) => void
  onTogglePlayback: () => void
  onNudge: (direction: -1 | 1) => void
}

const resizeHandles: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function MergePreviewCanvas({
  previewScreenRef,
  outputCanvasRef,
  previewRef,
  previewVideoRefs,
  previewSize,
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
  playbackClock,
  playing,
  totalDuration,
  previewStart,
  previewDuration,
  onPreviewLayoutPointerDown,
  onPreviewTextPointerDown,
  onEditText,
  onGroupLayoutPointerDown,
  onCropPointerDown,
  onResetCropSelection,
  onResetPreviewSize,
  onPreviewResizePointerDown,
  onPreviewMetadataLoaded,
  onSeek,
  onTogglePlayback,
  onNudge,
}: MergePreviewCanvasProps) {
  return (
    <>
      <div
        ref={previewScreenRef}
        className={`frame-image-box video-box editor-preview-screen ${cropEditing ? 'crop-editing' : ''}`}
        style={{ height: previewSize.height }}
      >
        <div
          ref={outputCanvasRef}
          className="editor-output-canvas"
          style={outputCanvasGeometry ? {
            left: outputCanvasGeometry.left,
            top: outputCanvasGeometry.top,
            width: outputCanvasGeometry.width,
            height: outputCanvasGeometry.height,
            background: settings.canvasBackground === 'white' ? '#fff' : '#000',
          } : undefined}
        >
          {previewLayouts.length > 0 ? previewLayouts.map((layout, index) => {
            const info = metadata[normalizePath(layout.item.path)]
            const cell = previewCells[index]
            const localCell = cell
              ? { left: 0, top: 0, width: cell.width, height: cell.height }
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
                style={cell ? {
                  left: cell.left,
                  top: cell.top,
                  width: cell.width,
                  height: cell.height,
                } : undefined}
                onPointerDown={(event) => onPreviewLayoutPointerDown(event, layout, index)}
              >
                <video
                  ref={(node) => {
                    if (node) {
                      previewVideoRefs.current.set(layout.item.id, node)
                      if (layout.item.id === previewClip?.id) previewRef.current = node
                    } else {
                      previewVideoRefs.current.delete(layout.item.id)
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
                  preload="auto"
                  playsInline
                  onLoadedMetadata={() => {
                    if (layout.item.id === previewClip?.id) onPreviewMetadataLoaded()
                  }}
                >
                  <track kind="captions" />
                </video>
              </div>
            )
          }) : (
            <div className="editor-preview-empty">
              <Film />
              <strong>将视频拖入窗口或点击“添加视频”</strong>
            </div>
          )}

          {outputCanvasGeometry && activeTextItems.map((item) => (
            <div
              key={item.id}
              className={`editor-preview-text ${selectedTextId === item.id ? 'selected' : ''}`}
              style={{
                left: item.x * outputCanvasGeometry.width,
                top: item.y * outputCanvasGeometry.height,
                fontSize: clamp(
                  item.fontSize / Math.max(1, settings.width) * outputCanvasGeometry.width,
                  10,
                  80,
                ),
                color: item.color,
                backgroundColor: item.backgroundColor,
              }}
              title="拖动调整文本位置，双击修改文本"
              onPointerDown={(event) => onPreviewTextPointerDown(event, item)}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onEditText(item)
              }}
            >
              {item.text}
            </div>
          ))}

          {groupEditing && !cropEditing && activeGroupPixelRect && (
            <div
              className="editor-group-selection"
              style={activeGroupPixelRect}
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
                rect={cropRectFromClip(previewClip, cropGeometry)}
                geometry={cropGeometry}
              />
              <div
                className="video-crop-selection"
                style={cropSelectionStyle(cropRectFromClip(previewClip, cropGeometry), cropGeometry)}
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
        <div className="editor-preview-size-tools">
          <button type="button" title="还原播放窗口默认尺寸" onClick={onResetPreviewSize}>
            <RotateCcw />还原窗口
          </button>
        </div>
        <button
          type="button"
          className="editor-preview-resize-handle"
          aria-label="拖动调整播放窗口尺寸"
          title="按住鼠标左键拖动调整播放窗口尺寸"
          onPointerDown={onPreviewResizePointerDown}
        />
      </div>

      <MergePlaybackControls
        clock={playbackClock}
        playing={playing}
        totalDuration={totalDuration}
        previewStart={previewStart}
        previewDuration={previewDuration}
        formatTime={formatPreciseTime}
        onSeek={onSeek}
        onTogglePlayback={onTogglePlayback}
        onNudge={onNudge}
      />
    </>
  )
}
