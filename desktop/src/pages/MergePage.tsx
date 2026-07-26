import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Film,
  FolderOpen,
  GripVertical,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashedMousePointer,
  SkipBack,
  Trash2,
  Type,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
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
import { MergeTimelinePlayhead } from '@/components/merge/MergePlaybackControls'
import { MergePreviewCanvas } from '@/components/merge/MergePreviewCanvas'
import { PlaybackClock } from '@/components/merge/PlaybackClock'
import { useMergeFileDrop } from '@/components/merge/useMergeFileDrop'
import { useMergeMetadata } from '@/components/merge/useMergeMetadata'
import {
  clamp,
  extension,
  formatDuration,
  formatEstimatedSize,
  formatPreciseTime,
  formatTick,
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
  activeLayoutsAt,
  buildAudioLayouts,
  buildClipLayouts,
  canSplitClipAt,
  clipSourceEnd,
  findLayoutAt,
  normalizeTimelineZoom,
  playbackStructureKey,
  previousTrackLayout,
  resolveTimelineDragStart,
  sourceDurationForClip,
  timelineLength,
  timelineMinimumWidth,
  timelinePixel,
  timelinePixelsPerSecondForZoom,
  timelineTimeFromClientX,
  timelineZoomDefault,
  timelineZoomStep,
  timeTicks,
  type AudioClipLayout,
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
  type MergeFitMode,
  type MergeQueueItem,
  type MergeRateControl,
  type MergeRotation,
  type MergeSettings,
  type MergeSplitMode,
  type MergeTextItem,
  type MergeVideoEncoder,
} from '@/stores/mergeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useShallow } from 'zustand/react/shallow'

const scrubMediaIntervalMs = 32
const defaultPreviewSize = { width: 720, height: 260 }
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
type EncodingPresetSettings = Pick<
  MergeSettings,
  | 'width'
  | 'height'
  | 'fps'
  | 'videoEncoder'
  | 'rateControl'
  | 'crf'
  | 'videoBitrate'
  | 'twoPass'
  | 'encoderPreset'
  | 'audioBitrate'
>
const encodingPresets: Array<{
  id: string
  label: string
  detail: string
  settings: EncodingPresetSettings
}> = [
  {
    id: 'standard-1080p30',
    label: '标准 1080p30',
    detail: 'H.264 · RF 23 · 质量与速度均衡',
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      videoEncoder: 'h264',
      rateControl: 'quality',
      crf: 23,
      videoBitrate: 4000,
      twoPass: false,
      encoderPreset: 'medium',
      audioBitrate: 192,
    },
  },
  {
    id: 'fast-1080p30',
    label: '快速 1080p30',
    detail: 'H.264 · RF 22 · 兼容性优先',
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      videoEncoder: 'h264',
      rateControl: 'quality',
      crf: 22,
      videoBitrate: 4000,
      twoPass: false,
      encoderPreset: 'veryfast',
      audioBitrate: 160,
    },
  },
  {
    id: 'hq-1080p30',
    label: '高质量 1080p30',
    detail: 'H.264 · RF 18 · 细节优先',
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      videoEncoder: 'h264',
      rateControl: 'quality',
      crf: 18,
      videoBitrate: 6000,
      twoPass: false,
      encoderPreset: 'slow',
      audioBitrate: 192,
    },
  },
  {
    id: 'small-1080p30',
    label: '小体积 1080p30',
    detail: 'H.265 · RF 24 · 空间优先',
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      videoEncoder: 'h265',
      rateControl: 'quality',
      crf: 24,
      videoBitrate: 3000,
      twoPass: false,
      encoderPreset: 'medium',
      audioBitrate: 128,
    },
  },
  {
    id: 'fast-720p30',
    label: '快速 720p30',
    detail: 'H.264 · RF 22 · 低配置设备',
    settings: {
      width: 1280,
      height: 720,
      fps: 30,
      videoEncoder: 'h264',
      rateControl: 'quality',
      crf: 22,
      videoBitrate: 2500,
      twoPass: false,
      encoderPreset: 'veryfast',
      audioBitrate: 128,
    },
  },
]

interface ClipContextMenuState {
  x: number
  y: number
  layout: ClipLayout
  time: number
}

interface AudioContextMenuState {
  x: number
  y: number
  layout: AudioClipLayout
}

interface TextContextMenuState {
  x: number
  y: number
  text: MergeTextItem
}

