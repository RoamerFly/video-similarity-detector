import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Download,
  FolderOpen,
  Music2,
  Pause,
  PanelRight,
  Plus,
  Redo2,
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
import { MergeInspectorPanel } from '@/components/merge/MergeInspectorPanel'
import { MergeNumberField as NumberField } from '@/components/merge/MergeNumberField'
import { MergeTimeline } from '@/components/merge/MergeTimeline'
import { MergeTextPropertiesDialog } from '@/components/merge/MergeTextPropertiesDialog'
import {
  MergeTimelineContextMenus,
  type AudioContextMenuState,
  type ClipContextMenuState,
  type TextContextMenuState,
  type TrackContextMenuState,
} from '@/components/merge/MergeTimelineContextMenus'
import { MergeAdvancedSettingsDialog } from '@/components/merge/MergeAdvancedSettingsDialog'
import { MergePreviewCanvas } from '@/components/merge/MergePreviewCanvas'
import { MergeResolutionSimulationDialog, type ResolutionPreviewClipOption } from '@/components/merge/MergeResolutionSimulationDialog'
import { shouldShowOverlapToolbar } from '@/components/merge/mergeToolbarVisibility'
import { timelineLayoutForRows } from '@/components/merge/timelineLayout'
import { requestMediaSeek } from '@/components/merge/MediaSeekCoordinator'
import { PlaybackClock } from '@/components/merge/PlaybackClock'
import { canResumeMedia, driftCorrection, targetMediaTime } from '@/components/merge/playbackPolicy'
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
  globalVideoTimelineGaps,
  previousTrackLayout,
  timelineGapPositionUpdates,
  timelineExchangeOrder,
  timelineExchangeUpdates,
  timelineTimeFromClientX,
  type ClipLayout,
} from '@/components/merge/timelineModel'
import { Translated } from '@/i18n/Translated'
import { useI18n } from '@/i18n/useI18n'
import {
  cancelVideoMerge,
  fileName,
  localFileSrc,
  normalizeBackendError,
  readTextFile,
  revealInFolder,
  runVideoMerge,
  renderVideoMergePreview,
  selectAudioFiles,
  selectOutputDirectory,
  selectSubtitleFiles,
  selectVideoFiles,
  validateVideoExport,
} from '@/services/backend'
import {
  useMergeStore,
  type MergeQueueItem,
  type MergeRotation,
  type MergeTextItem,
} from '@/stores/mergeStore'
import { useMergeRuntimeStore } from '@/stores/mergeRuntimeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useShallow } from 'zustand/react/shallow'

const scrubMediaIntervalMs = 32
const minimumOutputDimension = 16
const maximumOutputDimension = 16384
const emptyTimelineResolutionLimit = { width: 3840, height: 2160 }
const commonResolutionOptions = [
  { label: '超清 2160p', width: 3840, height: 2160 },
  { label: '高清 1080p', width: 1920, height: 1080 },
  { label: '高清 720p', width: 1280, height: 720 },
  { label: '竖屏 1080p', width: 1080, height: 1920 },
  { label: '方形 1080', width: 1080, height: 1080 },
  { label: '标清 480p', width: 854, height: 480 },
]

const mediaAttributeEpsilon = 0.001
type MergeOutputFormat = 'mp4' | 'mkv' | 'mov'
export type ExportDirectoryMode = 'source' | 'browse'

const mergeOutputFormats: Array<{ value: MergeOutputFormat; label: string }> = [
  { value: 'mp4', label: 'MP4（兼容性最佳）' },
  { value: 'mkv', label: 'MKV（保留轨道信息）' },
  { value: 'mov', label: 'MOV（剪辑软件友好）' },
]

type ExportValidationResult = Awaited<ReturnType<typeof validateVideoExport>>

// eslint-disable-next-line react-refresh/only-export-components -- pure export-form helpers are covered by MergePage tests.
export function outputNameStem(value: string) {
  const trimmed = value.trim()
  return trimmed.replace(/\.(?:mp4|mkv|mov)$/i, '')
}

