import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CheckCircle2,
  Download,
  FolderOpen,
  Music2,
  Pause,
  PanelRight,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  SquareDashedMousePointer,
  Trash2,
  Type,
  Undo2,
  Upload,
} from 'lucide-react'
import {
  GlassPanel,
  NeonButton,
  ParameterHint,
  SelectInput,
  TextInput,
  Toggle,
} from '@/components/DesignSystem'
import { MergeExportStatus } from '@/components/merge/MergeExportStatus'
import { MergeInspectorPanel } from '@/components/merge/MergeInspectorPanel'
import { MergeNumberField as NumberField } from '@/components/merge/MergeNumberField'
import { MergeTimeline } from '@/components/merge/MergeTimeline'
import {
  MergeTimelineContextMenus,
  type AudioContextMenuState,
  type ClipContextMenuState,
  type TextContextMenuState,
  type TrackContextMenuState,
} from '@/components/merge/MergeTimelineContextMenus'
import { MergeAdvancedSettingsDialog } from '@/components/merge/MergeAdvancedSettingsDialog'
import { MergePreviewCanvas } from '@/components/merge/MergePreviewCanvas'
import { shouldShowOverlapToolbar } from '@/components/merge/mergeToolbarVisibility'
import { timelineLayoutForRows } from '@/components/merge/timelineLayout'
import { requestMediaSeek } from '@/components/merge/MediaSeekCoordinator'
import { PlaybackClock } from '@/components/merge/PlaybackClock'
import { driftCorrection, targetMediaTime } from '@/components/merge/playbackPolicy'
import { layoutPatch, textPositionFromPoint } from '@/components/merge/previewDraftCommit'
import { TimelineDragPreview } from '@/components/merge/TimelineDragPreview'
import { PreviewEditDraft } from '@/components/merge/PreviewEditDraft'
import { usePreviewEditInteractions } from '@/components/merge/usePreviewEditInteractions'
import { useTimelineInteractions } from '@/components/merge/useTimelineInteractions'
import { useEventCallback } from '@/components/merge/useEventCallback'
import { usePlaybackRaf } from '@/components/merge/usePlaybackRaf'
import { useMergeFileDrop } from '@/components/merge/useMergeFileDrop'
import { useMergeMetadata } from '@/components/merge/useMergeMetadata'
import { visibleTracks } from '@/components/merge/trackVisibility'
import {
  clamp,
  extension,
  formatDuration,
  formatPreciseTime,
  normalizePath,
} from '@/components/merge/mergeFormat'
import {
  boundingLayoutRect,
  cropPointFromClient,
  cropRectForDimensions,
  cropRectFromClip,
  evenDimension,
  insetLayoutRects,
  normalizedPoint,
  presetLayoutRects,
  previewLayoutRects,
  resizeCropRect,
  resizeNormalizedRect,
  resolveDraggedLayout,
  rotatedDimensions,
  transformLayoutRects,
  type CropGeometry,
  type CropHandle,
  type PreviewCanvasGeometry,
} from '@/components/merge/previewGeometry'
import { parseSubtitleCues } from '@/components/merge/subtitleParser'
import {
  buildAudioLayouts,
  buildClipLayouts,
  canSplitClipAt,
  clipSourceEnd,
  createTimelinePlaybackIndex,
  findLayoutAt,
  previousTrackLayout,
  timelineTimeFromClientX,
  type ClipLayout,
} from '@/components/merge/timelineModel'
import { Translated } from '@/i18n/Translated'
import {
  cancelVideoMerge,
  fileName,
  localFileSrc,
  normalizeBackendError,
  readTextFile,
  revealInFolder,
  runVideoMerge,
  selectAudioFiles,
  selectOutputDirectory,
  selectSubtitleFiles,
  selectVideoFiles,
} from '@/services/backend'
import {
  useMergeStore,
  type MergeQueueItem,
  type MergeRotation,
  type MergeTextItem,
} from '@/stores/mergeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useShallow } from 'zustand/react/shallow'

const scrubMediaIntervalMs = 32
const defaultPreviewSize = {
  width: 1280,
  height: typeof window === 'undefined' ? 440 : Math.round(Math.min(560, Math.max(260, window.innerHeight * 0.45 - 8))),
}
const minimumOutputDimension = 16
const maximumOutputDimension = 16384
const emptyTimelineResolutionLimit = { width: 3840, height: 2160 }
type WindowWithWebkitAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext
}

function createBrowserAudioContext() {
  const AudioContextConstructor = window.AudioContext
    ?? (window as WindowWithWebkitAudioContext).webkitAudioContext
  return AudioContextConstructor ? new AudioContextConstructor() : null
}