interface TrackContextMenuState {
  x: number
  y: number
  kind: 'video' | 'audio' | 'text'
  trackId: string
  time?: number
}

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
  const playbackFrameRef = useRef<number | null>(null)
  const keyboardStepRef = useRef<{ delay: number | null; repeat: number | null; direction: -1 | 1 | null }>({
    delay: null,
    repeat: null,
    direction: null,
  })
  const lastScrubMediaUpdateRef = useRef(0)
  const lastPlaybackSyncRef = useRef(0)
  const lastPlaybackUiUpdateRef = useRef(0)
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
  const [structuralPlayhead, setStructuralPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(timelineZoomDefault)
  const [timelineZoomEditing, setTimelineZoomEditing] = useState(false)
  const [timelineZoomDraft, setTimelineZoomDraft] = useState('100')
  const [customResolutionSelected, setCustomResolutionSelected] = useState(false)
  const [draggedClipId, setDraggedClipId] = useState('')
  const [draggedAudioId, setDraggedAudioId] = useState('')
  const [playheadDragging, setPlayheadDragging] = useState(false)
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuState | null>(null)
  const [audioContextMenu, setAudioContextMenu] = useState<AudioContextMenuState | null>(null)
  const [textContextMenu, setTextContextMenu] = useState<TextContextMenuState | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuState | null>(null)
  const [cropEditing, setCropEditing] = useState(false)
  const [groupEditingKey, setGroupEditingKey] = useState('')
  const [previewSize, setPreviewSize] = useState(defaultPreviewSize)
  const [previewPanelHeight, setPreviewPanelHeight] = useState(0)
  const [cropGeometry, setCropGeometry] = useState<CropGeometry | null>(null)
  const [outputCanvasGeometry, setOutputCanvasGeometry] = useState<PreviewCanvasGeometry | null>(null)
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
  const videoDuration = Math.max(0, ...clipLayouts.map((layout) => layout.end))
  const audioTimelineEnd = Math.max(0, ...audioLayouts.map((layout) => layout.end))
  const textTimelineEnd = Math.max(0, ...merge.textItems.map((item) => item.startTime + item.duration))
  const totalDuration = Math.max(videoDuration, audioTimelineEnd, textTimelineEnd)
  const timelinePixelsPerSecondScaled = timelinePixelsPerSecondForZoom(timelineZoom)
  const timelineContentWidth = totalDuration > 0
    ? Math.max(timelineMinimumWidth, Math.ceil(totalDuration * timelinePixelsPerSecondScaled))
    : timelineMinimumWidth
  const effectiveSelectedClipId = clipLayouts.some((layout) => layout.item.id === selectedClipId)
    ? selectedClipId
    : selectedAudioId || selectedTextId ? '' : clipLayouts[0]?.item.id ?? ''
  const selectedLayout = clipLayouts.find((layout) => layout.item.id === effectiveSelectedClipId) ?? null
  const selectedClip = selectedLayout?.item ?? null
  const activeLayouts = activeLayoutsAt(clipLayouts, structuralPlayhead, videoTrackIds)
  const activeTextItems = merge.textItems.filter(
    (item) => structuralPlayhead >= item.startTime && structuralPlayhead < item.startTime + item.duration,
  )
  const activeLayoutKey = activeLayouts.map((layout) => layout.item.id).join('|')
  const groupEditing = activeLayouts.length > 1 && groupEditingKey === activeLayoutKey
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
  const encodingPresetValue = encodingPresets.find(
    (preset) => Object.entries(preset.settings).every(
      ([key, value]) => merge.settings[key as keyof EncodingPresetSettings] === value,
    ),
  )?.id ?? 'custom'
  const selectedEncodingPreset = encodingPresets.find((preset) => preset.id === encodingPresetValue)
  const estimatedOutputSize = merge.settings.rateControl === 'bitrate' && totalDuration > 0
    ? formatEstimatedSize(
      totalDuration * (merge.settings.videoBitrate + merge.settings.audioBitrate) / 8 * 1000,
    )
    : ''
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
  const timelineTrackRows = merge.videoTracks.length + merge.audioTracks.length + merge.textTracks.length
  const timelineTracksTemplate = `repeat(${timelineTrackRows}, 54px)`
  const timelineContentHeight = 30 + timelineTrackRows * 60
  const frameStep = 1 / Math.max(1, merge.settings.fps || 30)

  const updatePreviewGeometry = useCallback(() => {
    const screen = previewScreenRef.current
    const video = previewRef.current
    if (!screen || screen.clientWidth <= 0 || screen.clientHeight <= 0) {
      setOutputCanvasGeometry(null)
      setCropGeometry(null)
      return
    }
    const availableWidth = Math.max(1, screen.clientWidth - 20)
    const availableHeight = Math.max(1, screen.clientHeight - 20)
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
    const panel = previewPanelRef.current
    if (!panel) return undefined
    const observer = new ResizeObserver((entries) => {
      const height = Math.ceil(entries[0]?.contentRect.height ?? panel.getBoundingClientRect().height)
      setPreviewPanelHeight((current) => Math.abs(current - height) > 1 ? height : current)
    })
    observer.observe(panel)
    window.requestAnimationFrame(() => {
      const height = Math.ceil(panel.getBoundingClientRect().height)
      setPreviewPanelHeight((current) => Math.abs(current - height) > 1 ? height : current)
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    window.requestAnimationFrame(updatePreviewGeometry)
  }, [previewClip?.id, updatePreviewGeometry])

  useEffect(() => {
    previewRef.current = previewClip ? previewVideoRefs.current.get(previewClip.id) ?? null : null
    window.requestAnimationFrame(updatePreviewGeometry)
  }, [previewClip, updatePreviewGeometry])

  const scrubGlobal = useCallback((time: number, forceMediaUpdate = false) => {
    const next = clamp(time, 0, Math.max(0, totalDuration))
    const layouts = activeLayoutsAt(clipLayouts, next, videoTrackIds)
    const layout = layouts[0] ?? null
    playheadRef.current = next
    playbackClock.setTime(next)
    setStructuralPlayhead((current) => Math.abs(current - next) >= 0.0005 ? next : current)
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
      if (Math.abs(video.currentTime - target) >= 0.008) video.currentTime = target
      const targetVolume = active.item.muted ? 0 : (active.item.volume ?? 1)
      const nodes = getOrCreateAudioNodes(video)
      if (nodes) {
        nodes.gain.gain.value = targetVolume
      } else {
        video.volume = clamp(targetVolume, 0, 1)
      }
    })
    const activeAudios = audioLayouts.filter((l) => next >= l.start && next < l.end && audioTrackIds.includes(l.trackId))
    previewAudioRefs.current.forEach((audio, id) => {
      const active = activeAudios.find((l) => l.item.id === id)
      if (!active) {
        if (!audio.paused) audio.pause()
        return
      }
      if (audio.readyState < 1) return
      const target = active.item.trimStart + Math.max(0, next - active.start)
      if (Math.abs(audio.currentTime - target) >= 0.008) audio.currentTime = target
      const targetVolume = 1
      const nodes = getOrCreateAudioNodes(audio)
      if (nodes) {
        nodes.gain.gain.value = targetVolume
      } else {
        audio.volume = clamp(targetVolume, 0, 1)
      }
    })
    lastScrubMediaUpdateRef.current = now
  }, [clipLayouts, audioLayouts, totalDuration, videoTrackIds, audioTrackIds, getOrCreateAudioNodes, playbackClock])

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

  const keepTimelineTimeVisible = useCallback((time: number, margin = 56) => {
    const viewport = timelineScrollRef.current
    const content = timelineRef.current
    if (!viewport || !content || totalDuration <= 0) return
    const x = time / totalDuration * content.offsetWidth
    const visibleStart = viewport.scrollLeft + margin
    const visibleEnd = viewport.scrollLeft + viewport.clientWidth - margin
    if (x < visibleStart) viewport.scrollLeft = Math.max(0, x - margin)
    else if (x > visibleEnd) viewport.scrollLeft = Math.max(0, x - viewport.clientWidth + margin)
  }, [totalDuration])

  const autoScrollTimelineAtPointer = useCallback((clientX: number) => {
    const viewport = timelineScrollRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const edgeSize = Math.min(72, rect.width * 0.16)
    let delta = 0
    if (clientX < rect.left + edgeSize) {
      delta = -Math.max(3, (rect.left + edgeSize - clientX) * 0.22)
    } else if (clientX > rect.right - edgeSize) {
      delta = Math.max(3, (clientX - (rect.right - edgeSize)) * 0.22)
    }
    if (delta !== 0) viewport.scrollLeft += delta
  }, [])

  useEffect(() => {
    let changed = false
    const videoUpdates: { id: string; patch: { startTime: number } }[] = []
    
    for (const track of merge.videoTracks) {
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
    for (const track of merge.audioTracks) {
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
      if (videoUpdates.length) merge.updateVideos(videoUpdates, false)
      if (audioUpdates.length) merge.updateAudios(audioUpdates, false)
    }
  }, [clipLayouts, audioLayouts, merge])

  useEffect(() => {
    const activeVideos = activeLayoutsAt(clipLayouts, playheadRef.current, videoTrackIds)
    previewVideoRefs.current.forEach((video, id) => {
      const layout = activeVideos.find((l) => l.item.id === id)
      if (!layout) {
        if (!video.paused) video.pause()
        return
      }
      const target = layout.item.trimStart + Math.max(0, playheadRef.current - layout.start)
      const sync = () => {
        if (Math.abs(video.currentTime - target) > 0.2) video.currentTime = target
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

    const activeAudios = audioLayouts.filter((l) => playheadRef.current >= l.start && playheadRef.current < l.end && audioTrackIds.includes(l.trackId))
    previewAudioRefs.current.forEach((audio, id) => {
      const layout = activeAudios.find((l) => l.item.id === id)
      if (!layout) {
        if (!audio.paused) audio.pause()
        return
      }
      const target = layout.item.trimStart + Math.max(0, playheadRef.current - layout.start)
      const sync = () => {
        if (Math.abs(audio.currentTime - target) > 0.2) audio.currentTime = target
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
  }, [activeLayoutKey, clipLayouts, audioLayouts, playing, videoTrackIds, audioTrackIds, getOrCreateAudioNodes])

  useEffect(() => {
    if (!playing) {
      previewVideoRefs.current.forEach((video) => {
        video.pause()
        video.playbackRate = 1
      })
      previewAudioRefs.current.forEach((audio) => {
        audio.pause()
        audio.playbackRate = 1
      })
      return undefined
    }
    playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
    lastPlaybackStructureKeyRef.current = playbackStructureKey(
      clipLayouts,
      merge.textItems,
      playheadRef.current,
      videoTrackIds,
    )
    const update = (timestamp: number) => {
      const next = playbackAnchorRef.current.time + (timestamp - playbackAnchorRef.current.timestamp) / 1000
      if (next >= totalDuration) {
        playheadRef.current = totalDuration
        playbackClock.setTime(totalDuration)
        setStructuralPlayhead(totalDuration)
        setPlaying(false)
        return
      }
      playheadRef.current = next
      playbackClock.setTime(next)
      const structureKey = playbackStructureKey(clipLayouts, merge.textItems, next, videoTrackIds)
      if (structureKey !== lastPlaybackStructureKeyRef.current) {
        lastPlaybackStructureKeyRef.current = structureKey
        setStructuralPlayhead(next)
        const layouts = activeLayoutsAt(clipLayouts, next, videoTrackIds)
        if (layouts.length > 0) {
          setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layouts[0].item.id)
        }
      }
      if (timestamp - lastPlaybackUiUpdateRef.current > 66) {
        keepTimelineTimeVisible(next)
        lastPlaybackUiUpdateRef.current = timestamp
      }
      if (timestamp - lastPlaybackSyncRef.current > 450) {
        const layouts = activeLayoutsAt(clipLayouts, next, videoTrackIds)
        previewVideoRefs.current.forEach((video, id) => {
          const layout = layouts.find((l) => l.item.id === id)
          if (!layout) {
            if (!video.paused) video.pause()
            return
          }
          if (video.readyState < 1) return
          const target = layout.item.trimStart + Math.max(0, next - layout.start)
          const drift = target - video.currentTime
          if (Math.abs(drift) > 0.4) {
            video.currentTime = target
            video.playbackRate = 1
          } else {
            video.playbackRate = clamp(1 + drift * 0.12, 0.97, 1.03)
          }
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
        const activeAudios = audioLayouts.filter((l) => next >= l.start && next < l.end && audioTrackIds.includes(l.trackId))
        previewAudioRefs.current.forEach((audio, id) => {
          const layout = activeAudios.find((l) => l.item.id === id)
          if (!layout) {
            if (!audio.paused) audio.pause()
            return
          }
          if (audio.readyState < 1) return
          const target = layout.item.trimStart + Math.max(0, next - layout.start)
          const drift = target - audio.currentTime
          if (Math.abs(drift) > 0.4) {
            audio.currentTime = target
            audio.playbackRate = 1
          } else {
            audio.playbackRate = clamp(1 + drift * 0.12, 0.97, 1.03)
          }
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
      playbackFrameRef.current = window.requestAnimationFrame(update)
    }
    playbackFrameRef.current = window.requestAnimationFrame(update)
    return () => {
      if (playbackFrameRef.current !== null) window.cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = null
    }
  }, [
    clipLayouts,
    audioLayouts,
    keepTimelineTimeVisible,
    merge.textItems,
    playing,
    playbackClock,
    totalDuration,
    videoTrackIds,
    audioTrackIds,
    getOrCreateAudioNodes,
  ])

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

  function zoomTimeline(nextZoom: number, anchorClientX?: number) {
    const viewport = timelineScrollRef.current
    const content = timelineRef.current
    const currentZoom = timelineZoom
    const next = normalizeTimelineZoom(nextZoom)
    if (Math.abs(next - currentZoom) < 0.001) return
    const viewportRect = viewport?.getBoundingClientRect()
    const contentRect = content?.getBoundingClientRect()
    const anchorX = anchorClientX ?? (viewportRect ? viewportRect.left + viewportRect.width / 2 : 0)
    const anchorTime = contentRect ? timelineTimeFromClientX(anchorX, contentRect, totalDuration, timelinePixelsPerSecondScaled) : playheadRef.current
    setTimelineZoom(next)
    window.requestAnimationFrame(() => {
      const nextViewport = timelineScrollRef.current
      const nextContent = timelineRef.current
      const nextViewportRect = nextViewport?.getBoundingClientRect()
      if (!nextViewport || !nextContent || !nextViewportRect || totalDuration <= 0) return
      const anchorOffset = anchorClientX === undefined ? nextViewportRect.width / 2 : anchorX - nextViewportRect.left
      nextViewport.scrollLeft = Math.max(0, anchorTime * timelinePixelsPerSecondForZoom(next) - anchorOffset)
    })
  }

  function commitTimelineZoomDraft() {
    const nextPercent = Number(timelineZoomDraft)
    if (Number.isFinite(nextPercent)) zoomTimeline(nextPercent)
    setTimelineZoomEditing(false)
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
      keepTimelineTimeVisible(playheadRef.current)
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
  }, [frameStep, keepTimelineTimeVisible, merge.settings.fps, seekGlobal, totalDuration])

  function handleTimelineWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.deltaY === 0) return
    zoomTimeline(timelineZoom + (event.deltaY < 0 ? timelineZoomStep : -timelineZoomStep), event.clientX)
  }

  function handlePlayheadHandlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !timelineRef.current || totalDuration <= 0) return
    event.preventDefault()
    event.stopPropagation()
    let active = false
    let latestClientX = event.clientX
    const resumeAfterDrag = playing

    const update = () => {
      if (!active) return
      autoScrollTimelineAtPointer(latestClientX)
      const contentRect = timelineRef.current?.getBoundingClientRect()
      if (contentRect) scrubGlobal(timelineTimeFromClientX(latestClientX, contentRect, totalDuration, timelinePixelsPerSecondScaled))
      playheadDragFrameRef.current = window.requestAnimationFrame(update)
    }
    const longPressTimer = window.setTimeout(() => {
      active = true
      setPlaying(false)
      setPlayheadDragging(true)
      playheadDragFrameRef.current = window.requestAnimationFrame(update)
    }, 240)
    const move = (pointerEvent: PointerEvent) => {
      latestClientX = pointerEvent.clientX
    }
    const end = () => {
      window.clearTimeout(longPressTimer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (playheadDragFrameRef.current !== null) window.cancelAnimationFrame(playheadDragFrameRef.current)
      playheadDragFrameRef.current = null
      if (active) {
        const contentRect = timelineRef.current?.getBoundingClientRect()
        if (contentRect) scrubGlobal(timelineTimeFromClientX(latestClientX, contentRect, totalDuration, timelinePixelsPerSecondScaled), true)
        if (resumeAfterDrag) seekGlobal(playheadRef.current, true)
      }
      setPlayheadDragging(false)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleTimelinePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !timelineRef.current || totalDuration <= 0) return
    const target = event.target as Element
    if (target.closest('.timeline-clip-grip')) return

    event.preventDefault()
    setSelectedAudioId('')
    setSelectedTextId('')
    const rect = timelineRef.current.getBoundingClientRect()
    const resumeAfterSeek = playing
    if (resumeAfterSeek) setPlaying(false)
    let latestTime = timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondScaled)

    const scheduleSeek = (clientX: number) => {
      latestTime = timelineTimeFromClientX(clientX, rect, totalDuration, timelinePixelsPerSecondScaled)
      if (timelineSeekFrameRef.current !== null) return
      timelineSeekFrameRef.current = window.requestAnimationFrame(() => {
        timelineSeekFrameRef.current = null
        scrubGlobal(latestTime)
      })
    }
    const move = (pointerEvent: PointerEvent) => scheduleSeek(pointerEvent.clientX)
    const end = (pointerEvent: PointerEvent) => {
      latestTime = timelineTimeFromClientX(pointerEvent.clientX, rect, totalDuration, timelinePixelsPerSecondScaled)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (timelineSeekFrameRef.current !== null) {
        window.cancelAnimationFrame(timelineSeekFrameRef.current)
        timelineSeekFrameRef.current = null
      }
      scrubGlobal(latestTime, true)
      if (resumeAfterSeek) seekGlobal(latestTime, true)
    }

    scheduleSeek(event.clientX)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

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
      merge.setError('该视频片段的音频已经在音频线上。')
      setClipContextMenu(null)
      return
    }
    merge.addAudio({
      path: layout.item.path,
      name: `${layout.item.name} · 原音`,
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

  function handleVideoClipPointerDown(event: React.PointerEvent, layout: ClipLayout) {
    if (event.button !== 0 || !timelineRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)
    setClipContextMenu(null)
    setAudioContextMenu(null)

    const startX = event.clientX
    let latestX = startX
    let latestY = event.clientY
    let longPressActive = false
    let scrubbed = false
    const resumeAfterSeek = playing
    const initialRect = timelineRef.current.getBoundingClientRect()
    const pointerOffset = timelineTimeFromClientX(event.clientX, initialRect, totalDuration, timelinePixelsPerSecondScaled) - layout.start
    const longPressTimer = window.setTimeout(() => {
      longPressActive = true
      if (resumeAfterSeek) setPlaying(false)
      merge.beginHistoryTransaction()
      setDraggedClipId(layout.item.id)
    }, 320)

    const move = (pointerEvent: PointerEvent) => {
      latestX = pointerEvent.clientX
      latestY = pointerEvent.clientY
      if (longPressActive) {
        autoScrollTimelineAtPointer(latestX)
        if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null
          const contentRect = timelineRef.current?.getBoundingClientRect()
          if (!contentRect) return
          const trackId = trackIdAtPoint(latestX, latestY, 'video') ?? layout.trackId
          const nextStart = resolveTimelineDragStart(
            timelineTimeFromClientX(latestX, contentRect, totalDuration, timelinePixelsPerSecondScaled) - pointerOffset,
            layout.duration,
            layout.item.id,
            trackId,
            clipLayouts,
            merge.videoTracks.length > 1,
          )
          merge.moveVideoTo(layout.item.id, nextStart, trackId, false)
        })
        return
      }
      if (Math.abs(latestX - startX) < 4) return
      scrubbed = true
      window.clearTimeout(longPressTimer)
      if (resumeAfterSeek) setPlaying(false)
      const contentRect = timelineRef.current?.getBoundingClientRect()
      if (contentRect) scheduleTimelineSeek(latestX, contentRect)
    }
    const end = (pointerEvent: PointerEvent) => {
      latestX = pointerEvent.clientX
      window.clearTimeout(longPressTimer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)

      if (longPressActive) {
        if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
        const contentRect = timelineRef.current?.getBoundingClientRect()
        if (contentRect) {
          const trackId = trackIdAtPoint(latestX, latestY, 'video') ?? layout.trackId
          const nextStart = resolveTimelineDragStart(
            timelineTimeFromClientX(latestX, contentRect, totalDuration, timelinePixelsPerSecondScaled) - pointerOffset,
            layout.duration,
            layout.item.id,
            trackId,
            clipLayouts,
            merge.videoTracks.length > 1,
          )
          merge.moveVideoTo(layout.item.id, nextStart, trackId, false)
        }
        merge.endHistoryTransaction()
        setDraggedClipId('')
        return
      }

      if (timelineSeekFrameRef.current !== null) {
        window.cancelAnimationFrame(timelineSeekFrameRef.current)
        timelineSeekFrameRef.current = null
      }
      const contentRect = timelineRef.current?.getBoundingClientRect()
      const nextTime = contentRect ? timelineTimeFromClientX(latestX, contentRect, totalDuration, timelinePixelsPerSecondScaled) : playheadRef.current
      scrubGlobal(nextTime, true)
      if (scrubbed && resumeAfterSeek) seekGlobal(nextTime, true)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleVideoTrimPointerDown(event: React.PointerEvent, layout: ClipLayout, edge: 'start' | 'end') {
    if (event.button !== 0 || !timelineRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)
    const contentRect = timelineRef.current.getBoundingClientRect()
    const secondsPerPixel = totalDuration > 0 ? totalDuration / Math.max(1, contentRect.width) : frameStep
    const originX = event.clientX
    const clipId = layout.item.id
    const info = metadata[normalizePath(layout.item.path)]
    const sourceDuration = sourceDurationForClip(layout.item, info)
    const startTrim = layout.item.trimStart
    const sourceEnd = clipSourceEnd(layout.item, info)
    const minDuration = frameStep
    let latestEvent: PointerEvent | null = null
    let frame: number | null = null
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const delta = (pointerEvent.clientX - originX) * secondsPerPixel
      if (edge === 'start') {
        const trimStart = clamp(startTrim + delta, 0, sourceEnd - minDuration)
        merge.updateVideo(clipId, {
          trimStart,
          startTime: Math.max(0, layout.start + trimStart - startTrim),
        }, false)
        return
      }
      const trimEnd = clamp(sourceEnd + delta, startTrim + minDuration, sourceDuration)
      merge.updateVideo(clipId, { trimEnd }, false)
    }
    const move = (pointerEvent: PointerEvent) => {
      latestEvent = pointerEvent
      autoScrollTimelineAtPointer(pointerEvent.clientX)
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (latestEvent) apply(latestEvent)
      })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (frame !== null) window.cancelAnimationFrame(frame)
      apply(pointerEvent)
      merge.endHistoryTransaction()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleAudioPointerDown(event: React.PointerEvent, layout: AudioClipLayout) {
    if (event.button !== 0 || !timelineRef.current || totalDuration <= 0) return
    const audio = layout.item
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId('')
    setSelectedTextId('')
    setSelectedAudioId(audio.id)
    setClipContextMenu(null)
    setAudioContextMenu(null)
    const initialRect = timelineRef.current.getBoundingClientRect()
    const pointerOffset = timelineTimeFromClientX(event.clientX, initialRect, totalDuration, timelinePixelsPerSecondScaled) - layout.start
    let longPressActive = false
    let latestX = event.clientX
    let latestY = event.clientY
    const longPressTimer = window.setTimeout(() => {
      longPressActive = true
      merge.beginHistoryTransaction()
      setDraggedAudioId(audio.id)
    }, 320)
    const move = (pointerEvent: PointerEvent) => {
      latestX = pointerEvent.clientX
      latestY = pointerEvent.clientY
      if (!longPressActive) return
      autoScrollTimelineAtPointer(latestX)
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null
        const contentRect = timelineRef.current?.getBoundingClientRect()
        if (!contentRect) return
        const next = timelineTimeFromClientX(latestX, contentRect, totalDuration, timelinePixelsPerSecondScaled) - pointerOffset
        const trackId = trackIdAtPoint(latestX, latestY, 'audio') ?? audio.trackId
        merge.updateAudio(audio.id, {
          startTime: resolveTimelineDragStart(
            next,
            layout.duration,
            audio.id,
            trackId,
            audioLayouts,
            merge.audioTracks.length > 1,
          ),
          trackId,
        }, false)
      })
    }
    const end = () => {
      window.clearTimeout(longPressTimer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
      if (longPressActive) merge.endHistoryTransaction()
      setDraggedAudioId('')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleTextPointerDown(event: React.PointerEvent, item: MergeTextItem) {
    if (event.button !== 0 || !timelineRef.current || totalDuration <= 0) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId('')
    setSelectedAudioId('')
    setSelectedTextId(item.id)
    setClipContextMenu(null)
    setAudioContextMenu(null)
    setTextContextMenu(null)
    const initialRect = timelineRef.current.getBoundingClientRect()
    const pointerOffset = timelineTimeFromClientX(event.clientX, initialRect, totalDuration, timelinePixelsPerSecondScaled) - item.startTime
    let longPressActive = false
    let latestX = event.clientX
    let latestY = event.clientY
    const longPressTimer = window.setTimeout(() => {
      longPressActive = true
      merge.beginHistoryTransaction()
      setDraggedAudioId(item.id)
    }, 260)
    const move = (pointerEvent: PointerEvent) => {
      latestX = pointerEvent.clientX
      latestY = pointerEvent.clientY
      if (!longPressActive) return
      autoScrollTimelineAtPointer(latestX)
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = window.requestAnimationFrame(() => {
        const contentRect = timelineRef.current?.getBoundingClientRect()
        if (!contentRect) return
        const next = timelineTimeFromClientX(latestX, contentRect, totalDuration, timelinePixelsPerSecondScaled) - pointerOffset
        const trackId = trackIdAtPoint(latestX, latestY, 'text') ?? item.trackId
        merge.updateText(item.id, { startTime: clamp(next, 0, totalDuration), trackId }, false)
      })
    }
    const end = () => {
      window.clearTimeout(longPressTimer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
      if (longPressActive) merge.endHistoryTransaction()
      setDraggedAudioId('')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

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

    const apply = (clientX: number, clientY: number) => {
      merge.updateText(textId, {
        x: clamp((clientX - canvasRect.left) / Math.max(1, canvasRect.width), 0, 1),
        y: clamp((clientY - canvasRect.top) / Math.max(1, canvasRect.height), 0, 1),
      }, false)
    }
    const move = (pointerEvent: PointerEvent) => apply(pointerEvent.clientX, pointerEvent.clientY)
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      apply(pointerEvent.clientX, pointerEvent.clientY)
      merge.endHistoryTransaction()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function scheduleTimelineSeek(clientX: number, rect: DOMRect) {
    const nextTime = timelineTimeFromClientX(clientX, rect, totalDuration, timelinePixelsPerSecondScaled)
    if (timelineSeekFrameRef.current !== null) window.cancelAnimationFrame(timelineSeekFrameRef.current)
    timelineSeekFrameRef.current = window.requestAnimationFrame(() => {
      timelineSeekFrameRef.current = null
      scrubGlobal(nextTime)
    })
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
    let latestEvent: PointerEvent | null = null
    let frame: number | null = null

    merge.beginHistoryTransaction()
    activeLayouts.forEach((active, index) => {
      const rect = startingRects[index]
      merge.updateVideo(active.item.id, {
        layoutCustom: true,
        layoutX: rect.x,
        layoutY: rect.y,
        layoutWidth: rect.width,
        layoutHeight: rect.height,
      }, false)
    })

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
      merge.updateVideo(layout.item.id, {
        layoutCustom: true,
        layoutX: next.x,
        layoutY: next.y,
        layoutWidth: next.width,
        layoutHeight: next.height,
      }, false)
    }
    const move = (pointerEvent: PointerEvent) => {
      latestEvent = pointerEvent
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (latestEvent) apply(latestEvent)
      })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (frame !== null) window.cancelAnimationFrame(frame)
      apply(pointerEvent)
      merge.endHistoryTransaction()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleGroupLayoutPointerDown(event: React.PointerEvent<HTMLElement>, handle: CropHandle) {
    if (event.button !== 0 || activeLayouts.length < 2 || !outputCanvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const canvasRect = outputCanvasRef.current.getBoundingClientRect()
    const startRects = previewLayoutRects(activeLayouts.map((layout) => layout.item))
    const startGroup = boundingLayoutRect(startRects)
    const origin = normalizedPoint(event.clientX, event.clientY, canvasRect)
    let latestEvent: PointerEvent | null = null
    let frame: number | null = null
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const point = normalizedPoint(pointerEvent.clientX, pointerEvent.clientY, canvasRect)
      const nextGroup = resizeNormalizedRect(startGroup, origin, point, handle)
      const transformed = transformLayoutRects(startRects, startGroup, nextGroup)
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
    }
    const move = (pointerEvent: PointerEvent) => {
      latestEvent = pointerEvent
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (latestEvent) apply(latestEvent)
      })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (frame !== null) window.cancelAnimationFrame(frame)
      apply(pointerEvent)
      merge.endHistoryTransaction()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
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
    const start = { ...previewSize }
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
    let latestEvent: PointerEvent | null = null
    let updateFrame: number | null = null
    merge.beginHistoryTransaction()

    const apply = (pointerEvent: PointerEvent) => {
      const point = cropPointFromClient(pointerEvent.clientX, pointerEvent.clientY, canvasRect, cropGeometry)
      const next = resizeCropRect(startRect, startPoint, point, handle, cropGeometry)
      merge.updateVideo(clipId, {
        cropEnabled: true,
        cropX: next.x,
        cropY: next.y,
        cropWidth: next.width,
        cropHeight: next.height,
      }, false)
    }
    const move = (pointerEvent: PointerEvent) => {
      latestEvent = pointerEvent
      if (updateFrame !== null) return
      updateFrame = window.requestAnimationFrame(() => {
        updateFrame = null
        if (latestEvent) apply(latestEvent)
      })
    }
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (updateFrame !== null) window.cancelAnimationFrame(updateFrame)
      apply(pointerEvent)
      merge.endHistoryTransaction()
    }

    if (handle === 'draw') {
      merge.updateVideo(clipId, {
        cropEnabled: true,
        cropX: startPoint.x,
        cropY: startPoint.y,
        cropWidth: 2,
        cropHeight: 2,
      }, false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
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
          {merge.running ? (
            <NeonButton tone="red" type="button" onClick={() => void cancelVideoMerge()}><Pause />取消导出</NeonButton>
          ) : (
            <NeonButton type="button" disabled={merge.items.length === 0} onClick={() => void startMerge()}><Download />导出视频</NeonButton>
          )}
        </div>
      </GlassPanel>

      <div
        className="editor-main-grid"
        style={{
          width: `min(100%, ${previewSize.width + 390}px)`,
          gridTemplateColumns: `minmax(480px, ${previewSize.width}px) minmax(320px, 380px)`,
        }}
      >
        <GlassPanel ref={previewPanelRef} className="editor-preview-panel frame-preview-card video-preview-card" style={{ maxWidth: 'none' }}>
          <MergePreviewCanvas
            previewScreenRef={previewScreenRef}
            outputCanvasRef={outputCanvasRef}
            previewRef={previewRef}
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
            playbackClock={playbackClock}
            playing={playing}
            totalDuration={totalDuration}
            previewStart={previewLayout?.start ?? null}
            previewDuration={previewLayout?.duration ?? 0}
            onPreviewLayoutPointerDown={handlePreviewLayoutPointerDown}
            onPreviewTextPointerDown={handlePreviewTextPointerDown}
            onEditText={editTextItem}
            onGroupLayoutPointerDown={handleGroupLayoutPointerDown}
            onCropPointerDown={handleCropPointerDown}
            onResetCropSelection={resetCropSelection}
            onResetPreviewSize={() => setPreviewSize(defaultPreviewSize)}
            onPreviewResizePointerDown={handlePreviewResizePointerDown}
            onPreviewMetadataLoaded={updatePreviewGeometry}
            onSeek={seekGlobal}
            onTogglePlayback={togglePlayback}
            onNudge={nudgePlayhead}
          />
          <section className="editor-advanced-settings editor-advanced-settings-below-video">
            <div className="editor-advanced-title">高级输出设置</div>
            {activeLayouts.length > 1 && (
              <div className="editor-overlap-layout">
                <span>重叠视频布局</span>
                <button type="button" onClick={() => applyActiveVideoLayout('auto')}>自动</button>
                <button type="button" onClick={() => applyActiveVideoLayout('grid')}>宫格</button>
                <button type="button" onClick={() => applyActiveVideoLayout('horizontal')}>左右</button>
                <button type="button" onClick={() => applyActiveVideoLayout('vertical')}>上下</button>
                <button
                  type="button"
                  className={groupEditing ? 'active' : ''}
                  onClick={() => setGroupEditingKey(groupEditing ? '' : activeLayoutKey)}
                >
                  {groupEditing ? '完成整体调整' : '选择组合画面'}
                </button>
                <button type="button" onClick={resetActiveGroupSize}>整体还原</button>
                <label>
                  <Toggle
                    checked={merge.settings.snapToVideos}
                    onChange={(snapToVideos) => merge.setSettings({ snapToVideos })}
                  />
                  自动贴合
                </label>
                <small>也可直接拖动画面；不会允许视频互相覆盖。</small>
              </div>
            )}
            <div className="editor-encoding-card">
              <div className="editor-encoding-preset">
                <label>
                  <ParameterHint
                    label="编码预设"
                    tip="预设工作流：一次选择分辨率、帧率、编码器、质量和音频参数；随后仍可单独修改。"
                  />
                  <SelectInput
                    value={encodingPresetValue}
                    onChange={(event) => {
                      const preset = encodingPresets.find((item) => item.id === event.target.value)
                      if (!preset) return
                      setCustomResolutionSelected(false)
                      merge.setSettings(preset.settings)
                    }}
                  >
                    {encodingPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                    <option value="custom" disabled>自定义设置</option>
                  </SelectInput>
                </label>
                <small>
                  {selectedEncodingPreset?.detail ?? '当前参数已自定义'}
                  {' · '}实际使用 FFmpeg 渲染。
                </small>
              </div>
              <div className="editor-encoding-grid">
                <label>
                  <ParameterHint label="视频编码器" tip="H.264 兼容性更广；H.265 通常更省空间，但编码更慢、旧设备兼容性较弱。" />
                  <SelectInput
                    value={merge.settings.videoEncoder}
                    onChange={(event) => merge.setSettings({ videoEncoder: event.target.value as MergeVideoEncoder })}
                  >
                    <option value="h264">H.264 (x264)</option>
                    <option value="h265">H.265 (x265)</option>
                  </SelectInput>
                </label>
                <label>
                  <ParameterHint
                    label="码率控制"
                    tip="恒定质量会按画面复杂度动态分配码率；平均码率用于控制文件大小，建议同时开启两遍编码。"
                  />
                  <SelectInput
                    value={merge.settings.rateControl}
                    onChange={(event) => {
                      const rateControl = event.target.value as MergeRateControl
                      merge.setSettings({ rateControl, twoPass: rateControl === 'bitrate' && merge.settings.twoPass })
                    }}
                  >
                    <option value="quality">恒定质量（推荐）</option>
                    <option value="bitrate">平均码率</option>
                  </SelectInput>
                </label>
                {merge.settings.rateControl === 'quality' ? (
                  <NumberField
                    label="恒定质量 RF"
                    tip="数值越低画质越高、文件越大。1080p 可从 20–23 开始尝试；该模式无法预先确定文件大小。"
                    value={merge.settings.crf}
                    min={0}
                    max={51}
                    onChange={(crf) => merge.setSettings({ crf })}
                  />
                ) : (
                  <NumberField
                    label="视频码率 (kbps)"
                    tip="平均视频码率决定目标体积。数值越高通常画质越好、文件越大。"
                    value={merge.settings.videoBitrate}
                    min={100}
                    max={100000}
                    step={100}
                    onChange={(videoBitrate) => merge.setSettings({ videoBitrate })}
                  />
                )}
                <label>
                  <ParameterHint label="编码速度" tip="速度越慢通常压缩效率越高；同等画质下文件可能更小，但导出时间更长。" />
                  <SelectInput
                    value={merge.settings.encoderPreset}
                    onChange={(event) => merge.setSettings({ encoderPreset: event.target.value })}
                  >
                    <option value="ultrafast">极速</option>
                    <option value="veryfast">很快</option>
                    <option value="fast">快速</option>
                    <option value="medium">均衡</option>
                    <option value="slow">慢速</option>
                    <option value="slower">更慢</option>
                    <option value="veryslow">最慢</option>
                  </SelectInput>
                </label>
                <NumberField
                  label="音频码率 (kbps)"
                  tip="音频统一编码为 AAC；语音可用 96–128，普通视频建议 160–192。"
                  value={merge.settings.audioBitrate}
                  min={32}
                  max={512}
                  step={16}
                  onChange={(audioBitrate) => merge.setSettings({ audioBitrate })}
                />
                {merge.settings.rateControl === 'bitrate' && (
                  <label className="editor-toggle-row compact editor-two-pass-toggle">
                    <ParameterHint label="两遍编码" tip="第一遍分析复杂度，第二遍分配码率；目标体积和画质分配更稳定，但耗时接近翻倍。" />
                    <Toggle checked={merge.settings.twoPass} onChange={(twoPass) => merge.setSettings({ twoPass })} />
                  </label>
                )}
              </div>
              <div className="editor-encoding-estimate">
                {merge.settings.rateControl === 'bitrate'
                  ? `按当前 ${formatPreciseTime(totalDuration)} 时间线估算约 ${estimatedOutputSize || '0 MB'}（含音频，不含少量封装开销）`
                  : '恒定质量模式：最终大小由画面复杂度决定，无法仅根据源文件大小预先确定。'}
              </div>
            </div>
            <div className="editor-advanced-inline">
              <label>
                <ParameterHint label="画面适配" tip="完整画面会保留整个视频，空余区域使用所选背景色；铺满画布会裁掉超出部分。" />
                <SelectInput value={merge.settings.fitMode} onChange={(event) => merge.setSettings({ fitMode: event.target.value as MergeFitMode })}>
                  <option value="contain">完整画面</option>
                  <option value="cover">铺满画布</option>
                  <option value="stretch">拉伸填满</option>
                </SelectInput>
              </label>
              <label>
                <ParameterHint label="空余区域" tip="当输出分辨率大于视频或使用“完整画面”时，用黑色或白色填充空余区域。" />
                <SelectInput
                  value={merge.settings.canvasBackground}
                  onChange={(event) => merge.setSettings({ canvasBackground: event.target.value === 'white' ? 'white' : 'black' })}
                >
                  <option value="black">留黑</option>
                  <option value="white">留白</option>
                </SelectInput>
              </label>
              <NumberField
                label="输出帧率"
                tip="有效设置。FFmpeg 会按该数值重新采样输出视频；数值越高越流畅，文件和编码开销也越大。"
                value={merge.settings.fps}
                min={1}
                max={120}
                onChange={(fps) => merge.setSettings({ fps })}
              />
              <label>
                <ParameterHint label="输出分割" tip="有效设置。可把结果按每段时长或指定数量拆成多个 MP4 文件；不分割则生成一个文件。" />
                <SelectInput value={merge.settings.splitMode} onChange={(event) => merge.setSettings({ splitMode: event.target.value as MergeSplitMode })}>
                  <option value="none">不分割</option>
                  <option value="duration">按时长</option>
                  <option value="count">按数量</option>
                </SelectInput>
              </label>
              {merge.settings.splitMode !== 'none' && (
                <NumberField label={merge.settings.splitMode === 'duration' ? '每段秒数' : '分割数量'} value={merge.settings.splitValue} min={1} onChange={(splitValue) => merge.setSettings({ splitValue })} />
              )}
            </div>
          </section>
        </GlassPanel>

        <MergeInspectorPanel
          panelHeight={previewPanelHeight}
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
      </div>

      <GlassPanel className="editor-timeline-panel">
        <div className="timeline-tool-card">
          <div>
            <button type="button" title="缩小时间线" onClick={() => zoomTimeline(timelineZoom - timelineZoomStep)}>
              <Minus />
            </button>
            <button type="button" title="放大时间线" onClick={() => zoomTimeline(timelineZoom + timelineZoomStep)}>
              <Plus />
            </button>
            <button type="button" title="重置时间线缩放" onClick={() => zoomTimeline(timelineZoomDefault)}>
              <RotateCcw />
            </button>
          </div>
          {timelineZoomEditing ? (
            <input
              className="timeline-zoom-input"
              value={timelineZoomDraft}
              autoFocus
              onChange={(event) => setTimelineZoomDraft(event.target.value)}
              onBlur={commitTimelineZoomDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitTimelineZoomDraft()
                if (event.key === 'Escape') setTimelineZoomEditing(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="timeline-zoom-value"
              title="双击输入自定义缩放百分比"
              onDoubleClick={() => {
                setTimelineZoomDraft(String(Math.round(timelineZoom)))
                setTimelineZoomEditing(true)
              }}
            >
              {Math.round(timelineZoom)}%
            </button>
          )}
        </div>
        <div className="timeline-workspace">
          <div className="timeline-track-labels">
            <span><Clock3 />时间线</span>
            <div className="timeline-track-label-list" style={{ gridTemplateRows: timelineTracksTemplate }}>
              {merge.videoTracks.map((track) => (
                <button
                  type="button"
                  key={track.id}
                  title="右键新建视频线"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'video', trackId: track.id })
                  }}
                >
                  <Film />{track.name}
                </button>
              ))}
              {merge.audioTracks.map((track) => (
                <button
                  type="button"
                  key={track.id}
                  title="右键新建音频线"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'audio', trackId: track.id })
                  }}
                >
                  <Music2 />{track.name}
                </button>
              ))}
              {merge.textTracks.map((track) => (
                <button
                  type="button"
                  key={track.id}
                  title="右键新建或管理文本线"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    const rect = timelineRef.current?.getBoundingClientRect()
                    setTrackContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      kind: 'text',
                      trackId: track.id,
                      time: rect ? timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondScaled) : playheadRef.current,
                    })
                  }}
                >
                  <Type />{track.name}
                </button>
              ))}
            </div>
          </div>
          <div ref={timelineScrollRef} className="timeline-scroll-viewport" onWheel={handleTimelineWheel}>
            <div
              ref={timelineRef}
              className="timeline-scroll-content"
              style={{ width: timelineContentWidth, minWidth: '100%', minHeight: timelineContentHeight }}
            >
              <div className="timeline-ruler">
                {timeTicks(totalDuration, totalDuration * timelinePixelsPerSecondScaled).map((tick) => (
                  <time key={tick} style={{ left: timelinePixel(tick, timelinePixelsPerSecondScaled) }}>{formatTick(tick)}</time>
                ))}
              </div>
              <div className="timeline-tracks" style={{ gridTemplateRows: timelineTracksTemplate }} onPointerDown={handleTimelinePointerDown}>
                {merge.videoTracks.map((track) => (
                <div
                  className="timeline-video-track"
                  key={track.id}
                  data-track-id={track.id}
                  data-track-kind="video"
                  onContextMenu={(event) => {
                    if ((event.target as Element).closest('.timeline-video-clip')) return
                    event.preventDefault()
                    setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'video', trackId: track.id })
                  }}
                >
                  {clipLayouts.filter((layout) => layout.trackId === track.id).map((layout) => (
                    <button
                      type="button"
                      className={[
                        'timeline-video-clip',
                        effectiveSelectedClipId === layout.item.id ? 'selected' : '',
                        draggedClipId === layout.item.id ? 'long-press-dragging' : '',
                      ].filter(Boolean).join(' ')}
                      style={{
                        left: timelinePixel(layout.start, timelinePixelsPerSecondScaled),
                        width: timelineLength(layout.duration, timelinePixelsPerSecondScaled),
                      }}
                      key={layout.item.id}
                      title={`${layout.item.name}\n${formatPreciseTime(layout.duration)}\n短按或拖动定位播放头，长按后可移动到任意视频线和时间位置，右键打开操作菜单`}
                      onPointerDown={(event) => handleVideoClipPointerDown(event, layout)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const rect = timelineRef.current?.getBoundingClientRect()
                        const contextTime = rect
                          ? clamp(timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondScaled), layout.start, layout.end)
                          : layout.start
                        setSelectedAudioId('')
                        setSelectedTextId('')
                        setSelectedClipId(layout.item.id)
                        setAudioContextMenu(null)
                        setTextContextMenu(null)
                        setClipContextMenu({
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 390)),
                          layout,
                          time: contextTime,
                        })
                      }}
                    >
                      <span
                        className="timeline-clip-trim-handle start"
                        aria-hidden="true"
                        onPointerDown={(event) => handleVideoTrimPointerDown(event, layout, 'start')}
                      />
                      <span className="timeline-clip-grip" aria-hidden="true">
                        <GripVertical />
                      </span>
                      <span>{layout.item.name}</span>
                      {layout.item.rotation !== 0 && <RotateCw className="timeline-transform-icon" aria-label={`右旋 ${layout.item.rotation} 度`} />}
                      {layout.item.cropEnabled && <SquareDashedMousePointer className="timeline-transform-icon" aria-label="该片段已裁剪" />}
                      {layout.item.muted && <VolumeX className="timeline-muted-icon" aria-label="该片段已静音" />}
                      <small>{formatPreciseTime(layout.duration)}</small>
                      <span
                        className="timeline-clip-trim-handle end"
                        aria-hidden="true"
                        onPointerDown={(event) => handleVideoTrimPointerDown(event, layout, 'end')}
                      />
                    </button>
                  ))}
                </div>
                ))}
                {merge.audioTracks.map((track) => {
                  const trackAudio = audioLayouts.filter((layout) => layout.trackId === track.id)
                  return (
                <div
                  className={`timeline-audio-track ${trackAudio.length === 0 ? 'empty' : ''}`}
                  key={track.id}
                  data-track-id={track.id}
                  data-track-kind="audio"
                  onContextMenu={(event) => {
                    if ((event.target as Element).closest('.timeline-audio-clip')) return
                    event.preventDefault()
                    setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'audio', trackId: track.id })
                  }}
                >
                  {trackAudio.length === 0 && <span className="timeline-empty-hint">拖入音频，或右键视频片段提取音频</span>}
                  {trackAudio.map((audioLayout) => {
                    const audio = audioLayout.item
                    return (
                      <button
                        type="button"
                        className={[
                          'timeline-audio-clip',
                          selectedAudioId === audio.id ? 'selected' : '',
                          draggedAudioId === audio.id ? 'long-press-dragging' : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left: timelinePixel(audioLayout.start, timelinePixelsPerSecondScaled),
                          width: timelineLength(audioLayout.duration, timelinePixelsPerSecondScaled),
                        }}
                        key={audio.id}
                        title={`${audio.name}\n长按后拖动可调整时间线位置，右键打开操作菜单`}
                        onPointerDown={(event) => handleAudioPointerDown(event, audioLayout)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setSelectedClipId('')
                          setSelectedTextId('')
                          setSelectedAudioId(audio.id)
                          setClipContextMenu(null)
                          setTextContextMenu(null)
                          setAudioContextMenu({
                            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
                            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)),
                            layout: audioLayout,
                          })
                        }}
                      >
                        <Music2 />
                        <span>{audio.name}</span>
                      </button>
                    )
                  })}
                </div>
                  )
                })}
                {merge.textTracks.map((track) => {
                  const trackText = merge.textItems.filter((item) => item.trackId === track.id)
                  return (
                <div
                  className={`timeline-text-track ${trackText.length === 0 ? 'empty' : ''}`}
                  key={track.id}
                  data-track-id={track.id}
                  data-track-kind="text"
                  onContextMenu={(event) => {
                    if ((event.target as Element).closest('.timeline-text-clip')) return
                    event.preventDefault()
                    const rect = timelineRef.current?.getBoundingClientRect()
                    setTrackContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      kind: 'text',
                      trackId: track.id,
                      time: rect ? timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondScaled) : playheadRef.current,
                    })
                  }}
                >
                  {trackText.length === 0 && <span className="timeline-empty-hint">右键添加文本片段</span>}
                  {trackText.map((item) => (
                    <button
                      type="button"
                      className={[
                        'timeline-text-clip',
                        selectedTextId === item.id ? 'selected' : '',
                        draggedAudioId === item.id ? 'long-press-dragging' : '',
                      ].filter(Boolean).join(' ')}
                      style={{
                        left: timelinePixel(item.startTime, timelinePixelsPerSecondScaled),
                        width: timelineLength(item.duration, timelinePixelsPerSecondScaled),
                      }}
                      key={item.id}
                      title={`${item.text}\n长按后拖动可调整时间线位置，右键打开操作菜单`}
                      onPointerDown={(event) => handleTextPointerDown(event, item)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setSelectedClipId('')
                        setSelectedAudioId('')
                        setSelectedTextId(item.id)
                        setClipContextMenu(null)
                        setAudioContextMenu(null)
                        setTextContextMenu({
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 210)),
                          text: item,
                        })
                      }}
                    >
                      <Type />
                      <span>{item.text}</span>
                    </button>
                  ))}
                </div>
                  )
                })}
              </div>
              {totalDuration > 0 && (
                <MergeTimelinePlayhead
                  clock={playbackClock}
                  pixelsPerSecond={timelinePixelsPerSecondScaled}
                  dragging={playheadDragging}
                  onPointerDown={handlePlayheadHandlePointerDown}
                />
              )}
            </div>
          </div>
        </div>
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
      {trackContextMenu && createPortal(
        <Translated>
        <div
          className="video-context-menu clip-context-menu track-context-menu"
          style={{
            left: Math.max(8, Math.min(trackContextMenu.x, window.innerWidth - 220)),
            top: Math.max(8, Math.min(trackContextMenu.y, window.innerHeight - 120)),
          }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {trackContextMenu.kind === 'text' && (
            <button type="button" role="menuitem" onClick={() => addTextAt(trackContextMenu.trackId, trackContextMenu.time ?? playheadRef.current)}>
              <Type />添加文本片段
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => {
            if (trackContextMenu.kind === 'video') merge.addVideoTrack()
            else if (trackContextMenu.kind === 'audio') merge.addAudioTrack()
            else merge.addTextTrack()
            setTrackContextMenu(null)
          }}>
            <Plus />新建{trackKindLabel(trackContextMenu.kind)}
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            disabled={trackContextMenu.kind === 'video'
              ? merge.videoTracks.length <= 1
              : trackContextMenu.kind === 'audio'
                ? merge.audioTracks.length <= 1
                : merge.textTracks.length <= 1}
            title="删除轨道后，其中的片段会移动到保留的第一条同类轨道"
            onClick={() => {
              const removed = trackContextMenu.kind === 'video'
                ? merge.removeVideoTrack(trackContextMenu.trackId)
                : trackContextMenu.kind === 'audio'
                  ? merge.removeAudioTrack(trackContextMenu.trackId)
                  : merge.removeTextTrack(trackContextMenu.trackId)
              if (!removed) merge.setError(`${trackKindLabel(trackContextMenu.kind)}至少保留一条。`)
              setTrackContextMenu(null)
            }}
          >
            <Trash2 />删除当前{trackKindLabel(trackContextMenu.kind)}
          </button>
        </div>
        </Translated>,
        document.body,
      )}
      {clipContextMenu && createPortal(
        <Translated>
        <div
          className="video-context-menu clip-context-menu"
          style={{
            left: clipContextMenu.x,
            top: clipContextMenu.y,
            maxHeight: Math.max(160, window.innerHeight - clipContextMenu.y - 8),
          }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <strong title={clipContextMenu.layout.item.path}>{clipContextMenu.layout.item.name}</strong>
          <span className="clip-context-menu-range">
            {formatPreciseTime(clipContextMenu.layout.item.trimStart)} - {formatPreciseTime(clipSourceEnd(
              clipContextMenu.layout.item,
              metadata[normalizePath(clipContextMenu.layout.item.path)],
            ))}
          </span>
          <button type="button" role="menuitem" onClick={() => {
            seekGlobal(clipContextMenu.time)
            setClipContextMenu(null)
          }}>
            <SkipBack />定位到右键位置
          </button>
          <button type="button" role="menuitem" onClick={() => {
            seekGlobal(clipContextMenu.layout.start, true)
            setClipContextMenu(null)
          }}>
            <Play />从片段开头播放
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canSplitClipAt(clipContextMenu.layout, clipContextMenu.time, metadata)}
            onClick={() => splitClipAt(clipContextMenu.layout, clipContextMenu.time)}
          >
            <Scissors />在右键位置拆分
          </button>
          <button type="button" role="menuitem" onClick={() => extractClipAudio(clipContextMenu.layout)}>
            <Volume2 />提取该片段音频
          </button>
          <button type="button" role="menuitem" onClick={() => {
            merge.updateVideo(clipContextMenu.layout.item.id, { muted: !clipContextMenu.layout.item.muted })
            setClipContextMenu(null)
          }}>
            {clipContextMenu.layout.item.muted ? <Volume2 /> : <VolumeX />}
            {clipContextMenu.layout.item.muted ? '恢复片段原音' : '静音该视频片段'}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            rotateClipRight(clipContextMenu.layout.item)
            setClipContextMenu(null)
          }}>
            <RotateCw />向右旋转 90°（默认）
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={clipContextMenu.layout.item.rotation === 0}
            onClick={() => {
              restoreClipRotation(clipContextMenu.layout.item)
              setClipContextMenu(null)
            }}
          >
            <RotateCcw />还原旋转
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const layout = clipContextMenu.layout
            const info = metadata[normalizePath(layout.item.path)]
            setSelectedAudioId('')
            setSelectedClipId(layout.item.id)
            seekGlobal(layout.start)
            if (!layout.item.cropEnabled && info?.readable) {
              const dimensions = rotatedDimensions(info.width, info.height, layout.item.rotation)
              merge.updateVideo(layout.item.id, {
                cropEnabled: true,
                cropX: 0,
                cropY: 0,
                cropWidth: dimensions.width,
                cropHeight: dimensions.height,
              })
            }
            setClipContextMenu(null)
            window.requestAnimationFrame(() => setCropEditing(true))
          }}>
            <SquareDashedMousePointer />调整视频尺寸
          </button>
          <button type="button" role="menuitem" onClick={() => duplicateClip(clipContextMenu.layout)}>
            <Copy />复制片段
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!previousTrackLayout(clipLayouts, clipContextMenu.layout, -1)}
            onClick={() => moveClip(clipContextMenu.layout, -1)}
          >
            <ArrowLeft />向前移动
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!previousTrackLayout(clipLayouts, clipContextMenu.layout, 1)}
            onClick={() => moveClip(clipContextMenu.layout, 1)}
          >
            <ArrowRight />向后移动
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={clipContextMenu.layout.item.trimStart === 0 && clipContextMenu.layout.item.trimEnd === 0}
            onClick={() => {
              merge.updateVideo(clipContextMenu.layout.item.id, { trimStart: 0, trimEnd: 0 })
              setClipContextMenu(null)
            }}
          >
            <RotateCcw />恢复完整片段
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setClipContextMenu(null)
            void revealInFolder(clipContextMenu.layout.item.path).catch((error) => merge.setError(normalizeBackendError(error)))
          }}>
            <FolderOpen />在文件夹中显示
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => removeClip(clipContextMenu.layout)}>
            <Trash2 />删除片段
          </button>
        </div>
        </Translated>,
        document.body,
      )}
      {audioContextMenu && createPortal(
        <Translated>
        <div
          className="video-context-menu clip-context-menu audio-context-menu"
          style={{
            left: audioContextMenu.x,
            top: audioContextMenu.y,
            maxHeight: Math.max(160, window.innerHeight - audioContextMenu.y - 8),
          }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <strong title={audioContextMenu.layout.item.path}>{audioContextMenu.layout.item.name}</strong>
          <span className="clip-context-menu-range">
            时间线位置 {formatPreciseTime(audioContextMenu.layout.start)}
          </span>
          <button type="button" role="menuitem" onClick={() => {
            seekGlobal(audioContextMenu.layout.start)
            setAudioContextMenu(null)
          }}>
            <SkipBack />定位到音频开头
          </button>
          <button type="button" role="menuitem" onClick={() => {
            merge.updateAudio(audioContextMenu.layout.item.id, { startTime: playheadRef.current })
            setAudioContextMenu(null)
          }}>
            <ArrowRight />移动到播放头
          </button>
          <button type="button" role="menuitem" disabled={audioContextMenu.layout.start === 0} onClick={() => {
            merge.updateAudio(audioContextMenu.layout.item.id, { startTime: 0 })
            setAudioContextMenu(null)
          }}>
            <RotateCcw />移到时间线起点
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setAudioContextMenu(null)
            void revealInFolder(audioContextMenu.layout.item.path).catch((error) => merge.setError(normalizeBackendError(error)))
          }}>
            <FolderOpen />在文件夹中显示
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => {
            merge.removeAudio(audioContextMenu.layout.item.id)
            setSelectedAudioId('')
            setAudioContextMenu(null)
          }}>
            <Trash2 />删除音频片段
          </button>
        </div>
        </Translated>,
        document.body,
      )}
      {textContextMenu && createPortal(
        <Translated>
        <div
          className="video-context-menu clip-context-menu text-context-menu"
          style={{
            left: textContextMenu.x,
            top: textContextMenu.y,
            maxHeight: Math.max(160, window.innerHeight - textContextMenu.y - 8),
          }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <strong title={textContextMenu.text.text}>{textContextMenu.text.text}</strong>
          <span className="clip-context-menu-range">
            时间线位置 {formatPreciseTime(textContextMenu.text.startTime)}
          </span>
          <button type="button" role="menuitem" onClick={() => {
            seekGlobal(textContextMenu.text.startTime)
            setTextContextMenu(null)
          }}>
            <SkipBack />定位到文本开头
          </button>
          <button type="button" role="menuitem" onClick={() => {
            merge.updateText(textContextMenu.text.id, { startTime: playheadRef.current })
            setTextContextMenu(null)
          }}>
            <ArrowRight />移动到播放头
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => {
            merge.removeText(textContextMenu.text.id)
            setSelectedTextId('')
            setTextContextMenu(null)
          }}>
            <Trash2 />删除文本片段
          </button>
        </div>
        </Translated>,
        document.body,
      )}
    </div>
    </Translated>
  )
}

function trackIdAtPoint(clientX: number, clientY: number, kind: 'video' | 'audio' | 'text') {
  const element = document.elementFromPoint(clientX, clientY)
  const track = element?.closest<HTMLElement>(`[data-track-kind="${kind}"]`)
  return track?.dataset.trackId ?? null
}

function trackKindLabel(kind: 'video' | 'audio' | 'text') {
  if (kind === 'video') return '视频线'
  if (kind === 'audio') return '音频线'
  return '文本线'
}