// eslint-disable-next-line react-refresh/only-export-components -- pure export-form helpers are covered by MergePage tests.
export function basicOutputNameError(value: string) {
  const name = value.trim()
  if (!name) return '请输入导出文件名称。'
  if (/[<>:"/\\|?*]/.test(name) || Array.from(name).some((character) => character.charCodeAt(0) < 32)) return '文件名称不能包含 \\/:*?"<>| 或控制字符。'
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) return '文件名称不能使用系统保留名称。'
  if (name.endsWith('.') || name.endsWith(' ')) return '文件名称不能以句点或空格结尾。'
  return ''
}

// eslint-disable-next-line react-refresh/only-export-components -- pure export-form helper is covered by MergePage tests.
export function canConfirmExport(
  directory: string,
  name: string,
  validating: boolean,
  validation: ExportValidationResult | null,
) {
  if (!directory.trim() || basicOutputNameError(name) || validating || !validation) return false
  return !validation.nameTooLong && (validation.valid || validation.nameConflict)
}

function syncMediaAttributes(
  media: HTMLMediaElement,
  options: { muted: boolean; volume: number; playbackRate?: number },
) {
  if (media.muted !== options.muted) media.muted = options.muted
  const volume = clamp(options.volume, 0, 1)
  if (Math.abs(media.volume - volume) > mediaAttributeEpsilon) media.volume = volume
  if (options.playbackRate !== undefined && Math.abs(media.playbackRate - options.playbackRate) > mediaAttributeEpsilon) {
    media.playbackRate = options.playbackRate
  }
}

function resetInactiveMedia(media: HTMLMediaElement) {
  if (!media.paused) media.pause()
  if (Math.abs(media.playbackRate - 1) > mediaAttributeEpsilon) media.playbackRate = 1
  if (media.readyState >= 1 && media.currentTime > mediaAttributeEpsilon) {
    try { media.currentTime = 0 } catch { /* decoder may be unloading */ }
  }
}

function pauseMediaAtCurrentPosition(media: HTMLMediaElement) {
  if (!media.paused) media.pause()
  if (Math.abs(media.playbackRate - 1) > mediaAttributeEpsilon) media.playbackRate = 1
}

function releasePreviewMedia(media: HTMLMediaElement) {
  media.pause()
  media.removeAttribute('src')
  // Explicitly tell the browser to tear down the decoder and buffered data.
  // Merely pausing leaves large source buffers alive while FFmpeg starts.
  media.load()
}

export function MergePage() {
  const { t, tm } = useI18n()
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
    duplicateVideo: state.duplicateVideo,
    endHistoryTransaction: state.endHistoryTransaction,
    items: state.items,
    reorderVideos: state.reorderVideos,
    moveVideoTo: state.moveVideoTo,
    redo: state.redo,
    removeAudio: state.removeAudio,
    removeAudioTrack: state.removeAudioTrack,
    reorderAudios: state.reorderAudios,
    removeText: state.removeText,
    removeTextTrack: state.removeTextTrack,
    removeVideo: state.removeVideo,
    removeVideoTrack: state.removeVideoTrack,
    setSettings: state.setSettings,
    settings: state.settings,
    splitVideo: state.splitVideo,
    textItems: state.textItems,
    textTracks: state.textTracks,
    undo: state.undo,
    updateAudio: state.updateAudio,
    updateAudios: state.updateAudios,
    updateText: state.updateText,
    updateTexts: state.updateTexts,
    updateVideo: state.updateVideo,
    updateVideos: state.updateVideos,
    videoTracks: state.videoTracks,
  })))
  const mergeRuntime = useMergeRuntimeStore(useShallow((state) => ({
    clearLogs: state.clearLogs,
    running: state.running,
    setError: state.setError,
    setProgress: state.setProgress,
    setRunning: state.setRunning,
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
    onError: mergeRuntime.setError,
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
  const lastPlaybackAudioKeyRef = useRef('')
  const activeVideoIdsRef = useRef<Set<string>>(new Set())
  const activeAudioIdsRef = useRef<Set<string>>(new Set())
  const playheadRef = useRef(0)
  const playbackAnchorRef = useRef({ time: 0, timestamp: 0 })
  // Every structural/play-state transition invalidates pending media events.
  // loadedmetadata can arrive long after a clip was removed or replaced.
  const playbackGenerationRef = useRef(0)
  const playingRef = useRef(false)
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({})
  const [selectedClipId, setSelectedClipId] = useState('')
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const [selectedTextId, setSelectedTextId] = useState('')
  const [textPropertiesId, setTextPropertiesId] = useState('')
  const [playbackClock] = useState(() => new PlaybackClock())
  const [timelineDragPreview] = useState(() => new TimelineDragPreview())
  const [previewEditDraft] = useState(() => new PreviewEditDraft())
  const { withPointerLifecycle } = usePreviewEditInteractions()
  const [structuralPlayhead, setStructuralPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  playingRef.current = playing
  const releaseAllPreviewMedia = useEventCallback(() => {
    ++playbackGenerationRef.current
    previewVideoRefs.current.forEach((video) => releasePreviewMedia(video))
    previewAudioRefs.current.forEach((audio) => releasePreviewMedia(audio))
    activeVideoIdsRef.current.clear()
    activeAudioIdsRef.current.clear()
  })
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === 'undefined' ? 900 : window.innerHeight)
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [customResolutionSelected, setCustomResolutionSelected] = useState(false)
  const [draggedClipId, setDraggedClipId] = useState('')
  const [draggedAudioId, setDraggedAudioId] = useState('')
  const [draggedTextId, setDraggedTextId] = useState('')
  const [playheadDragging, setPlayheadDragging] = useState(false)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuState | null>(null)
  const [audioContextMenu, setAudioContextMenu] = useState<AudioContextMenuState | null>(null)
  const [textContextMenu, setTextContextMenu] = useState<TextContextMenuState | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuState | null>(null)
  const [cropEditing, setCropEditing] = useState(false)
  const [groupEditingKey, setGroupEditingKey] = useState('')
  const [cropGeometry, setCropGeometry] = useState<CropGeometry | null>(null)
  const [outputCanvasGeometry, setOutputCanvasGeometry] = useState<PreviewCanvasGeometry | null>(null)
  const [resolutionPreviewDialogOpen, setResolutionPreviewDialogOpen] = useState(false)
  const [resolutionPreviewCalculating, setResolutionPreviewCalculating] = useState(false)
  const [resolutionPreviewMode, setResolutionPreviewMode] = useState<'live' | 'computed'>('live')
  const [resolutionPreviewRangeMode, setResolutionPreviewRangeMode] = useState<'clips' | 'duration'>('clips')
  const [resolutionPreviewDuration, setResolutionPreviewDuration] = useState(5)
  const [resolutionPreviewClipIds, setResolutionPreviewClipIds] = useState<string[]>([])
  const [resolutionPreview, setResolutionPreview] = useState<{ path: string; start: number; duration: number; signature: string } | null>(null)
  const [exportDirectoryDialogOpen, setExportDirectoryDialogOpen] = useState(false)
  const [exportDirectoryMode, setExportDirectoryMode] = useState<ExportDirectoryMode>('browse')
  const [exportSourceDirectory, setExportSourceDirectory] = useState('')
  const [exportDirectoryDraft, setExportDirectoryDraft] = useState('')
  const [exportNameDraft, setExportNameDraft] = useState('merged_video')
  const [exportFormatDraft, setExportFormatDraft] = useState<MergeOutputFormat>('mp4')
  const [exportValidation, setExportValidation] = useState<ExportValidationResult | null>(null)
  const [validatedExportKey, setValidatedExportKey] = useState('')
  const [exportValidating, setExportValidating] = useState(false)
  const exportValidationRequestRef = useRef(0)
  const cropSessionRef = useRef<{
    clipId: string
    cropEnabled: boolean
    cropX: number
    cropY: number
    cropWidth: number
    cropHeight: number
  } | null>(null)
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

  const sourceDirectories = useMemo(
    () => sourceDirectoriesFromPaths(merge.items.map((item) => item.path)),
    [merge.items],
  )
  const selectedSourceDirectory = sourceDirectories.includes(exportSourceDirectory)
    ? exportSourceDirectory
    : sourceDirectories[0] ?? ''
  const resolvedExportDirectory = resolveExportDirectory(exportDirectoryMode, selectedSourceDirectory, exportDirectoryDraft)

  useEffect(() => {
    if (!exportDirectoryDialogOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setExportDirectoryDialogOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [exportDirectoryDialogOpen])

  useEffect(() => {
    if (!exportDirectoryDialogOpen) {
      return undefined
    }
    const directory = resolvedExportDirectory
    const name = outputNameStem(exportNameDraft)
    if (!directory || !name) {
      return undefined
    }

    const requestId = ++exportValidationRequestRef.current
    const validationKey = `${directory}\u0000${name}\u0000${exportFormatDraft}`
    const timer = window.setTimeout(() => {
      setExportValidating(true)
      void validateVideoExport(directory, name, exportFormatDraft)
        .then((result) => {
          if (requestId === exportValidationRequestRef.current) {
            setExportValidation(result)
            setValidatedExportKey(validationKey)
          }
        })
        .catch((error) => {
          if (requestId !== exportValidationRequestRef.current) return
          setExportValidation({
            valid: false,
            nameTooLong: false,
            nameConflict: false,
            suggestedName: '',
            targetDir: directory,
            message: normalizeBackendError(error),
          } as ExportValidationResult)
          setValidatedExportKey(validationKey)
        })
        .finally(() => {
          if (requestId === exportValidationRequestRef.current) setExportValidating(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [exportDirectoryDialogOpen, exportFormatDraft, exportNameDraft, resolvedExportDirectory])

  const videoTrackIds = useMemo(() => merge.videoTracks.map((track) => track.id), [merge.videoTracks])
  const clipLayouts = useMemo(() => {
    return buildClipLayouts(merge.items, videoTrackIds, metadata)
  }, [merge.items, metadata, videoTrackIds])
  const audioTrackIds = useMemo(() => merge.audioTracks.map((track) => track.id), [merge.audioTracks])
  const audioLayouts = useMemo(() => {
    return buildAudioLayouts(merge.audioItems, audioTrackIds, audioDurations, metadata)
  }, [audioDurations, audioTrackIds, merge.audioItems, metadata])
  const visibleVideoTracks = useMemo(
    () => visibleTracks(merge.videoTracks),
    [merge.videoTracks],
  )
  const visibleAudioTracks = useMemo(
    () => visibleTracks(merge.audioTracks),
    [merge.audioTracks],
  )
  const visibleTextTracks = useMemo(
    () => visibleTracks(merge.textTracks),
    [merge.textTracks],
  )
  const playbackIndex = useMemo(
    () => createTimelinePlaybackIndex(clipLayouts, merge.textItems, videoTrackIds, audioLayouts),
    [audioLayouts, clipLayouts, merge.textItems, videoTrackIds],
  )
  const videoDuration = Math.max(0, ...clipLayouts.map((layout) => layout.end))
  const audioTimelineEnd = Math.max(0, ...audioLayouts.map((layout) => layout.end))
  const textTimelineEnd = Math.max(0, ...merge.textItems.map((item) => item.startTime + item.duration))
  const totalDuration = Math.max(videoDuration, audioTimelineEnd, textTimelineEnd)
  const resolutionPreviewSignature = useMemo(
    () => JSON.stringify({ settings: merge.settings, videos: merge.items, audios: merge.audioItems, texts: merge.textItems }),
    [merge.audioItems, merge.items, merge.settings, merge.textItems],
  )
  const exportValidationKey = `${resolvedExportDirectory}\u0000${outputNameStem(exportNameDraft)}\u0000${exportFormatDraft}`
  const currentExportValidation = validatedExportKey === exportValidationKey ? exportValidation : null
  const exportValidationMessage = basicOutputNameError(exportNameDraft)
    || (exportValidating ? '正在检查导出文件名与路径…' : '')
    || (currentExportValidation?.nameConflict ? '导出文件夹有重名，继续导出会在末尾加上10位的秒级时间戳' : '')
    || (currentExportValidation?.nameTooLong ? (currentExportValidation.message || '导出文件名称或完整路径超过系统可容纳的最长长度。') : '')
    || (currentExportValidation && !currentExportValidation.valid ? (currentExportValidation.message || '导出文件名称或路径无效，请修改后重试。') : '')
  const validResolutionPreview = resolutionPreview?.signature === resolutionPreviewSignature ? resolutionPreview : null
  const effectiveResolutionPreviewMode = validResolutionPreview && resolutionPreviewMode === 'computed' ? 'computed' : 'live'
  const timelineContentWidth = timelineViewportWidth || 720
  const timelinePixelsPerSecondFit = totalDuration > 0
    ? timelineContentWidth / totalDuration
    : 0
  const effectiveSelectedClipId = clipLayouts.some((layout) => layout.item.id === selectedClipId)
    ? selectedClipId
    : selectedAudioId || selectedTextId ? '' : clipLayouts[0]?.item.id ?? ''
  const selectedLayout = clipLayouts.find((layout) => layout.item.id === effectiveSelectedClipId) ?? null
  const selectedClip = selectedLayout?.item ?? null
  const resolutionPreviewTrackId = selectedLayout?.trackId ?? visibleVideoTracks[0]?.id ?? merge.videoTracks[0]?.id ?? ''
  const resolutionPreviewClips = useMemo<ResolutionPreviewClipOption[]>(() => clipLayouts
    .filter((layout) => layout.trackId === resolutionPreviewTrackId)
    .sort((a, b) => a.start - b.start)
    .map((layout) => ({
      id: layout.item.id,
      label: fileName(layout.item.path).replace(/\.[^.]+$/, ''),
      start: layout.start,
      duration: layout.duration,
    })), [clipLayouts, resolutionPreviewTrackId])
  const activeLayouts = playbackIndex.activeVideosAt(structuralPlayhead)
  const activeTextItems = merge.textItems.filter(
    (item) => structuralPlayhead >= item.startTime && structuralPlayhead < item.startTime + item.duration,
  )
  const activeLayoutKey = activeLayouts.map((layout) => layout.item.id).join('|')
  const activeAudioLayoutKey = playbackIndex.activeAudiosAt(structuralPlayhead).map((layout) => layout.item.id).join('|')
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
  const textPropertiesItem = merge.textItems.find((item) => item.id === textPropertiesId) ?? null
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
    '--merge-timeline-toggle-height': `${timelineLayout.toggleHeight}px`,
    '--merge-timeline-padding-top': `${timelineLayout.panelPaddingTop}px`,
    '--merge-timeline-padding-bottom': `${timelineLayout.panelPaddingBottom}px`,
    '--merge-timeline-border-width': `${timelineLayout.panelBorderWidth}px`,
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
    if (layout && !cropEditing) {
      setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layout.item.id)
    }

    const now = Date.now()
    if (!forceMediaUpdate && now - lastScrubMediaUpdateRef.current < scrubMediaIntervalMs) return
    const activeVideoLayouts = new Map(layouts.map((active) => [active.item.id, active]))
    const previousVideoIds = activeVideoIdsRef.current
    previewVideoRefs.current.forEach((video, id) => {
      const active = activeVideoLayouts.get(id)
      if (!active) {
        // Scrubbing can happen dozens of times per second. Only tear down a
        // decoder when its active interval actually ended.
        if (previousVideoIds.has(id)) resetInactiveMedia(video)
        return
      }
      const targetVolume = active.item.muted ? 0 : (active.item.volume ?? 1)
      // Keep one predictable audio route. Routing the same element through
      // WebAudio while also using muted/volume caused silent previews and
      // made old contexts survive page transitions.
      syncMediaAttributes(video, {
        muted: active.item.muted,
        volume: targetVolume,
        playbackRate: 1,
      })
      if (video.readyState < 1) return
      const target = active.item.trimStart + Math.max(0, next - active.start)
      requestMediaSeek(video, target)
    })
    activeVideoIdsRef.current = new Set(activeVideoLayouts.keys())
    const activeAudios = playbackIndex.activeAudiosAt(next)
    const activeAudioLayouts = new Map(activeAudios.map((active) => [active.item.id, active]))
    const previousAudioIds = activeAudioIdsRef.current
    previewAudioRefs.current.forEach((audio, id) => {
      const active = activeAudioLayouts.get(id)
      if (!active) {
        if (previousAudioIds.has(id)) resetInactiveMedia(audio)
        return
      }
      syncMediaAttributes(audio, {
        muted: Boolean(active.item.muted),
        volume: active.item.muted ? 0 : (active.item.volume ?? 1),
        playbackRate: 1,
      })
      if (audio.readyState < 1) return
      const target = active.item.trimStart + Math.max(0, next - active.start)
      requestMediaSeek(audio, target)
    })
    activeAudioIdsRef.current = new Set(activeAudioLayouts.keys())
    lastScrubMediaUpdateRef.current = now
  }, [cropEditing, totalDuration, playbackClock, playbackIndex])

  const seekGlobal = useCallback((time: number, autoPlay = false) => {
    if (!autoPlay && playingRef.current) setPlaying(false)
    scrubGlobal(time, true)
    playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
    window.requestAnimationFrame(() => {
      if (!autoPlay) return
      playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
      setPlaying(true)
    })
  }, [scrubGlobal])

  const handlePreviewVideoReady = useEventCallback((layout: ClipLayout, video: HTMLVideoElement) => {
    const active = playbackIndex.activeVideosAt(playheadRef.current)
      .find((candidate) => candidate.item.id === layout.item.id)
    if (!active) return
    const target = targetMediaTime(active.item.trimStart, playheadRef.current, active.start)
    requestMediaSeek(video, target, 0.05)
    syncMediaAttributes(video, {
      muted: active.item.muted,
      volume: active.item.muted ? 0 : (active.item.volume ?? 1),
      playbackRate: 1,
    })
    if (playingRef.current) void video.play().catch(() => undefined)
  })

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
    const generation = ++playbackGenerationRef.current
    const isCurrent = (id: string, kind: 'video' | 'audio') => {
      const layouts = kind === 'video'
        ? playbackIndex.activeVideosAt(playheadRef.current)
        : playbackIndex.activeAudiosAt(playheadRef.current)
      return canResumeMedia(
        generation,
        playbackGenerationRef.current,
        playingRef.current,
        layouts.map((layout) => layout.item.id),
        id,
      )
    }
    const listeners: Array<() => void> = []
    const activeVideos = playbackIndex.activeVideosAt(playheadRef.current)
    const activeVideoLayouts = new Map(activeVideos.map((layout) => [layout.item.id, layout]))
    previewVideoRefs.current.forEach((video, id) => {
      const layout = activeVideoLayouts.get(id)
      if (!layout) {
        resetInactiveMedia(video)
        return
      }
      const sync = () => {
        if (playbackGenerationRef.current !== generation) {
          resetInactiveMedia(video)
          return
        }
        const currentLayout = new Map(
          playbackIndex.activeVideosAt(playheadRef.current).map((candidate) => [candidate.item.id, candidate]),
        ).get(id)
        if (!currentLayout) {
          resetInactiveMedia(video)
          return
        }
        const target = targetMediaTime(currentLayout.item.trimStart, playheadRef.current, currentLayout.start)
        requestMediaSeek(video, target, 0.2)
        syncMediaAttributes(video, {
          muted: currentLayout.item.muted,
          volume: currentLayout.item.muted ? 0 : (currentLayout.item.volume ?? 1),
          playbackRate: 1,
        })
        if (isCurrent(id, 'video')) void video.play().catch(() => undefined)
        else video.pause()
      }
      if (video.readyState >= 1) sync()
      else {
        video.addEventListener('loadedmetadata', sync, { once: true })
        listeners.push(() => video.removeEventListener('loadedmetadata', sync))
      }
    })

    const activeAudios = playbackIndex.activeAudiosAt(playheadRef.current)
    const activeAudioLayouts = new Map(activeAudios.map((layout) => [layout.item.id, layout]))
    previewAudioRefs.current.forEach((audio, id) => {
      const layout = activeAudioLayouts.get(id)
      if (!layout) {
        resetInactiveMedia(audio)
        return
      }
      const sync = () => {
        if (playbackGenerationRef.current !== generation) {
          resetInactiveMedia(audio)
          return
        }
        const currentLayout = new Map(
          playbackIndex.activeAudiosAt(playheadRef.current).map((candidate) => [candidate.item.id, candidate]),
        ).get(id)
        if (!currentLayout) {
          resetInactiveMedia(audio)
          return
        }
        const target = targetMediaTime(currentLayout.item.trimStart, playheadRef.current, currentLayout.start)
        requestMediaSeek(audio, target, 0.2)
        syncMediaAttributes(audio, {
          muted: Boolean(currentLayout.item.muted),
          volume: currentLayout.item.muted ? 0 : (currentLayout.item.volume ?? 1),
          playbackRate: 1,
        })
        if (isCurrent(id, 'audio')) void audio.play().catch(() => undefined)
        else audio.pause()
      }
      if (audio.readyState >= 1) sync()
      else {
        audio.addEventListener('loadedmetadata', sync, { once: true })
        listeners.push(() => audio.removeEventListener('loadedmetadata', sync))
      }
    })
    activeVideoIdsRef.current = new Set(activeVideoLayouts.keys())
    activeAudioIdsRef.current = new Set(activeAudioLayouts.keys())
    return () => listeners.forEach((remove) => remove())
  }, [activeAudioLayoutKey, activeLayoutKey, audioLayouts, playing, audioTrackIds, playbackIndex])

  const handlePlaybackFrame = useEventCallback((next: number, timestamp: number) => {
      playheadRef.current = next
      playbackClock.setTime(next)
      // Query each active interval once per frame and reuse the result for
      // boundary detection and drift correction. The old implementation
      // repeated both interval searches in the same RAF tick.
      const layouts = playbackIndex.activeVideosAt(next)
      const activeVideoLayouts = new Map(layouts.map((layout) => [layout.item.id, layout]))
      const activeAudios = playbackIndex.activeAudiosAt(next)
      const activeAudioLayouts = new Map(activeAudios.map((layout) => [layout.item.id, layout]))
      const previousVideoIds = activeVideoIdsRef.current
      const previousAudioIds = activeAudioIdsRef.current
      const structureKey = playbackIndex.structureKeyAt(next, layouts)
      if (structureKey !== lastPlaybackStructureKeyRef.current) {
        lastPlaybackStructureKeyRef.current = structureKey
        setStructuralPlayhead(next)
        if (layouts.length > 0 && !cropEditing) {
          setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layouts[0].item.id)
        }
      }
      const audioKey = activeAudios.map((layout) => layout.item.id).join('|')
      if (audioKey !== lastPlaybackAudioKeyRef.current) {
        lastPlaybackAudioKeyRef.current = audioKey
        // Audio-only boundaries must invalidate stale metadata callbacks too.
        setStructuralPlayhead(next)
      }
      const nextVideoIds = new Set(activeVideoLayouts.keys())
      const nextAudioIds = new Set(activeAudioLayouts.keys())
      activeVideoIdsRef.current = nextVideoIds
      activeAudioIdsRef.current = nextAudioIds
      if (timestamp - lastPlaybackSyncRef.current > 450) {
        const candidateVideoIds = new Set([...previousVideoIds, ...nextVideoIds])
        candidateVideoIds.forEach((id) => {
          const video = previewVideoRefs.current.get(id)
          if (!video) return
          const layout = activeVideoLayouts.get(id)
          if (!layout) {
            resetInactiveMedia(video)
            return
          }
          if (video.readyState < 1) return
          const target = targetMediaTime(layout.item.trimStart, next, layout.start)
          const correction = driftCorrection(target, video.currentTime)
          if (correction.seek) {
            requestMediaSeek(video, target, 0.4)
          }
          syncMediaAttributes(video, {
            muted: layout.item.muted,
            volume: layout.item.muted ? 0 : (layout.item.volume ?? 1),
            playbackRate: correction.playbackRate,
          })
          if (video.paused && playingRef.current) void video.play().catch(() => undefined)
        })
        const candidateAudioIds = new Set([...previousAudioIds, ...nextAudioIds])
        candidateAudioIds.forEach((id) => {
          const audio = previewAudioRefs.current.get(id)
          if (!audio) return
          const layout = activeAudioLayouts.get(id)
          if (!layout) {
            resetInactiveMedia(audio)
            return
          }
          if (audio.readyState < 1) return
          const target = targetMediaTime(layout.item.trimStart, next, layout.start)
          const correction = driftCorrection(target, audio.currentTime)
          if (correction.seek) {
            requestMediaSeek(audio, target, 0.4)
          }
          syncMediaAttributes(audio, {
            muted: Boolean(layout.item.muted),
            volume: layout.item.muted ? 0 : (layout.item.volume ?? 1),
            playbackRate: correction.playbackRate,
          })
          if (audio.paused && playingRef.current) void audio.play().catch(() => undefined)
        })
        lastPlaybackSyncRef.current = timestamp
      }
  })

  useEffect(() => {
    if (playing) {
      lastPlaybackStructureKeyRef.current = playbackIndex.structureKeyAt(playheadRef.current)
      return
    }
    previewVideoRefs.current.forEach((video) => pauseMediaAtCurrentPosition(video))
    previewAudioRefs.current.forEach((audio) => pauseMediaAtCurrentPosition(audio))
  }, [playing, playbackIndex])

  useEffect(() => () => {
    previewVideoRefs.current.forEach((video) => video.pause())
    previewAudioRefs.current.forEach((audio) => audio.pause())
  }, [])

  useEffect(() => {
    let blurTimer: number | null = null
    const stopWhenHidden = () => {
      if (!playingRef.current) return
      ++playbackGenerationRef.current
      previewVideoRefs.current.forEach((video) => video.pause())
      previewAudioRefs.current.forEach((audio) => audio.pause())
      setPlaying(false)
    }
    const scheduleStopWhenHidden = () => {
      if (blurTimer !== null) window.clearTimeout(blurTimer)
      // Native fullscreen transitions can emit a transient window blur before
      // fullscreenchange. Wait for that state to settle so playback is not
      // mistaken for an app-background event.
      blurTimer = window.setTimeout(() => {
        blurTimer = null
        if (document.fullscreenElement) return
        stopWhenHidden()
      }, 160)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') scheduleStopWhenHidden()
    }
    const onWindowBlur = () => scheduleStopWhenHidden()
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('pagehide', stopWhenHidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (blurTimer !== null) window.clearTimeout(blurTimer)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('pagehide', stopWhenHidden)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

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
      mergeRuntime.setError(normalizeBackendError(error))
    }
  }

  async function chooseAudio() {
    try {
      const paths = await selectAudioFiles()
      merge.addAudioFiles(paths)
    } catch (error) {
      mergeRuntime.setError(normalizeBackendError(error))
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
      mergeRuntime.setError(imported > 0 ? `已导入 ${imported} 条字幕。` : '未从字幕文件中解析到有效字幕。')
    } catch (error) {
      mergeRuntime.setError(normalizeBackendError(error))
    }
  }

  async function chooseOutputDir() {
    try {
      const path = await selectOutputDirectory()
      if (path) merge.setSettings({ outputDir: path })
    } catch (error) {
      mergeRuntime.setError(normalizeBackendError(error))
    }
  }

  function togglePlayback() {
    if (totalDuration <= 0) return
    if (playing) {
      setPlaying(false)
      return
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
      mergeRuntime.setError('播放头距离片段边缘太近，无法拆分。')
      setClipContextMenu(null)
      return
    }
    setSelectedClipId(nextId)
    mergeRuntime.setError('')
    setClipContextMenu(null)
  }

  function extractClipAudio(layout: ClipLayout) {
    const exists = merge.audioItems.some((item) => item.sourceClipId === layout.item.id)
    if (exists) {
      mergeRuntime.setError('该视频片段的音频已经在音频线中。')
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
    mergeRuntime.setError('')
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
    merge.reorderVideos([target.item.id, layout.item.id], false)
    merge.updateVideo(layout.item.id, { startTime: target.start }, false)
    merge.updateVideo(target.item.id, { startTime: layout.start }, false)
    merge.endHistoryTransaction()
    setSelectedAudioId('')
    setSelectedTextId('')
    setSelectedClipId(layout.item.id)
    setClipContextMenu(null)
  }

  const moveClipWithExchange = useCallback((id: string, resolvedStart: number, trackId: string, recordHistory = true, exchangeStart?: number, exchangeTargetId?: string | null) => {
    const moving = clipLayouts.find((layout) => layout.item.id === id)
    if (!moving) return
    const requestedStart = exchangeStart ?? resolvedStart
    const exchange = timelineExchangeUpdates(
      clipLayouts,
      id,
      trackId,
      requestedStart,
      moving.duration,
      exchangeTargetId,
    )
    if (!exchange) {
      merge.moveVideoTo(id, resolvedStart, trackId, recordHistory)
      return
    }
    // Geometry alone cannot represent every exchange (for example when clips
    // overlap at the same start). Keep the persistent item order in sync as
    // well, so the operation cannot succeed in state but look unchanged.
    const exchangeOrder = timelineExchangeOrder(clipLayouts, id, trackId, exchangeTargetId)
    if (exchangeOrder) merge.reorderVideos(exchangeOrder.map((layout) => layout.item.id), false)
    merge.updateVideos(exchange.map(({ id: updateId, startTime }) => ({
      id: updateId,
      patch: { startTime },
    })), recordHistory)
  }, [clipLayouts, merge])

  const moveAudioWithExchange = useCallback((id: string, resolvedStart: number, trackId: string, recordHistory = true, exchangeStart?: number, exchangeTargetId?: string | null) => {
    const moving = audioLayouts.find((layout) => layout.item.id === id)
    if (!moving) return
    const exchange = timelineExchangeUpdates(
      audioLayouts,
      id,
      trackId,
      exchangeStart ?? resolvedStart,
      moving.duration,
      exchangeTargetId,
    )
    if (!exchange) {
      merge.updateAudio(id, { startTime: Math.max(0, resolvedStart), trackId }, recordHistory)
      return
    }
    const exchangeOrder = timelineExchangeOrder(audioLayouts, id, trackId, exchangeTargetId)
    if (exchangeOrder) merge.reorderAudios(exchangeOrder.map((layout) => layout.item.id), false)
    merge.updateAudios(exchange.map(({ id: updateId, startTime }) => ({
      id: updateId,
      patch: { startTime },
    })), recordHistory)
  }, [audioLayouts, merge])

  const globalTimelineGaps = useMemo(
    () => globalVideoTimelineGaps(clipLayouts),
    [clipLayouts],
  )

  const alignTimeline = useCallback(() => {
    if (mergeRuntime.running || globalTimelineGaps.length === 0) return
    const videoUpdates = timelineGapPositionUpdates(
      globalTimelineGaps,
      clipLayouts.map((layout) => ({ id: layout.item.id, start: layout.start })),
    )
    const audioUpdates = timelineGapPositionUpdates(
      globalTimelineGaps,
      audioLayouts.map((layout) => ({ id: layout.item.id, start: layout.start })),
    )
    const textUpdates = timelineGapPositionUpdates(
      globalTimelineGaps,
      merge.textItems.map((item) => ({ id: item.id, start: item.startTime })),
    )
    merge.beginHistoryTransaction()
    if (videoUpdates.length > 0) {
      merge.updateVideos(videoUpdates.map(({ id, startTime }) => ({ id, patch: { startTime } })), false)
    }
    if (audioUpdates.length > 0) {
      merge.updateAudios(audioUpdates.map(({ id, startTime }) => ({ id, patch: { startTime } })), false)
    }
    if (textUpdates.length > 0) {
      merge.updateTexts(textUpdates.map(({ id, startTime }) => ({ id, patch: { startTime } })), false)
    }
    merge.endHistoryTransaction()

    // The playhead is mapped through the same gaps exactly once, after all
    // tracks have been updated. This avoids a transient active-clip switch.
    const removedBeforePlayhead = globalTimelineGaps
      .filter((gap) => playheadRef.current >= gap.end - 0.0005)
      .reduce((sum, gap) => sum + gap.duration, 0)
    const removedTotal = globalTimelineGaps.reduce((sum, gap) => sum + gap.duration, 0)
    scrubGlobal(
      clamp(playheadRef.current - removedBeforePlayhead, 0, Math.max(0, totalDuration - removedTotal)),
      true,
    )
  }, [audioLayouts, clipLayouts, globalTimelineGaps, merge, mergeRuntime.running, scrubGlobal, totalDuration])

  function removeClip(layout: ClipLayout) {
    // Removing time from the edit is a ripple operation.  Video and audio use
    // the exact same offset, including clips on other tracks, so lip-sync and
    // deliberately aligned overlays remain intact.
    const afterRemovedRange = (start: number) => start >= layout.end - 0.0005
    const laterVideos = clipLayouts.filter((candidate) => candidate.item.id !== layout.item.id && afterRemovedRange(candidate.start))
    const laterAudio = audioLayouts.filter((candidate) => afterRemovedRange(candidate.start))
    const textUpdates: { id: string, patch: Partial<Pick<MergeTextItem, 'startTime' | 'duration'>> }[] = []
    const textRemovals: string[] = []
    for (const item of merge.textItems) {
      const end = item.startTime + item.duration
      if (end <= layout.start + 0.0005) continue
      if (item.startTime >= layout.end - 0.0005) {
        textUpdates.push({ id: item.id, patch: { startTime: Math.max(0, item.startTime - layout.duration) } })
      } else if (item.startTime < layout.start && end > layout.end) {
        textUpdates.push({ id: item.id, patch: { duration: Math.max(0.05, item.duration - layout.duration) } })
      } else if (item.startTime < layout.start) {
        textUpdates.push({ id: item.id, patch: { duration: Math.max(0.05, layout.start - item.startTime) } })
      } else if (end > layout.end) {
        textUpdates.push({ id: item.id, patch: { startTime: layout.start, duration: Math.max(0.05, end - layout.end) } })
      } else {
        textRemovals.push(item.id)
      }
    }
    merge.beginHistoryTransaction()
    merge.removeVideo(layout.item.id)
    merge.updateVideos(laterVideos.map((candidate) => ({ id: candidate.item.id, patch: { startTime: Math.max(0, candidate.start - layout.duration) } })), false)
    merge.updateAudios(laterAudio.map((candidate) => ({ id: candidate.item.id, patch: { startTime: Math.max(0, candidate.start - layout.duration) } })), false)
    merge.updateTexts(textUpdates, false)
    textRemovals.forEach((id) => merge.removeText(id))
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
    playing, videoTrackCount: merge.videoTracks.length, audioTrackCount: merge.audioTracks.length, clipLayouts, audioLayouts, audioDurations, metadata,
    draft: timelineDragPreview,
    commands: { beginHistoryTransaction: merge.beginHistoryTransaction, endHistoryTransaction: merge.endHistoryTransaction, moveVideoTo: moveClipWithExchange, moveAudioTo: moveAudioWithExchange, updateVideo: merge.updateVideo, updateAudio: merge.updateAudio, updateText: merge.updateText },
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

  function openTextContextMenu(event: React.MouseEvent, item: MergeTextItem) {
    if (cropEditing) {
      rejectCropEditSwitch(event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId('')
    setSelectedAudioId('')
    setSelectedTextId(item.id)
    setClipContextMenu(null)
    setAudioContextMenu(null)
    setTextContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)),
      text: item,
    })
  }

  function handlePreviewTextPointerDown(event: React.PointerEvent<HTMLDivElement>, item: MergeTextItem) {
    if (cropEditing) {
      rejectCropEditSwitch(event)
      return
    }
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

  function handlePreviewTextResizePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    item: MergeTextItem,
    handle: CropHandle,
  ) {
    if (cropEditing) {
      rejectCropEditSwitch(event)
      return
    }
    if (event.button !== 0 || !outputCanvasRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const canvasRect = outputCanvasRef.current.getBoundingClientRect()
    const textElement = event.currentTarget.parentElement
    const textRect = textElement?.getBoundingClientRect()
    if (!textRect || textRect.width <= 0 || textRect.height <= 0) return

    const directionX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
    const directionY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
    const initialWidth = textRect.width / Math.max(1, canvasRect.width)
    const initialHeight = textRect.height / Math.max(1, canvasRect.height)
    const baseExtent = directionX !== 0 && directionY !== 0
      ? Math.max(textRect.width, textRect.height)
      : directionX !== 0 ? textRect.width : textRect.height
    const initialPoint = { x: event.clientX, y: event.clientY }
    const resize = (clientX: number, clientY: number) => {
      const signedX = directionX * (clientX - initialPoint.x)
      const signedY = directionY * (clientY - initialPoint.y)
      const growth = directionX !== 0 && directionY !== 0
        ? (signedX + signedY) / 2
        : signedX || signedY
      const scale = clamp(1 + growth / Math.max(8, baseExtent), 0.25, 5)
      const nextWidth = initialWidth * scale
      const nextHeight = initialHeight * scale
      const nextX = clamp(
        item.x + (directionX === 1 ? (nextWidth - initialWidth) / 2 : directionX === -1 ? -(nextWidth - initialWidth) / 2 : 0),
        0,
        1,
      )
      const nextY = clamp(
        item.y + (directionY === 1 ? (nextHeight - initialHeight) / 2 : directionY === -1 ? -(nextHeight - initialHeight) / 2 : 0),
        0,
        1,
      )
      return {
        x: nextX,
        y: nextY,
        fontSize: clamp(Math.round(item.fontSize * scale), 8, 240),
      }
    }

    merge.beginHistoryTransaction()
    withPointerLifecycle(
      event,
      (pointerEvent) => previewEditDraft.set({ text: { [item.id]: resize(pointerEvent.clientX, pointerEvent.clientY) } }),
      (pointerEvent) => {
        merge.updateText(item.id, resize(pointerEvent.clientX, pointerEvent.clientY), false)
        merge.endHistoryTransaction()
      },
      () => previewEditDraft.set(null),
    )
  }

  function applyActiveVideoLayout(mode: 'grid' | 'horizontal' | 'vertical' | 'auto') {
    if (activeLayouts.length < 2) {
      mergeRuntime.setError('当前播放位置至少需要两个重叠视频才能设置画面布局。')
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
    mergeRuntime.setError('')
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

  function openCropEditor() {
    if (!previewClip || !cropGeometry) {
      mergeRuntime.setError('请先选择一个可预览的视频片段。')
      return
    }
    if (cropEditing) return
    const current = previewClip.cropEnabled
      ? cropRectFromClip(previewClip, cropGeometry)
      : { x: 0, y: 0, width: cropGeometry.sourceWidth, height: cropGeometry.sourceHeight }
    cropSessionRef.current = {
      clipId: previewClip.id,
      cropEnabled: previewClip.cropEnabled,
      cropX: previewClip.cropX,
      cropY: previewClip.cropY,
      cropWidth: previewClip.cropWidth,
      cropHeight: previewClip.cropHeight,
    }
    merge.beginHistoryTransaction()
    // Keep the editor draft out of the undo stack until the user confirms.
    previewEditDraft.set({ crop: { id: previewClip.id, rect: current } })
    setCropEditing(true)
  }

  function resetCropSelection() {
    if (!cropGeometry || !previewClip) return
    const reset = {
      cropEnabled: true,
      cropX: 0,
      cropY: 0,
      cropWidth: cropGeometry.sourceWidth,
      cropHeight: cropGeometry.sourceHeight,
    }
    merge.updateVideo(previewClip.id, reset, false)
    previewEditDraft.set({ crop: { id: previewClip.id, rect: {
      x: reset.cropX,
      y: reset.cropY,
      width: reset.cropWidth,
      height: reset.cropHeight,
    } } })
  }

  function confirmCropEditing() {
    if (!cropEditing) return
    previewEditDraft.set(null)
    merge.endHistoryTransaction()
    cropSessionRef.current = null
    setCropEditing(false)
  }

  const cancelCropEditing = useCallback(() => {
    const session = cropSessionRef.current
    if (!cropEditing || !session) {
      setCropEditing(false)
      return
    }
    merge.updateVideo(session.clipId, {
      cropEnabled: session.cropEnabled,
      cropX: session.cropX,
      cropY: session.cropY,
      cropWidth: session.cropWidth,
      cropHeight: session.cropHeight,
    }, false)
    previewEditDraft.set(null)
    // The transaction snapshot is restored before closing, so cancelling does
    // not create an undo entry and does not leave a draft mutation behind.
    merge.endHistoryTransaction()
    cropSessionRef.current = null
    setCropEditing(false)
  }, [cropEditing, merge, previewEditDraft])

  useEffect(() => {
    if (!cropEditing) return undefined
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelCropEditing()
    }
    window.addEventListener('keydown', cancelOnEscape)
    return () => window.removeEventListener('keydown', cancelOnEscape)
  }, [cancelCropEditing, cropEditing])

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
    }, () => previewEditDraft.set(null))

    if (handle === 'draw') {
      previewEditDraft.set({ crop: { id: clipId, rect: { x: startPoint.x, y: startPoint.y, width: 2, height: 2 } } })
    }
  }

  const buildMergeConfig = useCallback((
    previewStart?: number,
    previewDuration?: number,
    exportName?: string,
    exportFormat: MergeOutputFormat = 'mp4',
  ) => ({
    inputs: merge.items.map((item) => ({
      id: item.id,
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
      volume: layout.item.volume,
      muted: layout.item.muted,
      sourceType: layout.item.sourceType,
      sourceClipId: layout.item.sourceClipId,
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
    outputName: outputNameStem(exportName ?? merge.settings.outputName),
    outputFormat: exportFormat,
    ...(previewStart !== undefined && previewDuration !== undefined ? { previewStart, previewDuration } : {}),
    projectRoot,
    pythonPath,
  }), [audioLayouts, clipLayouts, merge.items, merge.settings, merge.textItems, merge.videoTracks, projectRoot, pythonPath])

  const calculateResolutionPreview = useCallback(async () => {
    if (resolutionPreviewCalculating) return
    let start = playheadRef.current
    let duration = resolutionPreviewDuration
    if (resolutionPreviewRangeMode === 'clips') {
      const selected = resolutionPreviewClips.filter((clip) => resolutionPreviewClipIds.includes(clip.id))
      if (selected.length === 0) {
        mergeRuntime.setError('请至少选择一个视频片段。')
        return
      }
      start = Math.min(...selected.map((clip) => clip.start))
      const end = Math.max(...selected.map((clip) => clip.start + clip.duration))
      duration = Math.max(0.05, end - start)
    }
    if (start >= totalDuration - 0.001) {
      mergeRuntime.setError('当前播放头已在时间线末尾，没有可计算的内容。')
      return
    }
    duration = Math.min(Math.max(0.05, duration), totalDuration - start)
    // Release browser decoders before the temporary FFmpeg render. The
    // playhead remains in `playheadRef`, so mounted previews can restore it
    // when the computed preview is closed.
    releaseAllPreviewMedia()
    setResolutionPreviewCalculating(true)
    setResolutionPreviewMode('live')
    setResolutionPreview(null)
    setPlaying(false)
    mergeRuntime.setError('')
    try {
      const previewConfig = buildMergeConfig(start, duration)
      const rangeEnd = start + duration
      // Restrict the preview job to media that intersects the requested range.
      // This avoids decoding the entire project when the user previews a late
      // clip in a long timeline, while preserving the original source trim.
      const clippedInputs = previewConfig.inputs.flatMap((input) => {
        const layout = clipLayouts.find((candidate) => candidate.item.id === input.id)
        if (!layout) return []
        const overlapStart = Math.max(start, layout.start)
        const overlapEnd = Math.min(rangeEnd, layout.end)
        if (overlapEnd <= overlapStart + 0.001) return []
        const sourceOffset = overlapStart - layout.start
        const sourceStart = (input.trimStart ?? 0) + sourceOffset
        return [{
          ...input,
          startTime: overlapStart - start,
          trimStart: sourceStart,
          trimEnd: sourceStart + (overlapEnd - overlapStart),
        }]
      })
      if (clippedInputs.length > 0) previewConfig.inputs = clippedInputs
      previewConfig.audioTracks = previewConfig.audioTracks.flatMap((track, index) => {
        const layout = audioLayouts[index]
        if (!layout) return []
        const overlapStart = Math.max(start, layout.start)
        const overlapEnd = Math.min(rangeEnd, layout.end)
        if (overlapEnd <= overlapStart + 0.001) return []
        const sourceOffset = overlapStart - layout.start
        const sourceStart = (track.trimStart ?? 0) + sourceOffset
        return [{
          ...track,
          startTime: overlapStart - start,
          trimStart: sourceStart,
          trimEnd: sourceStart + (overlapEnd - overlapStart),
        }]
      })
      previewConfig.textTracks = previewConfig.textTracks.flatMap((text, index) => {
        const item = merge.textItems[index]
        if (!item) return []
        const textStart = Math.max(0, item.startTime)
        const textEnd = textStart + Math.max(0.05, item.duration)
        const overlapStart = Math.max(start, textStart)
        const overlapEnd = Math.min(rangeEnd, textEnd)
        if (overlapEnd <= overlapStart + 0.001) return []
        return [{ ...text, startTime: overlapStart - start, duration: overlapEnd - overlapStart }]
      })
      previewConfig.previewStart = 0
      previewConfig.previewDuration = duration
      // Preview sharpness is determined by the target dimensions. A fast H.264
      // encode keeps the UI responsive even when the export preset is H.265 or
      // two-pass; the final export settings remain untouched.
      previewConfig.videoEncoder = 'h264'
      previewConfig.encoderPreset = 'ultrafast'
      previewConfig.rateControl = 'quality'
      previewConfig.crf = 18
      previewConfig.twoPass = false
      const path = await renderVideoMergePreview(previewConfig)
      setResolutionPreview({ path, start, duration, signature: resolutionPreviewSignature })
      setResolutionPreviewMode('computed')
      setResolutionPreviewDialogOpen(false)
    } catch (error) {
      mergeRuntime.setError(normalizeBackendError(error))
    } finally {
      setResolutionPreviewCalculating(false)
    }
  }, [audioLayouts, buildMergeConfig, clipLayouts, merge, mergeRuntime, releaseAllPreviewMedia, resolutionPreviewCalculating, resolutionPreviewClipIds, resolutionPreviewClips, resolutionPreviewDuration, resolutionPreviewRangeMode, resolutionPreviewSignature, totalDuration])

  function openExportDirectoryDialog() {
    if (merge.items.length === 0) {
      mergeRuntime.setError('请先向视频线加入至少一个视频。')
      return
    }
    const suggestedSourceDirectory = sourceDirectories[0] ?? ''
    setExportDirectoryMode(suggestedSourceDirectory ? 'source' : 'browse')
    setExportSourceDirectory(suggestedSourceDirectory)
    setExportDirectoryDraft(suggestedSourceDirectory || merge.settings.outputDir)
    setExportNameDraft(outputNameStem(merge.settings.outputName) || 'merged_video')
    setExportFormatDraft('mp4')
    setExportValidation(null)
    setValidatedExportKey('')
    setExportDirectoryDialogOpen(true)
  }

  async function browseExportDirectory() {
    // Selecting the browse source is independent from whether the native
    // picker returns a path (the user may cancel it and continue editing the
    // path field manually).
    setExportDirectoryMode('browse')
    try {
      const path = await selectOutputDirectory()
      if (path) {
        setExportDirectoryDraft(path)
      }
    } catch (error) {
      mergeRuntime.setError(normalizeBackendError(error))
    }
  }

  function selectSourceExportDirectory(directory = selectedSourceDirectory) {
    if (!directory) return
    setExportDirectoryMode('source')
    setExportSourceDirectory(directory)
    setExportDirectoryDraft(directory)
  }

  async function startMerge(
    outputDirectory?: string,
    outputName?: string,
    outputFormat: MergeOutputFormat = 'mp4',
  ) {
    if (merge.items.length === 0) {
      mergeRuntime.setError('请先向视频线加入至少一个视频。')
      return
    }
    mergeRuntime.clearLogs()
    mergeRuntime.setError('')
    // An export can be CPU/IO intensive. Invalidate pending media callbacks and
    // stop every decoder before handing control to the backend; the playback
    // RAF then tears down from `playing=false` without competing for frames.
    releaseAllPreviewMedia()
    playingRef.current = false
    setPlaying(false)
    setResolutionPreviewMode('live')
    timelineDragPreview.set(null)
    previewEditDraft.set(null)
    mergeRuntime.setRunning(true)
    mergeRuntime.setProgress(0, '正在提交导出任务')
    try {
      const config = buildMergeConfig(undefined, undefined, outputName, outputFormat)
      if (outputDirectory !== undefined) config.outputDir = outputDirectory
      await runVideoMerge(config)
    } catch (error) {
      mergeRuntime.setRunning(false)
      mergeRuntime.setError(normalizeBackendError(error))
    }
  }

  function confirmExportDirectory() {
    // Resolve the mode at confirmation time so a select/button change cannot
    // leave the backend with the previous draft path.
    const outputDirectory = resolveExportDirectory(exportDirectoryMode, selectedSourceDirectory, exportDirectoryDraft)
    const outputName = outputNameStem(exportNameDraft)
    const localError = basicOutputNameError(outputName)
    if (!outputDirectory) {
      mergeRuntime.setError('请输入或选择导出文件夹。')
      return
    }
    if (localError) {
      mergeRuntime.setError(localError)
      return
    }
    if (!canConfirmExport(outputDirectory, outputName, exportValidating, currentExportValidation)) return
    merge.setSettings({ outputDir: outputDirectory })
    merge.setSettings({ outputName })
    setExportDirectoryDialogOpen(false)
    void startMerge(outputDirectory, outputName, exportFormatDraft)
  }

  // Timeline rows are memoized. Keep their high-frequency pointer handlers
  // referentially stable while each invocation still observes current project state.
  // A crop session owns one clip and one history transaction; allowing a second
  // clip to be selected mid-session would bind the transaction to the wrong item.
  const rejectCropEditSwitch = useEventCallback((event: React.SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
    mergeRuntime.setError('请先确认或取消当前视频尺寸调整，再切换其他片段。')
  })
  const onTracksPointerDown = useEventCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleTimelinePointerDown(event)
  })
  const onPlayheadPointerDown = useEventCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handlePlayheadPointerDown(event)
  })
  const onVideoPointerDown = useEventCallback((event: React.PointerEvent, layout: ClipLayout) => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleVideoPointerDown(event, layout)
  })
  const onVideoTrimPointerDown = useEventCallback((event: React.PointerEvent, layout: ClipLayout, edge: 'start' | 'end') => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleVideoTrimPointerDown(event, layout, edge)
  })
  const onAudioPointerDown = useEventCallback((event: React.PointerEvent, layout: Parameters<typeof timelineInteractions.handleAudioPointerDown>[1]) => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleAudioPointerDown(event, layout)
  })
  const onAudioTrimPointerDown = useEventCallback((event: React.PointerEvent, layout: Parameters<typeof timelineInteractions.handleAudioTrimPointerDown>[1], edge: 'start' | 'end') => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleAudioTrimPointerDown(event, layout, edge)
  })
  const onTextPointerDown = useEventCallback((event: React.PointerEvent, item: MergeTextItem) => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleTextPointerDown(event, item)
  })
  const onTextTrimPointerDown = useEventCallback((event: React.PointerEvent, item: MergeTextItem, edge: 'start' | 'end') => {
    if (cropEditing) return rejectCropEditSwitch(event)
    timelineInteractions.handleTextTrimPointerDown(event, item, edge)
  })

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
          {mergeRuntime.running ? (
            <NeonButton tone="red" type="button" onClick={() => void cancelVideoMerge()}><Pause />取消导出</NeonButton>
          ) : (
            <NeonButton type="button" disabled={merge.items.length === 0 || resolutionPreviewCalculating} onClick={openExportDirectoryDialog}><Download />导出视频</NeonButton>
          )}
        </div>
      </GlassPanel>

      <div className={`editor-main-grid ${inspectorOpen ? 'has-inspector' : ''}`}>
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
            clock={playbackClock}
            totalDuration={totalDuration}
            suspendMedia={mergeRuntime.running || resolutionPreviewCalculating}
            previewStart={previewLayout?.start ?? null}
            resolutionPreview={mergeRuntime.running ? null : validResolutionPreview}
            resolutionPreviewMode={effectiveResolutionPreviewMode}
            resolutionPreviewCalculating={resolutionPreviewCalculating}
            onOpenResolutionPreview={!mergeRuntime.running ? () => {
              setResolutionPreviewClipIds((current) => {
                const valid = current.filter((id) => resolutionPreviewClips.some((clip) => clip.id === id))
                return valid.length > 0 ? valid : resolutionPreviewClips.slice(0, 1).map((clip) => clip.id)
              })
              setResolutionPreviewDialogOpen(true)
            } : undefined}
            onResolutionPreviewModeChange={(mode) => {
              setResolutionPreviewMode(mode)
              setPlaying(false)
            }}
            onPreviewLayoutPointerDown={handlePreviewLayoutPointerDown}
            onPreviewTextPointerDown={handlePreviewTextPointerDown}
            onPreviewTextResizePointerDown={handlePreviewTextResizePointerDown}
            onPreviewTextContextMenu={openTextContextMenu}
            onGroupLayoutPointerDown={handleGroupLayoutPointerDown}
            onCropPointerDown={handleCropPointerDown}
            onResetCropSelection={resetCropSelection}
            onCancelCropEditing={cancelCropEditing}
            onPreviewMetadataLoaded={updatePreviewGeometry}
            onPreviewVideoReady={handlePreviewVideoReady}
            onSeek={seekGlobal}
            onTogglePlayback={togglePlayback}
            onNudge={nudgePlayhead}
            onFullscreenError={(message) => mergeRuntime.setError(message)}
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
                onClick={() => cropEditing ? confirmCropEditing() : openCropEditor()}
              >
                {cropEditing ? <CheckCircle2 /> : <SquareDashedMousePointer />}
	                {cropEditing ? '调整完成' : previewClip?.cropEnabled ? '编辑红框' : '开始调整'}
              </button>
              {cropEditing ? (
                <button type="button" className="subtle" onClick={cancelCropEditing}>取消调整</button>
              ) : previewClip?.cropEnabled && (
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

      <GlassPanel className={`editor-timeline-panel ${timelineCollapsed ? 'is-collapsed' : ''}`} style={timelinePanelStyle}>
        <button
          type="button"
          className="editor-timeline-collapse-toggle"
          aria-expanded={!timelineCollapsed}
          aria-controls="merge-timeline-workspace"
          onClick={() => setTimelineCollapsed((collapsed) => !collapsed)}
          title={timelineCollapsed ? '展开时间线' : '折叠时间线'}
        >
          <ChevronDown aria-hidden="true" />
          <span>{timelineCollapsed ? '展开时间线' : '折叠时间线'}</span>
        </button>
        <div
          id="merge-timeline-workspace"
          className="editor-timeline-content"
          aria-disabled={cropEditing}
          title={cropEditing ? '当前正在调整视频尺寸，请先确认或取消后再操作时间线。' : undefined}
        >
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
          canAlignTimeline={!mergeRuntime.running && globalTimelineGaps.length > 0}
          alignTimelineDisabledReason={`一键删除所有视频线共同的空白，并同步前移视频、音频与文本片段。${mergeRuntime.running ? '合并进行中，暂不可使用。' : globalTimelineGaps.length > 0 ? '当前可以执行。' : '当前没有需要对齐的共同空白。'}`}
          onAlignTimeline={alignTimeline}
          onTracksPointerDown={onTracksPointerDown}
          onPlayheadPointerDown={onPlayheadPointerDown}
          onTrackContextMenu={(event, kind, trackId) => {
            if (cropEditing) {
              rejectCropEditSwitch(event)
              return
            }
            event.preventDefault()
            setTrackContextMenu({ x: event.clientX, y: event.clientY, kind, trackId })
          }}
          onTextTrackContextMenu={(event, trackId) => {
            if (cropEditing) {
              rejectCropEditSwitch(event)
              return
            }
            event.preventDefault()
            const rect = timelineRef.current?.getBoundingClientRect()
            setTrackContextMenu({ x: event.clientX, y: event.clientY, kind: 'text', trackId, time: rect ? timelineTimeFromClientX(event.clientX, rect, totalDuration, timelinePixelsPerSecondFit) : playheadRef.current })
          }}
          onVideoPointerDown={onVideoPointerDown}
          onVideoContextMenu={(event, layout) => {
            if (cropEditing) {
              rejectCropEditSwitch(event)
              return
            }
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
          onAudioTrimPointerDown={onAudioTrimPointerDown}
          onAudioContextMenu={(event, layout) => {
            if (cropEditing) {
              rejectCropEditSwitch(event)
              return
            }
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
          onTextTrimPointerDown={onTextTrimPointerDown}
          onTextContextMenu={openTextContextMenu}
          />
        </div>
        {!mergeRuntime.running && !resolutionPreviewCalculating && merge.audioItems.map((audio) => (
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
            preload="metadata"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration
              if (Number.isFinite(duration)) setAudioDurations((current) => ({ ...current, [audio.id]: duration }))
            }}
          />
        ))}
      </GlassPanel>

      {dropActive && <div className="editor-drop-overlay"><Upload /><strong>松开以加入视频线或音频线</strong></div>}
      {exportDirectoryDialogOpen && (
        <div
          className="merge-export-directory-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExportDirectoryDialogOpen(false)
          }}
        >
          <section className="merge-export-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-export-directory-title">
            <header>
              <div>
                <span className="eyebrow">{t('导出位置')}</span>
                <h2 id="merge-export-directory-title">{t('选择导出文件夹')}</h2>
              </div>
              <button type="button" className="icon-button" aria-label={t('关闭导出文件夹选择')} onClick={() => setExportDirectoryDialogOpen(false)}>×</button>
            </header>
            <p>{t('默认建议使用第一个源视频所在文件夹。确认后才会开始合并。')}</p>
            <div className="merge-export-directory-options" role="radiogroup" aria-label={t('导出位置来源')}>
              <button
                type="button"
                className={`merge-export-directory-option ${exportDirectoryMode === 'source' && selectedSourceDirectory ? 'is-selected' : ''}`}
                disabled={sourceDirectories.length === 0}
                role="radio"
                aria-checked={exportDirectoryMode === 'source' && Boolean(selectedSourceDirectory)}
                onClick={() => selectSourceExportDirectory()}
              >
                <FolderOpen />
                <span><strong>{t('使用源文件夹')}</strong><small>{selectedSourceDirectory || t('当前源视频没有可识别的文件夹')}</small></span>
              </button>
              <button
                type="button"
                className={`merge-export-directory-option ${exportDirectoryMode === 'browse' ? 'is-selected' : ''}`}
                role="radio"
                aria-checked={exportDirectoryMode === 'browse'}
                onClick={() => void browseExportDirectory()}
              >
                <FolderOpen />
                <span><strong>{t('浏览选择文件夹')}</strong><small>{t('打开系统目录选择器')}</small></span>
              </button>
            </div>
            <label className="merge-export-directory-field">
              <span>{t('导出文件夹路径')}</span>
              {exportDirectoryMode === 'source' && sourceDirectories.length > 0 ? (
                <SelectInput
                  autoFocus
                  value={selectedSourceDirectory}
                  onChange={(event) => selectSourceExportDirectory(event.target.value)}
                  aria-label={t('导出文件夹路径')}
                >
                  {sourceDirectories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}
                </SelectInput>
              ) : (
                <div className="merge-path-input merge-export-directory-path-input">
                  <TextInput
                    autoFocus
                    value={exportDirectoryDraft}
                    onChange={(event) => setExportDirectoryDraft(event.target.value)}
                    placeholder={t('可直接输入完整路径')}
                    aria-label={t('导出文件夹路径')}
                  />
                  <button type="button" title={t('选择导出文件夹')} onClick={() => void browseExportDirectory()}><FolderOpen /></button>
                </div>
              )}
            </label>
            <label className="merge-export-directory-field">
              <span>{t('视频导出名称')}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TextInput
                  value={exportNameDraft}
                  onChange={(event) => setExportNameDraft(outputNameStem(event.target.value))}
                  placeholder={t('例如 merged_video')}
                  aria-label={t('视频导出名称')}
                  aria-invalid={Boolean(basicOutputNameError(exportNameDraft))}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <strong style={{ color: 'rgba(205, 222, 246, 0.78)', fontSize: 13 }}>.{exportFormatDraft}</strong>
              </div>
            </label>
            <label className="merge-export-directory-field">
              <span>{t('导出格式')}</span>
              <SelectInput
                value={exportFormatDraft}
                onChange={(event) => setExportFormatDraft(event.target.value as MergeOutputFormat)}
                aria-label={t('导出格式')}
              >
                {mergeOutputFormats.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
              </SelectInput>
            </label>
            <p className="merge-message" role="status" aria-live="polite">
              {exportValidationMessage ? tm(exportValidationMessage) : null}
            </p>
            <footer>
              <button type="button" className="icon-button" onClick={() => setExportDirectoryDialogOpen(false)}>{t('取消')}</button>
              <NeonButton
                type="button"
                disabled={!canConfirmExport(resolvedExportDirectory, exportNameDraft, exportValidating, currentExportValidation)}
                onClick={confirmExportDirectory}
              ><Download />{t('开始导出')}</NeonButton>
            </footer>
          </section>
        </div>
      )}
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
        onTrackRemove={(track) => { const removed = track.kind === 'video' ? merge.removeVideoTrack(track.trackId) : track.kind === 'audio' ? merge.removeAudioTrack(track.trackId) : merge.removeTextTrack(track.trackId); if (!removed) mergeRuntime.setError(`${trackKindLabel(track.kind)}至少保留一条。`); setTrackContextMenu(null) }}
        onClipSeek={(clip) => { seekGlobal(clip.time); setClipContextMenu(null) }} onClipPlay={(clip) => { seekGlobal(clip.layout.start, true); setClipContextMenu(null) }} onClipSplit={(clip) => splitClipAt(clip.layout, clip.time)} onClipExtractAudio={(clip) => extractClipAudio(clip.layout)}
        onClipToggleMute={(clip) => { merge.updateVideo(clip.layout.item.id, { muted: !clip.layout.item.muted }); setClipContextMenu(null) }} onClipRotate={(clip) => { rotateClipRight(clip.layout.item); setClipContextMenu(null) }} onClipRestoreRotation={(clip) => { restoreClipRotation(clip.layout.item); setClipContextMenu(null) }}
          onClipCrop={(clip) => { setSelectedAudioId(''); setSelectedClipId(clip.layout.item.id); seekGlobal(clip.layout.start); setClipContextMenu(null); window.requestAnimationFrame(() => openCropEditor()) }}
        onClipDuplicate={(clip) => duplicateClip(clip.layout)} onClipMove={(clip, direction) => moveClip(clip.layout, direction)} canClipMove={(clip, direction) => Boolean(previousTrackLayout(clipLayouts, clip.layout, direction))} onClipRestore={(clip) => { merge.updateVideo(clip.layout.item.id, { trimStart: 0, trimEnd: 0 }); setClipContextMenu(null) }} onClipReveal={(clip) => { setClipContextMenu(null); void revealInFolder(clip.layout.item.path).catch((error) => mergeRuntime.setError(normalizeBackendError(error))) }} onClipRemove={(clip) => removeClip(clip.layout)}
        onAudioSeek={(audio) => { seekGlobal(audio.layout.start); setAudioContextMenu(null) }} onAudioMoveToPlayhead={(audio) => { merge.updateAudio(audio.layout.item.id, { startTime: playheadRef.current }); setAudioContextMenu(null) }} onAudioMoveToStart={(audio) => { merge.updateAudio(audio.layout.item.id, { startTime: 0 }); setAudioContextMenu(null) }} onAudioEditProperties={(audio) => { setSelectedClipId(''); setSelectedTextId(''); setSelectedAudioId(audio.layout.item.id); setAudioContextMenu(null); setInspectorOpen(true) }} onAudioReveal={(audio) => { setAudioContextMenu(null); void revealInFolder(audio.layout.item.path).catch((error) => mergeRuntime.setError(normalizeBackendError(error))) }} onAudioRemove={(audio) => { merge.removeAudio(audio.layout.item.id); setSelectedAudioId(''); setAudioContextMenu(null) }}
        onTextSeek={(text) => { seekGlobal(text.text.startTime); setTextContextMenu(null) }} onTextMoveToPlayhead={(text) => { merge.updateText(text.text.id, { startTime: playheadRef.current }); setTextContextMenu(null) }} onTextEditProperties={(text) => { setTextContextMenu(null); setTextPropertiesId(text.text.id) }} onTextRemove={(text) => { merge.removeText(text.text.id); setSelectedTextId(''); setTextContextMenu(null) }}
      />
      <MergeResolutionSimulationDialog
        open={resolutionPreviewDialogOpen}
        clips={resolutionPreviewClips}
        mode={resolutionPreviewRangeMode}
        selectedClipIds={resolutionPreviewClipIds}
        duration={resolutionPreviewDuration}
        calculating={resolutionPreviewCalculating}
        onModeChange={setResolutionPreviewRangeMode}
        onSelectedClipIdsChange={setResolutionPreviewClipIds}
        onDurationChange={setResolutionPreviewDuration}
        onStart={() => void calculateResolutionPreview()}
        onClose={() => setResolutionPreviewDialogOpen(false)}
      />
      <MergeTextPropertiesDialog
        key={textPropertiesId || 'closed'}
        item={textPropertiesItem}
        onSave={(patch) => { if (textPropertiesItem) merge.updateText(textPropertiesItem.id, patch) }}
        onClose={() => setTextPropertiesId('')}
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

// eslint-disable-next-line react-refresh/only-export-components -- pure export-form helper is covered by MergePage tests.
export function resolveExportDirectory(mode: ExportDirectoryMode, sourceDirectory: string, browseDirectory: string) {
  return (mode === 'source' ? sourceDirectory : browseDirectory).trim()
}

// eslint-disable-next-line react-refresh/only-export-components -- pure path helpers are covered by MergePage tests.
export function directoryFromPath(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const separator = trimmed.includes('\\') ? '\\' : '/'
  const uncRoot = trimmed.match(/^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/)
  if (uncRoot) return `${separator}${separator}${uncRoot[1]}${separator}${uncRoot[2]}`
  const separatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (separatorIndex < 0) return ''
  // Keep the root separator for paths such as `C:\\video.mp4`, `/video.mp4`,
  // and UNC paths while avoiding a trailing separator for ordinary folders.
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3)
  if (separatorIndex === 0) return trimmed.slice(0, 1)
  return trimmed.slice(0, separatorIndex)
}

// eslint-disable-next-line react-refresh/only-export-components -- pure path helpers are covered by MergePage tests.
export function sourceDirectoriesFromPaths(paths: string[]) {
  const directories: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const directory = directoryFromPath(path)
    if (!directory) continue
    const normalized = normalizePath(directory)
    const key = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    if (seen.has(key)) continue
    seen.add(key)
    directories.push(directory)
  }
  return directories
}