const commonResolutionOptions = [
  { label: '超清 2160p', width: 3840, height: 2160 },
  { label: '高清 1080p', width: 1920, height: 1080 },
  { label: '高清 720p', width: 1280, height: 720 },
  { label: '竖屏 1080p', width: 1080, height: 1920 },
  { label: '方形 1080', width: 1080, height: 1080 },
  { label: '标清 480p', width: 854, height: 480 },
]
export function MergePage() {
  const merge = useMergeStore(useShallow((state) => ({
    addAudio: state.addAudio,
    addAudioFiles: state.addAudioFiles,
    addAudioTrack: state.addAudioTrack,
    addText: state.addText,
    addTextTrack: state.addTextTrack,
    addVideos: state.addVideos,
    addVideoTrack: state.addVideoTrack,
    audioItems: state.audioItems,
    audioTracks: state.audioTracks,
    beginHistoryTransaction: state.beginHistoryTransaction,
    canRedo: state.canRedo,
    canUndo: state.canUndo,
    clearLogs: state.clearLogs,
    duplicateVideo: state.duplicateVideo,
    endHistoryTransaction: state.endHistoryTransaction,
    items: state.items,
    moveVideoTo: state.moveVideoTo,
    redo: state.redo,
    removeAudio: state.removeAudio,
    removeAudioTrack: state.removeAudioTrack,
    removeText: state.removeText,
    removeTextTrack: state.removeTextTrack,
    removeVideo: state.removeVideo,
    removeVideoTrack: state.removeVideoTrack,
    running: state.running,
    setError: state.setError,
    setProgress: state.setProgress,
    setRunning: state.setRunning,
    setSettings: state.setSettings,
    settings: state.settings,
    splitVideo: state.splitVideo,
    textItems: state.textItems,
    textTracks: state.textTracks,
    undo: state.undo,
    updateAudio: state.updateAudio,
    updateAudios: state.updateAudios,
    updateText: state.updateText,
    updateVideo: state.updateVideo,
    updateVideos: state.updateVideos,
    videoTracks: state.videoTracks,
  })))
  const {
    audioTracks: mergeAudioTracks,
    updateAudios: updateMergeAudios,
    updateVideos: updateMergeVideos,
    videoTracks: mergeVideoTracks,
  } = merge
  const projectRoot = useSettingsStore((state) => state.projectRoot)
  const pythonPath = useSettingsStore((state) => state.pythonPath)
  const { metadata, probing } = useMergeMetadata({
    items: merge.items,
    projectRoot,
    pythonPath,
    onError: merge.setError,
  })
  const dropActive = useMergeFileDrop()
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const previewVideoRefs = useRef(new Map<string, HTMLVideoElement>())
  const previewAudioRefs = useRef(new Map<string, HTMLAudioElement>())
  const previewPanelRef = useRef<HTMLElement | null>(null)
  const previewScreenRef = useRef<HTMLDivElement | null>(null)
  const outputCanvasRef = useRef<HTMLDivElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const selectedTextInputRef = useRef<HTMLInputElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const timelineSeekFrameRef = useRef<number | null>(null)
  const playheadDragFrameRef = useRef<number | null>(null)
  const keyboardStepRef = useRef<{ delay: number | null; repeat: number | null; direction: -1 | 1 | null }>({
    delay: null,
    repeat: null,
    direction: null,
  })
  const lastScrubMediaUpdateRef = useRef(0)
  const lastPlaybackSyncRef = useRef(0)
  const lastPlaybackStructureKeyRef = useRef('')
  const playheadRef = useRef(0)
  const playbackAnchorRef = useRef({ time: 0, timestamp: 0 })
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioNodesRef = useRef<WeakMap<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode }>>(new WeakMap())

  const getOrCreateAudioNodes = useCallback((video: HTMLMediaElement) => {
    if (!audioContextRef.current) {
      audioContextRef.current = createBrowserAudioContext()
    }
    const ctx = audioContextRef.current
    if (!ctx) return null
    if (audioNodesRef.current.has(video)) return audioNodesRef.current.get(video)!
    try {
      const source = ctx.createMediaElementSource(video)
      const gain = ctx.createGain()
      source.connect(gain)
      gain.connect(ctx.destination)
      const nodes = { source, gain }
      audioNodesRef.current.set(video, nodes)
      return nodes
    } catch {
      return null
    }
  }, [])
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({})
  const [selectedClipId, setSelectedClipId] = useState('')
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const [selectedTextId, setSelectedTextId] = useState('')
  const [playbackClock] = useState(() => new PlaybackClock())
  const [timelineDragPreview] = useState(() => new TimelineDragPreview())
  const [previewEditDraft] = useState(() => new PreviewEditDraft())
  const { withPointerLifecycle } = usePreviewEditInteractions()
  const [structuralPlayhead, setStructuralPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === 'undefined' ? 900 : window.innerHeight)
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [customResolutionSelected, setCustomResolutionSelected] = useState(false)
  const [draggedClipId, setDraggedClipId] = useState('')
  const [draggedAudioId, setDraggedAudioId] = useState('')
  const [draggedTextId, setDraggedTextId] = useState('')
  const [playheadDragging, setPlayheadDragging] = useState(false)
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuState | null>(null)
  const [audioContextMenu, setAudioContextMenu] = useState<AudioContextMenuState | null>(null)
  const [textContextMenu, setTextContextMenu] = useState<TextContextMenuState | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuState | null>(null)
  const [cropEditing, setCropEditing] = useState(false)
  const [groupEditingKey, setGroupEditingKey] = useState('')
  const [previewSize, setPreviewSize] = useState<typeof defaultPreviewSize | null>(null)
  const [cropGeometry, setCropGeometry] = useState<CropGeometry | null>(null)
  const [outputCanvasGeometry, setOutputCanvasGeometry] = useState<PreviewCanvasGeometry | null>(null)
  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', updateViewportHeight)
    updateViewportHeight()
    return () => window.removeEventListener('resize', updateViewportHeight)
  }, [])
  useEffect(() => {
    if (!clipContextMenu && !audioContextMenu && !textContextMenu && !trackContextMenu) return undefined
    const close = () => {
      setClipContextMenu(null)
      setAudioContextMenu(null)
      setTextContextMenu(null)
      setTrackContextMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    const closeOnScroll = (event: Event) => {
      if ((event.target as Element | null)?.closest?.('.video-context-menu')) return
      close()
    }
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [audioContextMenu, clipContextMenu, textContextMenu, trackContextMenu])

  const videoTrackIds = useMemo(() => merge.videoTracks.map((track) => track.id), [merge.videoTracks])
  const clipLayouts = useMemo(() => {
    return buildClipLayouts(merge.items, videoTrackIds, metadata)
  }, [merge.items, metadata, videoTrackIds])
  const audioTrackIds = useMemo(() => merge.audioTracks.map((track) => track.id), [merge.audioTracks])
  const audioLayouts = useMemo(() => {
    return buildAudioLayouts(merge.audioItems, audioTrackIds, audioDurations, metadata)
  }, [audioDurations, audioTrackIds, merge.audioItems, metadata])
  const visibleVideoTracks = useMemo(
    () => visibleTracks(merge.videoTracks, clipLayouts, true),
    [clipLayouts, merge.videoTracks],
  )
  const visibleAudioTracks = useMemo(
    () => visibleTracks(merge.audioTracks, audioLayouts),
    [audioLayouts, merge.audioTracks],
  )
  const visibleTextTracks = useMemo(
    () => visibleTracks(merge.textTracks, merge.textItems),
    [merge.textItems, merge.textTracks],
  )
  const playbackIndex = useMemo(
    () => createTimelinePlaybackIndex(clipLayouts, merge.textItems, videoTrackIds, audioLayouts),
    [audioLayouts, clipLayouts, merge.textItems, videoTrackIds],
  )
  const videoDuration = Math.max(0, ...clipLayouts.map((layout) => layout.end))
  const audioTimelineEnd = Math.max(0, ...audioLayouts.map((layout) => layout.end))
  const textTimelineEnd = Math.max(0, ...merge.textItems.map((item) => item.startTime + item.duration))
  const totalDuration = Math.max(videoDuration, audioTimelineEnd, textTimelineEnd)
  const timelineContentWidth = timelineViewportWidth || 720
  const timelinePixelsPerSecondFit = totalDuration > 0
    ? timelineContentWidth / totalDuration
    : 0
  const effectiveSelectedClipId = clipLayouts.some((layout) => layout.item.id === selectedClipId)
    ? selectedClipId
    : selectedAudioId || selectedTextId ? '' : clipLayouts[0]?.item.id ?? ''
  const selectedLayout = clipLayouts.find((layout) => layout.item.id === effectiveSelectedClipId) ?? null
  const selectedClip = selectedLayout?.item ?? null
  const activeLayouts = playbackIndex.activeVideosAt(structuralPlayhead)
  const activeTextItems = merge.textItems.filter(
    (item) => structuralPlayhead >= item.startTime && structuralPlayhead < item.startTime + item.duration,
  )
  const activeLayoutKey = activeLayouts.map((layout) => layout.item.id).join('|')
  const groupEditing = activeLayouts.length > 1 && groupEditingKey === activeLayoutKey
  const selectedOverlapGroup = activeLayouts.length > 1
    && activeLayouts.some((layout) => layout.item.id === effectiveSelectedClipId)
  const showOverlapToolbar = shouldShowOverlapToolbar(activeLayouts.length, selectedOverlapGroup, groupEditing)
  const currentLayout = activeLayouts.find((layout) => layout.item.id === effectiveSelectedClipId)
    ?? activeLayouts[0]
    ?? selectedLayout
  const previewClip = currentLayout?.item ?? selectedClip
  const selectedAudioLayout = audioLayouts.find((layout) => layout.item.id === selectedAudioId) ?? null
  const selectedAudio = selectedAudioLayout?.item ?? null
  const selectedText = merge.textItems.find((item) => item.id === selectedTextId) ?? null
  const previewLayout = previewClip
    ? clipLayouts.find((layout) => layout.item.id === previewClip.id) ?? null
    : null
  const resolutionBounds = useMemo(() => {
    const dimensions = merge.items.flatMap((item) => {
      const info = metadata[normalizePath(item.path)]
      if (!info?.readable) return []
      return [rotatedDimensions(info.width, info.height, item.rotation)]
    })
    if (dimensions.length === 0) {
      return {
        width: emptyTimelineResolutionLimit.width,
        height: emptyTimelineResolutionLimit.height,
        ready: false,
      }
    }
    return {
      width: Math.max(minimumOutputDimension, evenDimension(Math.max(...dimensions.map((item) => item.width)))),
      height: Math.max(minimumOutputDimension, evenDimension(Math.max(...dimensions.map((item) => item.height)))),
      ready: true,
    }
  }, [merge.items, metadata])
  const resolutionOptions = useMemo(() => {
    const maxOption = {
      label: `来源最大分辨率 ${resolutionBounds.width} × ${resolutionBounds.height}`,
      width: resolutionBounds.width,
      height: resolutionBounds.height,
    }
    return [
      maxOption,
      ...commonResolutionOptions.filter(
        (item) => item.width !== maxOption.width || item.height !== maxOption.height,
      ),
    ]
  }, [resolutionBounds.height, resolutionBounds.width])
  const matchedResolutionValue = resolutionOptions.some(
    (item) => item.width === merge.settings.width && item.height === merge.settings.height,
  ) ? `${merge.settings.width}x${merge.settings.height}` : 'custom'
  const resolutionValue = customResolutionSelected ? 'custom' : matchedResolutionValue
  const visibleLayouts = activeLayouts.length > 0 ? activeLayouts : previewLayout ? [previewLayout] : []
  const previewLayouts = cropEditing && previewLayout ? [previewLayout] : visibleLayouts
  const previewNormalizedCells = cropEditing
    ? previewLayouts.map(() => ({ x: 0, y: 0, width: 1, height: 1 }))
    : previewLayoutRects(previewLayouts.map((layout) => layout.item))
  const previewCells = outputCanvasGeometry
    ? previewNormalizedCells.map((rect) => ({
      left: rect.x * outputCanvasGeometry.width,
      top: rect.y * outputCanvasGeometry.height,
      width: rect.width * outputCanvasGeometry.width,
      height: rect.height * outputCanvasGeometry.height,
    }))
    : []
  const activeGroupRect = activeLayouts.length > 1
    ? boundingLayoutRect(previewNormalizedCells)
    : null
  const activeGroupPixelRect = activeGroupRect && outputCanvasGeometry ? {
    left: activeGroupRect.x * outputCanvasGeometry.width,
    top: activeGroupRect.y * outputCanvasGeometry.height,
    width: activeGroupRect.width * outputCanvasGeometry.width,
    height: activeGroupRect.height * outputCanvasGeometry.height,
  } : null
  const timelineTrackRows = visibleVideoTracks.length + visibleAudioTracks.length + visibleTextTracks.length
  const timelineLayout = useMemo(
    () => timelineLayoutForRows(timelineTrackRows, viewportHeight <= 820),
    [timelineTrackRows, viewportHeight],
  )
  const timelineTracksTemplate = `repeat(${timelineTrackRows}, ${timelineLayout.trackHeight}px)`
  const timelinePanelStyle = {
    '--merge-timeline-height': `${timelineLayout.panelHeight}px`,
    '--merge-timeline-row-height': `${timelineLayout.trackHeight}px`,
    '--merge-timeline-row-gap': `${timelineLayout.trackGap}px`,
    '--merge-timeline-ruler-height': `${timelineLayout.rulerHeight}px`,
    '--merge-timeline-tracks-margin': `${timelineLayout.tracksMarginTop}px`,
    '--merge-timeline-workspace-height': `${timelineLayout.workspaceHeight}px`,
  } as CSSProperties
  const timelineContentHeight = timelineLayout.workspaceHeight
  const frameStep = 1 / Math.max(1, merge.settings.fps || 30)

  useEffect(() => {
    const viewport = timelineScrollRef.current
    if (!viewport) return undefined
    const measure = () => {
      setTimelineViewportWidth(Math.max(1, viewport.clientWidth))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    measure()
    return () => observer.disconnect()
  }, [timelineTrackRows])

  const updatePreviewGeometry = useCallback(() => {
    const screen = previewScreenRef.current
    const video = previewRef.current
    if (!screen) {
      setOutputCanvasGeometry(null)
      setCropGeometry(null)
      return
    }
    if (screen.clientWidth <= 0 || screen.clientHeight <= 0) return
    const availableWidth = Math.max(1, screen.clientWidth - 6)
    const availableHeight = Math.max(1, screen.clientHeight - 6)
    const outputRatio = Math.max(0.01, merge.settings.width / Math.max(1, merge.settings.height))
    const canvasWidth = availableWidth / availableHeight > outputRatio
      ? availableHeight * outputRatio
      : availableWidth
    const canvasHeight = availableWidth / availableHeight > outputRatio
      ? availableHeight
      : availableWidth / outputRatio
    setOutputCanvasGeometry({
      left: (screen.clientWidth - canvasWidth) / 2,
      top: (screen.clientHeight - canvasHeight) / 2,
      width: canvasWidth,
      height: canvasHeight,
    })

    if (!video) {
      setCropGeometry(null)
      return
    }
    const rawWidth = video.videoWidth || metadata[normalizePath(previewClip?.path ?? '')]?.width || 0
    const rawHeight = video.videoHeight || metadata[normalizePath(previewClip?.path ?? '')]?.height || 0
    const rotated = rotatedDimensions(rawWidth, rawHeight, previewClip?.rotation ?? 0)
    const sourceWidth = rotated.width
    const sourceHeight = rotated.height
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      setCropGeometry(null)
      return
    }
    const sourceRatio = sourceWidth / sourceHeight
    const canvasRatio = canvasWidth / canvasHeight
    const width = canvasRatio > sourceRatio ? canvasHeight * sourceRatio : canvasWidth
    const height = canvasRatio > sourceRatio ? canvasHeight : canvasWidth / sourceRatio
    setCropGeometry({
      left: (canvasWidth - width) / 2,
      top: (canvasHeight - height) / 2,
      width,
      height,
      sourceWidth,
      sourceHeight,
    })
  }, [
    merge.settings.height,
    merge.settings.width,
    metadata,
    previewClip?.path,
    previewClip?.rotation,
  ])

  useEffect(() => {
    const screen = previewScreenRef.current
    if (!screen) return undefined
    const observer = new ResizeObserver(() => updatePreviewGeometry())
    observer.observe(screen)
    window.requestAnimationFrame(updatePreviewGeometry)
    return () => observer.disconnect()
  }, [updatePreviewGeometry])

  useEffect(() => {
    window.requestAnimationFrame(updatePreviewGeometry)
  }, [activeLayouts.length, previewClip?.id, previewLayouts.length, updatePreviewGeometry])

  useEffect(() => {
    previewRef.current = previewClip ? previewVideoRefs.current.get(previewClip.id) ?? null : null
    window.requestAnimationFrame(updatePreviewGeometry)
  }, [previewClip, updatePreviewGeometry])

  const scrubGlobal = useCallback((time: number, forceMediaUpdate = false) => {
    const next = clamp(time, 0, Math.max(0, totalDuration))
    const layouts = playbackIndex.activeVideosAt(next)
    const layout = layouts[0] ?? null
    playheadRef.current = next
    playbackClock.setTime(next)
    const structureKey = playbackIndex.structureKeyAt(next)
    if (structureKey !== lastPlaybackStructureKeyRef.current) {
      lastPlaybackStructureKeyRef.current = structureKey
      setStructuralPlayhead(next)
    }
    if (layout) {
      setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layout.item.id)
    }

    const now = Date.now()
    if (!forceMediaUpdate && now - lastScrubMediaUpdateRef.current < scrubMediaIntervalMs) return
    previewVideoRefs.current.forEach((video, id) => {
      const active = layouts.find((l) => l.item.id === id)
      if (!active) {
        if (!video.paused) video.pause()
        return
      }
      if (video.readyState < 1) return
      const target = active.item.trimStart + Math.max(0, next - active.start)
      requestMediaSeek(video, target)
      const targetVolume = active.item.muted ? 0 : (active.item.volume ?? 1)
      const nodes = getOrCreateAudioNodes(video)
      if (nodes) {
        nodes.gain.gain.value = targetVolume
      } else {
        video.volume = clamp(targetVolume, 0, 1)
      }
    })
    const activeAudios = playbackIndex.activeAudiosAt(next)
    previewAudioRefs.current.forEach((audio, id) => {
      const active = activeAudios.find((l) => l.item.id === id)
      if (!active) {
        if (!audio.paused) audio.pause()
        return
      }
      if (audio.readyState < 1) return
      const target = active.item.trimStart + Math.max(0, next - active.start)
      requestMediaSeek(audio, target)
      const targetVolume = 1
      const nodes = getOrCreateAudioNodes(audio)
      if (nodes) {
        nodes.gain.gain.value = targetVolume
      } else {
        audio.volume = clamp(targetVolume, 0, 1)
      }
    })
    lastScrubMediaUpdateRef.current = now
  }, [totalDuration, getOrCreateAudioNodes, playbackClock, playbackIndex])

  const seekGlobal = useCallback((time: number, autoPlay = false) => {
    scrubGlobal(time, true)
    playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
    window.requestAnimationFrame(() => {
      if (!autoPlay) return
      playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
      setPlaying(true)
    })
  }, [scrubGlobal])

  useEffect(() => {
    scrubGlobal(playheadRef.current, true)
    if (playing) playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
  }, [clipLayouts, playing, scrubGlobal])

  useEffect(() => {
    let changed = false
    const videoUpdates: { id: string; patch: { startTime: number } }[] = []
    
    for (const track of mergeVideoTracks) {
      const trackLayouts = clipLayouts.filter((l) => l.trackId === track.id)
      let currentEnd = 0
      for (const layout of trackLayouts) {
        if (layout.start < currentEnd - 0.005) {
          videoUpdates.push({ id: layout.item.id, patch: { startTime: currentEnd } })
          currentEnd = currentEnd + layout.duration
          changed = true
        } else {
          currentEnd = layout.end
        }
      }
    }
    
    const audioUpdates: { id: string; patch: { startTime: number } }[] = []
    for (const track of mergeAudioTracks) {
      const trackLayouts = audioLayouts.filter((l) => l.trackId === track.id)
      let currentEnd = 0
      for (const layout of trackLayouts) {
        if (layout.start < currentEnd - 0.005) {
          audioUpdates.push({ id: layout.item.id, patch: { startTime: currentEnd } })
          currentEnd = currentEnd + layout.duration
          changed = true
        } else {
          currentEnd = layout.end
        }
      }
    }
    
    if (changed) {
      if (videoUpdates.length) updateMergeVideos(videoUpdates, false)
      if (audioUpdates.length) updateMergeAudios(audioUpdates, false)
    }
  }, [clipLayouts, audioLayouts, mergeVideoTracks, mergeAudioTracks, updateMergeVideos, updateMergeAudios])

  useEffect(() => {
    const activeVideos = playbackIndex.activeVideosAt(playheadRef.current)
    previewVideoRefs.current.forEach((video, id) => {
      const layout = activeVideos.find((l) => l.item.id === id)
      if (!layout) {
        if (!video.paused) video.pause()
        return
      }
      const target = layout.item.trimStart + Math.max(0, playheadRef.current - layout.start)
      const sync = () => {
        requestMediaSeek(video, target, 0.2)
        video.playbackRate = 1
        const targetVolume = layout.item.muted ? 0 : (layout.item.volume ?? 1)
        const nodes = getOrCreateAudioNodes(video)
        if (nodes) {
          nodes.gain.gain.value = targetVolume
        } else {
          video.volume = clamp(targetVolume, 0, 1)
        }
        if (playing) {
          if (audioContextRef.current?.state === 'suspended') void audioContextRef.current.resume()
          void video.play().catch(() => undefined)
        }
        else video.pause()
      }
      if (video.readyState >= 1) sync()
      else video.addEventListener('loadedmetadata', sync, { once: true })
    })

    const activeAudios = playbackIndex.activeAudiosAt(playheadRef.current)
    previewAudioRefs.current.forEach((audio, id) => {
      const layout = activeAudios.find((l) => l.item.id === id)
      if (!layout) {
        if (!audio.paused) audio.pause()
        return
      }
      const target = layout.item.trimStart + Math.max(0, playheadRef.current - layout.start)
      const sync = () => {
        requestMediaSeek(audio, target, 0.2)
        audio.playbackRate = 1
        const targetVolume = 1
        const nodes = getOrCreateAudioNodes(audio)
        if (nodes) {
          nodes.gain.gain.value = targetVolume
        } else {
          audio.volume = clamp(targetVolume, 0, 1)
        }
        if (playing) {
          if (audioContextRef.current?.state === 'suspended') void audioContextRef.current.resume()
          void audio.play().catch(() => undefined)
        }
        else audio.pause()
      }
      if (audio.readyState >= 1) sync()
      else audio.addEventListener('loadedmetadata', sync, { once: true })
    })
  }, [activeLayoutKey, audioLayouts, playing, audioTrackIds, getOrCreateAudioNodes, playbackIndex])

  const handlePlaybackFrame = useEventCallback((next: number, timestamp: number) => {
      playheadRef.current = next
      playbackClock.setTime(next)
      const structureKey = playbackIndex.structureKeyAt(next)
      if (structureKey !== lastPlaybackStructureKeyRef.current) {
        lastPlaybackStructureKeyRef.current = structureKey
        setStructuralPlayhead(next)
        const layouts = playbackIndex.activeVideosAt(next)
        if (layouts.length > 0) {
          setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layouts[0].item.id)
        }
      }
      if (timestamp - lastPlaybackSyncRef.current > 450) {
        const layouts = playbackIndex.activeVideosAt(next)
        previewVideoRefs.current.forEach((video, id) => {
          const layout = layouts.find((l) => l.item.id === id)
          if (!layout) {
            if (!video.paused) video.pause()
            return
          }
          if (video.readyState < 1) return
          const target = targetMediaTime(layout.item.trimStart, next, layout.start)
          const correction = driftCorrection(target, video.currentTime)
          if (correction.seek) {
            requestMediaSeek(video, target, 0.4)
          }
          video.playbackRate = correction.playbackRate
          const targetVolume = layout.item.muted ? 0 : (layout.item.volume ?? 1)
          const nodes = getOrCreateAudioNodes(video)
          if (nodes) {
            nodes.gain.gain.value = targetVolume
          } else {
            video.volume = clamp(targetVolume, 0, 1)
          }
          if (video.paused) {
            if (audioContextRef.current?.state === 'suspended') void audioContextRef.current.resume()
            void video.play().catch(() => undefined)
          }
        })
        const activeAudios = playbackIndex.activeAudiosAt(next)
        previewAudioRefs.current.forEach((audio, id) => {
          const layout = activeAudios.find((l) => l.item.id === id)
          if (!layout) {
            if (!audio.paused) audio.pause()
            return
          }
          if (audio.readyState < 1) return
          const target = targetMediaTime(layout.item.trimStart, next, layout.start)
          const correction = driftCorrection(target, audio.currentTime)
          if (correction.seek) {
            requestMediaSeek(audio, target, 0.4)
          }
          audio.playbackRate = correction.playbackRate
          const targetVolume = 1
          const nodes = getOrCreateAudioNodes(audio)
          if (nodes) {
            nodes.gain.gain.value = targetVolume
          } else {
            audio.volume = clamp(targetVolume, 0, 1)
          }
          if (audio.paused) {
            if (audioContextRef.current?.state === 'suspended') void audioContextRef.current.resume()
            void audio.play().catch(() => undefined)
          }
        })
        lastPlaybackSyncRef.current = timestamp
      }
  })

  useEffect(() => {
    if (playing) {
      lastPlaybackStructureKeyRef.current = playbackIndex.structureKeyAt(playheadRef.current)
      return
    }
    previewVideoRefs.current.forEach((video) => { video.pause(); video.playbackRate = 1 })
    previewAudioRefs.current.forEach((audio) => { audio.pause(); audio.playbackRate = 1 })
  }, [playing, playbackIndex])

  const getPlaybackInitialTime = useEventCallback(() => playheadRef.current)
  usePlaybackRaf({
    playing,
    duration: totalDuration,
    getInitialTime: getPlaybackInitialTime,
    onFrame: handlePlaybackFrame,
    onEnd: () => {
      playheadRef.current = totalDuration
      playbackClock.setTime(totalDuration)
      setStructuralPlayhead(totalDuration)
      setPlaying(false)
    },
  })

  async function chooseVideos() {
    try {
      const paths = await selectVideoFiles()
      merge.addVideos(paths.map((path) => ({ path, name: fileName(path) })))
    } catch (error) {
      merge.setError(normalizeBackendError(error))
    }
  }

  async function chooseAudio() {
    try {
      const paths = await selectAudioFiles()
      merge.addAudioFiles(paths)
    } catch (error) {
      merge.setError(normalizeBackendError(error))
    }
  }

  async function chooseSubtitles() {
    try {
      const paths = await selectSubtitleFiles()
      if (paths.length === 0) return
      const trackId = merge.textTracks[0]?.id ?? merge.addTextTrack()
      let imported = 0
      let lastId = ''
      merge.beginHistoryTransaction()
      try {
        for (const path of paths) {
          const content = await readTextFile(path)
          const cues = parseSubtitleCues(content, extension(path))
          for (const cue of cues) {
            lastId = merge.addText({
              trackId,
              text: cue.text,
              startTime: cue.start,
              duration: Math.max(0.05, cue.end - cue.start),
              x: 0.5,
              y: 0.88,
              fontSize: 42,
              color: '#ffffff',
              backgroundColor: 'rgba(0,0,0,0.45)',
            })
            imported += 1
          }
        }
      } finally {
        merge.endHistoryTransaction()
      }
      if (lastId) {
        setSelectedClipId('')
        setSelectedAudioId('')
        setSelectedTextId(lastId)
      }
      merge.setError(imported > 0 ? `已导入 ${imported} 条字幕。` : '未从字幕文件中解析到有效字幕。')
    } catch (error) {
      merge.setError(normalizeBackendError(error))
    }
  }

  async function chooseOutputDir() {
    try {
      const path = await selectOutputDirectory()
      if (path) merge.setSettings({ outputDir: path })
    } catch (error) {
      merge.setError(normalizeBackendError(error))
    }
  }

  function togglePlayback() {
    if (totalDuration <= 0) return
    if (playing) {
      setPlaying(false)
      return
    }
    if (audioContextRef.current?.state === 'suspended') {
      void audioContextRef.current.resume()
    } else if (!audioContextRef.current) {
      audioContextRef.current = createBrowserAudioContext()
    }
    const start = playheadRef.current >= totalDuration - 0.02 ? 0 : playheadRef.current
    scrubGlobal(start, true)
    playbackAnchorRef.current = { time: start, timestamp: performance.now() }
    setPlaying(true)
  }

  function nudgePlayhead(direction: -1 | 1) {
    seekGlobal(playheadRef.current + frameStep * direction)
  }

  useEffect(() => {
    const clearKeyboardStep = () => {
      const timers = keyboardStepRef.current
      if (timers.delay !== null) window.clearTimeout(timers.delay)
      if (timers.repeat !== null) window.clearInterval(timers.repeat)
      keyboardStepRef.current = { delay: null, repeat: null, direction: null }
    }
    const shouldIgnoreKeyTarget = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null
      return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
    }
    const step = (direction: -1 | 1) => {
      if (totalDuration <= 0) return
      seekGlobal(playheadRef.current + frameStep * direction)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (shouldIgnoreKeyTarget(event.target)) return
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      if (keyboardStepRef.current.direction === direction) return
      clearKeyboardStep()
      keyboardStepRef.current.direction = direction
      step(direction)
      keyboardStepRef.current.delay = window.setTimeout(() => {
        keyboardStepRef.current.delay = null
        keyboardStepRef.current.repeat = window.setInterval(() => step(direction), clamp(1000 / Math.max(1, merge.settings.fps || 30), 16, 90))
      }, 280)
    }
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') clearKeyboardStep()
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    window.addEventListener('blur', clearKeyboardStep)
    return () => {
      clearKeyboardStep()
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
      window.removeEventListener('blur', clearKeyboardStep)
    }
  }, [frameStep, merge.settings.fps, seekGlobal, totalDuration])

  /* Timeline interactions are owned by useTimelineInteractions. */
  function splitAtPlayhead() {
    const currentPlayhead = playheadRef.current
    const layout = findLayoutAt(clipLayouts, currentPlayhead)
    if (!layout) return
    splitClipAt(layout, currentPlayhead)
  }

  function splitClipAt(layout: ClipLayout, timelineTime: number) {
    const sourceTime = layout.item.trimStart + clamp(timelineTime - layout.start, 0, layout.duration)
    const nextId = merge.splitVideo(layout.item.id, sourceTime, timelineTime)
    if (!nextId) {
      merge.setError('播放头距离片段边缘太近，无法拆分。')
      setClipContextMenu(null)
      return
    }
    setSelectedClipId(nextId)
    merge.setError('')
    setClipContextMenu(null)
  }

  function extractClipAudio(layout: ClipLayout) {
    const exists = merge.audioItems.some((item) => item.sourceClipId === layout.item.id)
    if (exists) {
      merge.setError('该视频片段的音频已经在音频线中。')
      setClipContextMenu(null)
      return
    }
    merge.addAudio({
      path: layout.item.path,
      name: layout.item.name + ' · 原音',
      startTime: layout.start,
      trimStart: layout.item.trimStart,
      trimEnd: clipSourceEnd(layout.item, metadata[normalizePath(layout.item.path)]),
      sourceType: 'video',
      sourceClipId: layout.item.id,
    })
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)
    merge.setError('')
    setClipContextMenu(null)
  }

  function duplicateClip(layout: ClipLayout) {
    const duplicateId = merge.duplicateVideo(layout.item.id)
    if (duplicateId) setSelectedClipId(duplicateId)
    setSelectedAudioId('')
    setSelectedTextId('')
    setClipContextMenu(null)
  }

  function moveClip(layout: ClipLayout, direction: -1 | 1) {
    const trackLayouts = clipLayouts
      .filter((candidate) => candidate.trackId === layout.trackId)
      .sort((left, right) => left.start - right.start)
    const index = trackLayouts.findIndex((candidate) => candidate.item.id === layout.item.id)
    const target = trackLayouts[index + direction]
    if (!target) return
    merge.beginHistoryTransaction()
    merge.updateVideo(layout.item.id, { startTime: target.start }, false)
    merge.updateVideo(target.item.id, { startTime: layout.start }, false)
    merge.endHistoryTransaction()
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)
    setClipContextMenu(null)
  }

  function removeClip(layout: ClipLayout) {
    const laterLayouts = clipLayouts.filter((candidate) => (
      candidate.trackId === layout.trackId
      && candidate.item.id !== layout.item.id
      && candidate.start >= layout.end - 0.0005
      && candidate.item.startTime !== null
    ))
    merge.beginHistoryTransaction()
    merge.removeVideo(layout.item.id)
    laterLayouts.forEach((candidate) => {
      merge.updateVideo(candidate.item.id, { startTime: Math.max(0, candidate.start - layout.duration) }, false)
    })
    merge.endHistoryTransaction()
    setSelectedClipId('')
    setClipContextMenu(null)
  }

  function rotateClipRight(item: MergeQueueItem) {
    const nextRotation = ((item.rotation + 90) % 360) as MergeRotation
    const info = metadata[normalizePath(item.path)]
    if (!item.cropEnabled || !info?.readable) {
      merge.updateVideo(item.id, { rotation: nextRotation })
      return
    }
    const currentDimensions = rotatedDimensions(info.width, info.height, item.rotation)
    const crop = cropRectForDimensions(item, currentDimensions.width, currentDimensions.height)
    merge.updateVideo(item.id, {
      rotation: nextRotation,
      cropX: currentDimensions.height - crop.y - crop.height,
      cropY: crop.x,
      cropWidth: crop.height,
      cropHeight: crop.width,
    })
  }

  function restoreClipRotation(item: MergeQueueItem) {
    if (item.rotation === 0) return
    const info = metadata[normalizePath(item.path)]
    if (!item.cropEnabled || !info?.readable) {
      merge.updateVideo(item.id, { rotation: 0 })
      return
    }

    let rotation: MergeRotation = item.rotation
    let dimensions = rotatedDimensions(info.width, info.height, rotation)
    let crop = cropRectForDimensions(item, dimensions.width, dimensions.height)
    while (rotation !== 0) {
      crop = {
        x: dimensions.height - crop.y - crop.height,
        y: crop.x,
        width: crop.height,
        height: crop.width,
      }
      dimensions = { width: dimensions.height, height: dimensions.width }
      rotation = ((rotation + 90) % 360) as MergeRotation
    }

    merge.updateVideo(item.id, {
      rotation: 0,
      cropX: crop.x,
      cropY: crop.y,
      cropWidth: crop.width,
      cropHeight: crop.height,
    })
  }

  const timelineInteractions = useTimelineInteractions({
    timelineRef, animationFrameRef, timelineSeekFrameRef, playheadDragFrameRef, playheadRef,
    totalDuration, pixelsPerSecond: timelinePixelsPerSecondFit, frameStep,
    playing, videoTrackCount: merge.videoTracks.length, audioTrackCount: merge.audioTracks.length, clipLayouts, audioLayouts, metadata,
    draft: timelineDragPreview,
    commands: { beginHistoryTransaction: merge.beginHistoryTransaction, endHistoryTransaction: merge.endHistoryTransaction, moveVideoTo: merge.moveVideoTo, updateVideo: merge.updateVideo, updateAudio: merge.updateAudio, updateText: merge.updateText },
    scrub: scrubGlobal, seek: seekGlobal, setPlaying, setPlayheadDragging, setDraggedClipId, setDraggedAudioId, setDraggedTextId,
    setSelectedClipId, setSelectedAudioId, setSelectedTextId,
    clearClipMenu: () => setClipContextMenu(null), clearAudioMenu: () => setAudioContextMenu(null), clearTextMenu: () => setTextContextMenu(null),
  })

  function addTextAt(trackId: string, startTime = playheadRef.current) {
    const id = merge.addText({ trackId, startTime: clamp(startTime, 0, Math.max(totalDuration, startTime)), duration: Math.max(1, Math.min(3, totalDuration || 3)) })
    setSelectedClipId('')
    setSelectedAudioId('')
    setSelectedTextId(id)
    setTrackContextMenu(null)
  }

  function editTextItem(item: MergeTextItem) {
    setSelectedClipId('')
    setSelectedAudioId('')
    setSelectedTextId(item.id)
    window.requestAnimationFrame(() => {
      selectedTextInputRef.current?.scrollIntoView({ block: 'nearest' })
      selectedTextInputRef.current?.focus()
      selectedTextInputRef.current?.select()
    })
  }

  function handlePreviewTextPointerDown(event: React.PointerEvent<HTMLDivElement>, item: MergeTextItem) {
    if (event.button !== 0 || !outputCanvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const canvasRect = outputCanvasRef.current.getBoundingClientRect()
    const textId = item.id
    setSelectedClipId('')
    setSelectedAudioId('')
    setSelectedTextId(textId)
    merge.beginHistoryTransaction()

    const nextTextPosition = (clientX: number, clientY: number) => textPositionFromPoint(clientX, clientY, canvasRect)
    const move = (pointerEvent: PointerEvent) => {
      previewEditDraft.set({ text: { [textId]: nextTextPosition(pointerEvent.clientX, pointerEvent.clientY) } })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      merge.updateText(textId, nextTextPosition(pointerEvent.clientX, pointerEvent.clientY), false)
      merge.endHistoryTransaction()
      previewEditDraft.set(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function applyActiveVideoLayout(mode: 'grid' | 'horizontal' | 'vertical' | 'auto') {
    if (activeLayouts.length < 2) {
      merge.setError('当前播放位置至少需要两个重叠视频才能设置画面布局。')
      return
    }
    merge.beginHistoryTransaction()
    if (mode === 'auto') {
      activeLayouts.forEach((layout) => merge.updateVideo(layout.item.id, { layoutCustom: false }, false))
    } else {
      const rects = presetLayoutRects(activeLayouts.length, mode)
      activeLayouts.forEach((layout, index) => {
        const rect = rects[index]
        merge.updateVideo(layout.item.id, {
          layoutCustom: true,
          layoutX: rect.x,
          layoutY: rect.y,
          layoutWidth: rect.width,
          layoutHeight: rect.height,
        }, false)
      })
    }
    merge.endHistoryTransaction()
    setGroupEditingKey(activeLayoutKey)
    merge.setError('')
  }

  function handlePreviewLayoutPointerDown(
    event: React.PointerEvent<HTMLDivElement>,
    layout: ClipLayout,
    layoutIndex: number,
  ) {
    if (event.button !== 0 || cropEditing || groupEditing || activeLayouts.length < 2 || !outputCanvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)

    const canvasRect = outputCanvasRef.current.getBoundingClientRect()
    const activeItems = activeLayouts.map((active) => active.item)
    const startingRects = activeItems.every((item) => item.layoutCustom)
      ? previewLayoutRects(activeItems)
      : insetLayoutRects(previewLayoutRects(activeItems), 0.025)
    const selectedIndex = activeLayouts.findIndex((active) => active.item.id === layout.item.id)
    const startRect = startingRects[selectedIndex >= 0 ? selectedIndex : layoutIndex]
    if (!startRect) return
    const otherRects = startingRects.filter((_, index) => index !== selectedIndex)
    const pointerStart = { x: event.clientX, y: event.clientY }
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const raw = {
        ...startRect,
        x: startRect.x + (pointerEvent.clientX - pointerStart.x) / Math.max(1, canvasRect.width),
        y: startRect.y + (pointerEvent.clientY - pointerStart.y) / Math.max(1, canvasRect.height),
      }
      const next = resolveDraggedLayout(
        raw,
        otherRects,
        merge.settings.snapToVideos,
        10 / Math.max(1, Math.min(canvasRect.width, canvasRect.height)),
      )
      if (!next) return
      previewEditDraft.set({ layout: { [layout.item.id]: next } })
    }
    withPointerLifecycle(event, apply, (pointerEvent) => {
      const raw = { ...startRect, x: startRect.x + (pointerEvent.clientX - pointerStart.x) / Math.max(1, canvasRect.width), y: startRect.y + (pointerEvent.clientY - pointerStart.y) / Math.max(1, canvasRect.height) }
      const next = resolveDraggedLayout(raw, otherRects, merge.settings.snapToVideos, 10 / Math.max(1, Math.min(canvasRect.width, canvasRect.height)))
      if (next) {
        activeLayouts.forEach((active, index) => {
          const rect = active.item.id === layout.item.id ? next : startingRects[index]
          merge.updateVideo(active.item.id, layoutPatch(rect), false)
        })
      }
      merge.endHistoryTransaction()
    }, () => previewEditDraft.set(null))
  }

  function handleGroupLayoutPointerDown(event: React.PointerEvent<HTMLElement>, handle: CropHandle) {
    if (event.button !== 0 || activeLayouts.length < 2 || !outputCanvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const canvasRect = outputCanvasRef.current.getBoundingClientRect()
    const startRects = previewLayoutRects(activeLayouts.map((layout) => layout.item))
    const startGroup = boundingLayoutRect(startRects)
    const origin = normalizedPoint(event.clientX, event.clientY, canvasRect)
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const point = normalizedPoint(pointerEvent.clientX, pointerEvent.clientY, canvasRect)
      const nextGroup = resizeNormalizedRect(startGroup, origin, point, handle)
      const transformed = transformLayoutRects(startRects, startGroup, nextGroup)
      previewEditDraft.set({ layout: Object.fromEntries(activeLayouts.map((layout, index) => [layout.item.id, transformed[index]])) })
    }
    withPointerLifecycle(event, apply, (pointerEvent) => {
      const point = normalizedPoint(pointerEvent.clientX, pointerEvent.clientY, canvasRect)
      const transformed = transformLayoutRects(startRects, startGroup, resizeNormalizedRect(startGroup, origin, point, handle))
      activeLayouts.forEach((layout, index) => merge.updateVideo(layout.item.id, layoutPatch(transformed[index]), false))
      merge.endHistoryTransaction()
    }, () => previewEditDraft.set(null))
  }

  function resetActiveGroupSize() {
    if (activeLayouts.length < 2) return
    const rects = previewLayoutRects(activeLayouts.map((layout) => layout.item))
    const currentGroup = boundingLayoutRect(rects)
    const transformed = transformLayoutRects(rects, currentGroup, { x: 0, y: 0, width: 1, height: 1 })
    merge.beginHistoryTransaction()
    activeLayouts.forEach((layout, index) => {
      const rect = transformed[index]
      merge.updateVideo(layout.item.id, {
        layoutCustom: true,
        layoutX: rect.x,
        layoutY: rect.y,
        layoutWidth: rect.width,
        layoutHeight: rect.height,
      }, false)
    })
    merge.endHistoryTransaction()
  }

  function handlePreviewResizePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const start = { ...(previewSize ?? defaultPreviewSize) }
    const origin = { x: event.clientX, y: event.clientY }
    const move = (pointerEvent: PointerEvent) => {
      setPreviewSize({
        width: clamp(start.width + pointerEvent.clientX - origin.x, 520, 820),
        height: clamp(start.height + pointerEvent.clientY - origin.y, 260, 620),
      })
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function openCropEditor() {
    if (!previewClip || !cropGeometry) {
      merge.setError('请先选择一个可预览的视频片段。')
      return
    }
    const current = previewClip.cropEnabled
      ? cropRectFromClip(previewClip, cropGeometry)
      : { x: 0, y: 0, width: cropGeometry.sourceWidth, height: cropGeometry.sourceHeight }
    merge.updateVideo(previewClip.id, {
      cropEnabled: true,
      cropX: current.x,
      cropY: current.y,
      cropWidth: current.width,
      cropHeight: current.height,
    })
    setCropEditing(true)
  }

  function resetCropSelection() {
    if (!cropGeometry || !previewClip) return
    merge.updateVideo(previewClip.id, {
      cropEnabled: true,
      cropX: 0,
      cropY: 0,
      cropWidth: cropGeometry.sourceWidth,
      cropHeight: cropGeometry.sourceHeight,
    })
  }

  function handleCropPointerDown(event: React.PointerEvent<HTMLElement>, handle: CropHandle) {
    if (!cropGeometry || !previewClip || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const canvasRect = outputCanvasRef.current?.getBoundingClientRect()
    if (!canvasRect) return
    const startPoint = cropPointFromClient(event.clientX, event.clientY, canvasRect, cropGeometry)
    const startRect = cropRectFromClip(previewClip, cropGeometry)
    const clipId = previewClip.id
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const point = cropPointFromClient(pointerEvent.clientX, pointerEvent.clientY, canvasRect, cropGeometry)
      const next = resizeCropRect(startRect, startPoint, point, handle, cropGeometry)
      previewEditDraft.set({ crop: { id: clipId, rect: next } })
    }
    withPointerLifecycle(event, apply, (pointerEvent) => {
      const point = cropPointFromClient(pointerEvent.clientX, pointerEvent.clientY, canvasRect, cropGeometry)
      const next = resizeCropRect(startRect, startPoint, point, handle, cropGeometry)
      merge.updateVideo(clipId, { cropEnabled: true, cropX: next.x, cropY: next.y, cropWidth: next.width, cropHeight: next.height }, false)
      merge.endHistoryTransaction()
    }, () => previewEditDraft.set(null))

    if (handle === 'draw') {
      previewEditDraft.set({ crop: { id: clipId, rect: { x: startPoint.x, y: startPoint.y, width: 2, height: 2 } } })
    }
  }

  async function startMerge() {
    if (merge.items.length === 0) {
      merge.setError('请先向视频线加入至少一个视频。')
      return
    }
    merge.clearLogs()
    merge.setError('')
    merge.setRunning(true)
    merge.setProgress(0, '正在提交导出任务')
    try {
      await runVideoMerge({
        inputs: merge.items.map((item) => ({
          path: item.path,
          startTime: clipLayouts.find((layout) => layout.item.id === item.id)?.start ?? 0,
          trackIndex: Math.max(0, merge.videoTracks.findIndex((track) => track.id === item.trackId)),
          trimStart: item.trimStart,
          trimEnd: item.trimEnd > item.trimStart ? item.trimEnd : undefined,
          muted: item.muted,
          volume: item.volume,
          rotation: item.rotation,
          cropEnabled: item.cropEnabled,
          cropX: item.cropX,
          cropY: item.cropY,
          cropWidth: item.cropWidth,
          cropHeight: item.cropHeight,
          layoutCustom: item.layoutCustom,
          layoutX: item.layoutX,
          layoutY: item.layoutY,
          layoutWidth: item.layoutWidth,
          layoutHeight: item.layoutHeight,
        })),
        audioTracks: audioLayouts.map((layout) => ({
          path: layout.item.path,
          startTime: layout.start,
          trimStart: layout.item.trimStart,
          trimEnd: layout.item.trimEnd > layout.item.trimStart ? layout.item.trimEnd : undefined,
        })),
        textTracks: merge.textItems.map((item) => ({
          text: item.text,
          startTime: item.startTime,
          duration: item.duration,
          x: item.x,
          y: item.y,
          fontSize: item.fontSize,
          color: item.color,
          backgroundColor: item.backgroundColor,
        })),
        ...merge.settings,
        projectRoot,
        pythonPath,
      })
    } catch (error) {
      merge.setRunning(false)
      merge.setError(normalizeBackendError(error))
    }
  }

  // Timeline rows are memoized. Keep their high-frequency pointer handlers
  // referentially stable while each invocation still observes current project state.
  const onTracksPointerDown = timelineInteractions.handleTimelinePointerDown
  const onPlayheadPointerDown = timelineInteractions.handlePlayheadPointerDown
  const onVideoPointerDown = timelineInteractions.handleVideoPointerDown
  const onVideoTrimPointerDown = timelineInteractions.handleVideoTrimPointerDown
  const onAudioPointerDown = timelineInteractions.handleAudioPointerDown
  const onTextPointerDown = timelineInteractions.handleTextPointerDown

  return (
    <Translated>
    <div className={`route-fill merge-editor-page ${dropActive ? 'drop-active' : ''}`}>
      <GlassPanel className="editor-toolbar">
        <div className="editor-toolbar-group">
          <NeonButton variant="outline" type="button" onClick={() => void chooseVideos()}>
            <Plus size={16} />添加视频
          </NeonButton>
          <NeonButton variant="outline" type="button" onClick={() => void chooseAudio()}>
            <Music2 size={16} />导入音频
          </NeonButton>
          <NeonButton variant="outline" type="button" onClick={() => void chooseSubtitles()}>
            <Upload size={16} />导入字幕
          </NeonButton>
          <NeonButton variant="outline" type="button" onClick={() => addTextAt(merge.textTracks[0]?.id ?? 'text-track-1')}>
            <Type size={16} />添加文本
          </NeonButton>
          <button type="button" title="在播放头位置拆分当前片段" disabled={!selectedClip} onClick={splitAtPlayhead}>
            <Scissors />拆分
          </button>
          <button
            className="danger"
            type="button"
            title="移除选中的视频、音频或文本片段"
            disabled={!selectedClip && !selectedAudio && !selectedText}
            onClick={() => {
              if (selectedAudio) {
                merge.removeAudio(selectedAudio.id)
                setSelectedAudioId('')
              } else if (selectedText) {
                merge.removeText(selectedText.id)
                setSelectedTextId('')
              } else if (selectedClip) {
                merge.removeVideo(selectedClip.id)
              }
            }}
          >
            <Trash2 />移除
          </button>
	          <button type="button" title="撤销上一步编辑" disabled={!merge.canUndo} onClick={merge.undo}>
            <Undo2 />撤销
          </button>
          <button type="button" title="重做上一步编辑" disabled={!merge.canRedo} onClick={merge.redo}>
            <Redo2 />重做
          </button>
        </div>
        <div className="editor-toolbar-group right">
	          <span>{merge.items.length} 个片段 · {formatDuration(totalDuration)}{probing ? ' · 读取媒体中' : ''}</span>
          <button
            type="button"
            className={`editor-toolbar-utility ${inspectorOpen ? 'active' : ''}`}
            title={inspectorOpen ? '收起属性与输出面板' : '打开属性与输出面板'}
            aria-label={inspectorOpen ? '收起属性与输出面板' : '打开属性与输出面板'}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <PanelRight /><span>属性</span>
          </button>
          <button
            type="button"
            className="editor-toolbar-utility"
            title="还原播放窗口默认尺寸"
            aria-label="还原窗口"
            onClick={() => setPreviewSize(null)}
          >
            <RotateCcw /><span>还原窗口</span>
          </button>
          <NeonButton
            variant="outline"
            className="editor-toolbar-utility"
            type="button"
            title="打开高级导出设置"
            aria-label="高级导出设置"
            onClick={() => setAdvancedSettingsOpen(true)}
          >
            <SlidersHorizontal /><span>高级设置</span>
          </NeonButton>
          {merge.running ? (
            <NeonButton tone="red" type="button" onClick={() => void cancelVideoMerge()}><Pause />取消导出</NeonButton>
          ) : (
            <NeonButton type="button" disabled={merge.items.length === 0} onClick={() => void startMerge()}><Download />导出视频</NeonButton>
          )}
        </div>
      </GlassPanel>

      <div className="editor-main-grid">
        <GlassPanel
          ref={previewPanelRef}
          className={`editor-preview-panel frame-preview-card video-preview-card ${showOverlapToolbar ? 'has-overlap-layout' : ''}`}
          style={{ maxWidth: 'none' }}
        >
          <MergePreviewCanvas
            previewScreenRef={previewScreenRef}
            outputCanvasRef={outputCanvasRef}
            previewRef={previewRef}
            editDraft={previewEditDraft}
            previewVideoRefs={previewVideoRefs}
            previewSize={previewSize}
            outputCanvasGeometry={outputCanvasGeometry}
            settings={merge.settings}
            previewLayouts={previewLayouts}
            previewCells={previewCells}
            metadata={metadata}
            effectiveSelectedClipId={effectiveSelectedClipId}
            activeLayoutCount={activeLayouts.length}
            previewClip={previewClip}
            activeTextItems={activeTextItems}
            selectedTextId={selectedTextId}
            groupEditing={groupEditing}
            activeGroupPixelRect={activeGroupPixelRect}
            cropEditing={cropEditing}
            cropGeometry={cropGeometry}
            playing={playing}
            totalDuration={totalDuration}
            previewStart={previewLayout?.start ?? null}
            onPreviewLayoutPointerDown={handlePreviewLayoutPointerDown}
            onPreviewTextPointerDown={handlePreviewTextPointerDown}
            onEditText={editTextItem}
            onGroupLayoutPointerDown={handleGroupLayoutPointerDown}
            onCropPointerDown={handleCropPointerDown}
            onResetCropSelection={resetCropSelection}
            onPreviewResizePointerDown={handlePreviewResizePointerDown}
            onPreviewMetadataLoaded={updatePreviewGeometry}
            onSeek={seekGlobal}
            onTogglePlayback={togglePlayback}
            onNudge={nudgePlayhead}
          />
          {showOverlapToolbar && <section className="editor-workspace-controls" aria-label="重叠视频布局">
            <div className="editor-overlap-layout">
              <span>重叠视频布局</span>
              <button type="button" onClick={() => applyActiveVideoLayout('auto')}>自动</button>
              <button type="button" onClick={() => applyActiveVideoLayout('grid')}>网格</button>
              <button type="button" onClick={() => applyActiveVideoLayout('horizontal')}>左右</button>
	              <button type="button" onClick={() => applyActiveVideoLayout('vertical')}>上下</button>
              <button type="button" onClick={resetActiveGroupSize}>整体还原</button>
              <button type="button" onClick={() => setGroupEditingKey(groupEditing ? '' : activeLayoutKey)}>
                {groupEditing ? '完成整体调整' : '选择组合画面'}
              </button>
              <label><Toggle checked={merge.settings.snapToVideos} onChange={(snapToVideos) => merge.setSettings({ snapToVideos })} />自动贴合</label>
            </div>
          </section>}

        </GlassPanel>

        <MergeAdvancedSettingsDialog
          open={advancedSettingsOpen}
          settings={merge.settings}
          onChange={(patch) => merge.setSettings(patch)}
          onClose={() => setAdvancedSettingsOpen(false)}
        />

        <aside className={`editor-inspector-drawer ${inspectorOpen ? 'is-open' : ''}`} aria-hidden={!inspectorOpen}>
          <div className="editor-inspector-drawer-head">
            <span>片段属性</span>
            <button type="button" title="收起属性与输出面板" onClick={() => setInspectorOpen(false)}>
              <PanelRight />
            </button>
          </div>
          <MergeInspectorPanel
            panelHeight={0}
            selectedClip={selectedClip}
            selectedClipMetadata={selectedClip ? metadata[normalizePath(selectedClip.path)] : undefined}
            selectedAudio={selectedAudio}
            selectedAudioStart={selectedAudioLayout?.start ?? 0}
            selectedText={selectedText}
            selectedTextInputRef={selectedTextInputRef}
            formatTime={formatPreciseTime}
          >
            <div className="editor-output-settings">
            <div className="editor-output-primary-grid">
              <label>
	              <ParameterHint label="输出目录" tip="导出的视频文件保存位置。" />
              <div className="merge-path-input">
                <TextInput value={merge.settings.outputDir} onChange={(event) => merge.setSettings({ outputDir: event.target.value })} />
                <button type="button" title="选择输出目录" onClick={() => void chooseOutputDir()}><FolderOpen /></button>
              </div>
              </label>
              <label>
	                <ParameterHint label="文件名称" tip="无需填写扩展名。" />
                <TextInput value={merge.settings.outputName} onChange={(event) => merge.setSettings({ outputName: event.target.value })} />
              </label>
            </div>
            <div className="editor-setting-row">
              <label>
	                <ParameterHint label="输出分辨率" tip="播放窗口中的蓝框代表该输出尺寸和宽高比。" />
                <SelectInput
                  value={resolutionValue}
                  onChange={(event) => {
                    if (event.target.value === 'custom') {
                      setCustomResolutionSelected(true)
                      return
                    }
                    const preset = resolutionOptions.find((item) => `${item.width}x${item.height}` === event.target.value)
                    if (preset) {
                      setCustomResolutionSelected(false)
                      merge.setSettings({ width: preset.width, height: preset.height })
                    }
                  }}
                >
                  {resolutionOptions.map((item) => <option key={item.label} value={`${item.width}x${item.height}`}>{item.label}</option>)}
	                  <option value="custom">自定义</option>
                </SelectInput>
              </label>
              <label className="editor-toggle-row compact">
	                <ParameterHint label="保留原音" tip="关闭后只输出音频线中的声音。" />
                <Toggle checked={merge.settings.includeAudio} onChange={(includeAudio) => merge.setSettings({ includeAudio })} />
              </label>
            </div>
            <div className="editor-resolution-fields">
              <NumberField
	                label="自定义宽度"
	                tip={`可超过来源最大宽度 ${resolutionBounds.width}，技术上限 ${maximumOutputDimension}。多余区域按“空余区域”设置填充。`}
                value={merge.settings.width}
                min={minimumOutputDimension}
                max={maximumOutputDimension}
                step={2}
                onChange={(width) => {
                  setCustomResolutionSelected(true)
                  merge.setSettings({ width: evenDimension(width) })
                }}
              />
              <NumberField
	                label="自定义高度"
	                tip={`可超过来源最大高度 ${resolutionBounds.height}，技术上限 ${maximumOutputDimension}。多余区域按“空余区域”设置填充。`}
                value={merge.settings.height}
                min={minimumOutputDimension}
                max={maximumOutputDimension}
                step={2}
                onChange={(height) => {
                  setCustomResolutionSelected(true)
                  merge.setSettings({ height: evenDimension(height) })
                }}
              />
            </div>
            <div className={`editor-resize-card ${previewClip?.cropEnabled ? 'active' : ''}`}>
              <div>
                <strong>当前预览片段尺寸</strong>
                <span>{previewClip?.cropEnabled ? `${previewClip.cropWidth} × ${previewClip.cropHeight}，仅显示并导出框内画面` : '当前片段使用完整画面'}</span>
              </div>
              <button
                type="button"
                disabled={!previewClip}
                onClick={() => cropEditing ? setCropEditing(false) : openCropEditor()}
              >
                {cropEditing ? <CheckCircle2 /> : <SquareDashedMousePointer />}
	                {cropEditing ? '调整完成' : previewClip?.cropEnabled ? '编辑红框' : '开始调整'}
              </button>
              {previewClip?.cropEnabled && (
                <button type="button" className="subtle" onClick={() => {
                  merge.updateVideo(previewClip.id, { cropEnabled: false })
                  setCropEditing(false)
                }}>取消调整</button>
              )}
            </div>
            </div>
          </MergeInspectorPanel>
        </aside>
      </div>

      <GlassPanel className="editor-timeline-panel" style={timelinePanelStyle}>
        <MergeTimeline
          clock={playbackClock}
          dragPreview={timelineDragPreview}
          timelineRef={timelineRef}
          timelineScrollRef={timelineScrollRef}
          videoTracks={visibleVideoTracks}
          audioTracks={visibleAudioTracks}
          textTracks={visibleTextTracks}
          clipLayouts={clipLayouts}
          audioLayouts={audioLayouts}
          textItems={merge.textItems}
          totalDuration={totalDuration}
          contentWidth={timelineContentWidth}
          contentHeight={timelineContentHeight}
          tracksTemplate={timelineTracksTemplate}
          pixelsPerSecond={timelinePixelsPerSecondFit}
          selectedClipId={effectiveSelectedClipId}
          selectedAudioId={selectedAudioId}
          selectedTextId={selectedTextId}
          draggedClipId={draggedClipId}
          draggedAudioId={draggedAudioId}
          draggedTextId={draggedTextId}
          playheadDragging={playheadDragging}
          onTracksPointerDown={onTracksPointerDown}
          onPlayheadPointerDown={onPlayheadPointerDown}
          onTrackContextMenu={(event, kind, trackId) => {
            event.preventDefault()
            setTrackContextMenu({ x: event.clientX, y: event.clientY, kind, trackId })
          }}
          onTextTrackContextMenu={(event, trackId) => {
            event.preventDefault()
            const rect = timelineRef.current?.getBoundingClientRect()
            setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'text', trackId, time: rect ? timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondFit) : playheadRef.current })
          }}
          onVideoPointerDown={onVideoPointerDown}
          onVideoContextMenu={(event, layout) => {
            event.preventDefault()
            event.stopPropagation()
            const rect = timelineRef.current?.getBoundingClientRect()
            const time = rect ? clamp(timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondFit), layout.start, layout.end) : layout.start
            setSelectedAudioId('')
            setSelectedTextId('')
            setSelectedClipId(layout.item.id)
            setAudioContextMenu(null)
            setTextContextMenu(null)
            setClipContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 390)), layout, time })
          }}
          onVideoTrimPointerDown={onVideoTrimPointerDown}
          onAudioPointerDown={onAudioPointerDown}
          onAudioContextMenu={(event, layout) => {
            event.preventDefault()
            event.stopPropagation()
            setSelectedClipId('')
            setSelectedTextId('')
            setSelectedAudioId(layout.item.id)
            setClipContextMenu(null)
            setTextContextMenu(null)
            setAudioContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)), layout })
          }}
          onTextPointerDown={onTextPointerDown}
          onTextContextMenu={(event, item) => {
            event.preventDefault()
            event.stopPropagation()
            setSelectedClipId('')
            setSelectedAudioId('')
            setSelectedTextId(item.id)
            setClipContextMenu(null)
            setAudioContextMenu(null)
            setTextContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 210)), text: item })
          }}
        />
        {merge.audioItems.map((audio) => (
          <audio
            key={`probe-${audio.id}`}
            ref={(node) => {
              if (node) {
                previewAudioRefs.current.set(audio.id, node)
              } else {
                previewAudioRefs.current.delete(audio.id)
              }
            }}
            src={localFileSrc(audio.path)}
            crossOrigin="anonymous"
            preload="auto"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration
              if (Number.isFinite(duration)) setAudioDurations((current) => ({ ...current, [audio.id]: duration }))
            }}
          />
        ))}
      </GlassPanel>

      <MergeExportStatus />

      {dropActive && <div className="editor-drop-overlay"><Upload /><strong>松开以加入视频线或音频线</strong></div>}
      <MergeTimelineContextMenus
        track={trackContextMenu} clip={clipContextMenu} audio={audioContextMenu} text={textContextMenu}
        trackCount={{ video: merge.videoTracks.length, audio: merge.audioTracks.length, text: merge.textTracks.length }}
        clipRange={clipContextMenu ? `${formatPreciseTime(clipContextMenu.layout.item.trimStart)} - ${formatPreciseTime(clipSourceEnd(clipContextMenu.layout.item, metadata[normalizePath(clipContextMenu.layout.item.path)]))}` : ''}
        formatTime={formatPreciseTime}
        canSplit={Boolean(clipContextMenu && canSplitClipAt(clipContextMenu.layout, clipContextMenu.time, metadata))}
        canRestoreRotation={Boolean(clipContextMenu?.layout.item.rotation)}
        canRestoreClip={Boolean(clipContextMenu && (clipContextMenu.layout.item.trimStart !== 0 || clipContextMenu.layout.item.trimEnd !== 0))}
        onTrackAddText={(track) => addTextAt(track.trackId, track.time ?? playheadRef.current)}
        onTrackAdd={(kind) => { if (kind === 'video') merge.addVideoTrack(); else if (kind === 'audio') merge.addAudioTrack(); else merge.addTextTrack(); setTrackContextMenu(null) }}
        onTrackRemove={(track) => { const removed = track.kind === 'video' ? merge.removeVideoTrack(track.trackId) : track.kind === 'audio' ? merge.removeAudioTrack(track.trackId) : merge.removeTextTrack(track.trackId); if (!removed) merge.setError(`${trackKindLabel(track.kind)}至少保留一条。`); setTrackContextMenu(null) }}
        onClipSeek={(clip) => { seekGlobal(clip.time); setClipContextMenu(null) }} onClipPlay={(clip) => { seekGlobal(clip.layout.start, true); setClipContextMenu(null) }} onClipSplit={(clip) => splitClipAt(clip.layout, clip.time)} onClipExtractAudio={(clip) => extractClipAudio(clip.layout)}
        onClipToggleMute={(clip) => { merge.updateVideo(clip.layout.item.id, { muted: !clip.layout.item.muted }); setClipContextMenu(null) }} onClipRotate={(clip) => { rotateClipRight(clip.layout.item); setClipContextMenu(null) }} onClipRestoreRotation={(clip) => { restoreClipRotation(clip.layout.item); setClipContextMenu(null) }}
        onClipCrop={(clip) => { const info = metadata[normalizePath(clip.layout.item.path)]; setSelectedAudioId(''); setSelectedClipId(clip.layout.item.id); seekGlobal(clip.layout.start); if (!clip.layout.item.cropEnabled && info?.readable) { const dimensions = rotatedDimensions(info.width, info.height, clip.layout.item.rotation); merge.updateVideo(clip.layout.item.id, { cropEnabled: true, cropX: 0, cropY: 0, cropWidth: dimensions.width, cropHeight: dimensions.height }) }; setClipContextMenu(null); window.requestAnimationFrame(() => setCropEditing(true)) }}
        onClipDuplicate={(clip) => duplicateClip(clip.layout)} onClipMove={(clip, direction) => moveClip(clip.layout, direction)} canClipMove={(clip, direction) => Boolean(previousTrackLayout(clipLayouts, clip.layout, direction))} onClipRestore={(clip) => { merge.updateVideo(clip.layout.item.id, { trimStart: 0, trimEnd: 0 }); setClipContextMenu(null) }} onClipReveal={(clip) => { setClipContextMenu(null); void revealInFolder(clip.layout.item.path).catch((error) => merge.setError(normalizeBackendError(error))) }} onClipRemove={(clip) => removeClip(clip.layout)}
        onAudioSeek={(audio) => { seekGlobal(audio.layout.start); setAudioContextMenu(null) }} onAudioMoveToPlayhead={(audio) => { merge.updateAudio(audio.layout.item.id, { startTime: playheadRef.current }); setAudioContextMenu(null) }} onAudioMoveToStart={(audio) => { merge.updateAudio(audio.layout.item.id, { startTime: 0 }); setAudioContextMenu(null) }} onAudioReveal={(audio) => { setAudioContextMenu(null); void revealInFolder(audio.layout.item.path).catch((error) => merge.setError(normalizeBackendError(error))) }} onAudioRemove={(audio) => { merge.removeAudio(audio.layout.item.id); setSelectedAudioId(''); setAudioContextMenu(null) }}
        onTextSeek={(text) => { seekGlobal(text.text.startTime); setTextContextMenu(null) }} onTextMoveToPlayhead={(text) => { merge.updateText(text.text.id, { startTime: playheadRef.current }); setTextContextMenu(null) }} onTextRemove={(text) => { merge.removeText(text.text.id); setSelectedTextId(''); setTextContextMenu(null) }}
      />
    </div>
    </Translated>
  )
}

function trackKindLabel(kind: 'video' | 'audio' | 'text') {
	  if (kind === 'video') return '视频线'
	  if (kind === 'audio') return '音频线'
	  return '文本线'
}
