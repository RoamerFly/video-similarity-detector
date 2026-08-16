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
  editDraft: PreviewEditDraft
  previewVideoRefs: MutableRef<Map<string, HTMLVideoElement>>
  previewSize: PreviewSize | null
  outputCanvasGeometry: PreviewCanvasGeometry | null
  settings: Pick<MergeSettings, 'canvasBackground' | 'fitMode' | 'height' | 'width'>
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
  previewStart: number | null
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
  editDraft,
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
  playing,
  totalDuration,
  previewStart,
  onPreviewLayoutPointerDown,
  onPreviewTextPointerDown,
  onEditText,
  onGroupLayoutPointerDown,
  onCropPointerDown,
  onResetCropSelection,
  onPreviewResizePointerDown,
  onPreviewMetadataLoaded,
  onSeek,
  onTogglePlayback,
  onNudge,
}: MergePreviewCanvasProps) {
  const previewStageRef = useRef<HTMLDivElement | null>(null)
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 })
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
    if (previewSize) {
      const requestedHeight = Math.min(availableHeight, Math.max(220, previewSize.height))
      const requestedWidth = requestedHeight * outputRatio
      if (requestedWidth <= availableWidth) return { width: requestedWidth, height: requestedHeight }
      return { width: availableWidth, height: availableWidth / outputRatio }
    }
    return availableWidth / availableHeight > outputRatio
      ? { width: availableHeight * outputRatio, height: availableHeight }
      : { width: availableWidth, height: availableWidth / outputRatio }
  }, [previewSize, previewStageSize.height, previewStageSize.width, settings.height, settings.width])
  useEffect(() => {
    if (!previewFrameSize) return undefined
    const frame = window.requestAnimationFrame(onPreviewMetadataLoaded)
    return () => window.cancelAnimationFrame(frame)
  }, [onPreviewMetadataLoaded, previewFrameSize])
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
    <>
      <div
        ref={previewStageRef}
        className="editor-preview-stage"
        style={previewFrameSize ? {
          width: previewFrameSize.width,
          height: previewFrameSize.height,
        } : undefined}
      >
        <div
          ref={previewScreenRef}
          className={`frame-image-box video-box editor-preview-screen ${cropEditing ? 'crop-editing' : ''}`}
          style={{ width: '100%', height: '100%', minHeight: 0 }}
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
                left: (draft?.text?.[item.id]?.x ?? item.x) * outputCanvasGeometry.width,
                top: (draft?.text?.[item.id]?.y ?? item.y) * outputCanvasGeometry.height,
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
        <button
          type="button"
          className="editor-preview-resize-handle"
          aria-label="拖动调整播放窗口尺寸"
          title="按住鼠标左键拖动调整播放窗口尺寸"
          onPointerDown={onPreviewResizePointerDown}
        />
        </div>
      </div>

      <MergePlaybackControls
        playing={playing}
        totalDuration={totalDuration}
        previewStart={previewStart}
        onSeek={onSeek}
        onTogglePlayback={onTogglePlayback}
        onNudge={onNudge}
      />
    </>
  )
}
