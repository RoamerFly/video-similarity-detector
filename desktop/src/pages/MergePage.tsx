import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Film,
  FolderOpen,
  Gauge,
  GripVertical,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Settings2,
  SquareDashedMousePointer,
  SkipBack,
  Trash2,
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
import { Translated } from '@/i18n/useI18n'
import {
  cancelVideoMerge,
  fileName,
  hasTauriRuntime,
  localFileSrc,
  normalizeBackendError,
  probeVideoMetadata,
  revealInFolder,
  runVideoMerge,
  selectAudioFiles,
  selectOutputDirectory,
  selectVideoFiles,
  type VideoMetadata,
} from '@/services/backend'
import {
  useMergeStore,
  type MergeAudioItem,
  type MergeFitMode,
  type MergeQueueItem,
  type MergeRotation,
  type MergeSplitMode,
} from '@/stores/mergeStore'
import { useSettingsStore } from '@/stores/settingsStore'

const metadataCache = new Map<string, VideoMetadata>()
const audioExtensions = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'])
const videoExtensions = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'])
const timelinePixelsPerSecond = 12
const timelineMinimumWidth = 720
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

interface ClipLayout {
  item: MergeQueueItem
  trackId: string
  start: number
  duration: number
  end: number
}

interface ClipContextMenuState {
  x: number
  y: number
  layout: ClipLayout
  time: number
}

interface AudioContextMenuState {
  x: number
  y: number
  audio: MergeAudioItem
}

interface TrackContextMenuState {
  x: number
  y: number
  kind: 'video' | 'audio'
  trackId: string
}

interface CropGeometry {
  left: number
  top: number
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}

interface PreviewCanvasGeometry {
  left: number
  top: number
  width: number
  height: number
}

interface NormalizedLayoutRect {
  x: number
  y: number
  width: number
  height: number
}

interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

type CropHandle = 'draw' | 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export function MergePage() {
  const merge = useMergeStore()
  const projectRoot = useSettingsStore((state) => state.projectRoot)
  const pythonPath = useSettingsStore((state) => state.pythonPath)
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const previewVideoRefs = useRef(new Map<string, HTMLVideoElement>())
  const previewScreenRef = useRef<HTMLDivElement | null>(null)
  const outputCanvasRef = useRef<HTMLDivElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const timelineSeekFrameRef = useRef<number | null>(null)
  const playheadDragFrameRef = useRef<number | null>(null)
  const playbackFrameRef = useRef<number | null>(null)
  const lastScrubMediaUpdateRef = useRef(0)
  const lastPlaybackSyncRef = useRef(0)
  const lastPlaybackUiUpdateRef = useRef(0)
  const playheadRef = useRef(0)
  const playbackAnchorRef = useRef({ time: 0, timestamp: 0 })
  const [metadata, setMetadata] = useState<Record<string, VideoMetadata>>(() => Object.fromEntries(metadataCache))
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({})
  const [selectedClipId, setSelectedClipId] = useState('')
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const [draggedClipId, setDraggedClipId] = useState('')
  const [draggedAudioId, setDraggedAudioId] = useState('')
  const [playheadDragging, setPlayheadDragging] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuState | null>(null)
  const [audioContextMenu, setAudioContextMenu] = useState<AudioContextMenuState | null>(null)
  const [trackContextMenu, setTrackContextMenu] = useState<TrackContextMenuState | null>(null)
  const [cropEditing, setCropEditing] = useState(false)
  const [groupEditingKey, setGroupEditingKey] = useState('')
  const [previewSize, setPreviewSize] = useState({ width: 720, height: 420 })
  const [cropGeometry, setCropGeometry] = useState<CropGeometry | null>(null)
  const [outputCanvasGeometry, setOutputCanvasGeometry] = useState<PreviewCanvasGeometry | null>(null)
  const setMergeError = merge.setError
  const videoPathKey = useMemo(
    () => Array.from(new Set(merge.items.map((item) => normalizePath(item.path)))).sort().join('|'),
    [merge.items],
  )

  useEffect(() => {
    playheadRef.current = playhead
  }, [playhead])

  useEffect(() => {
    if (!clipContextMenu && !audioContextMenu && !trackContextMenu) return undefined
    const close = () => {
      setClipContextMenu(null)
      setAudioContextMenu(null)
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
  }, [audioContextMenu, clipContextMenu, trackContextMenu])

  useEffect(() => {
    const paths = Array.from(new Set(merge.items.map((item) => item.path)))
    const missing = paths.filter((path) => !metadataCache.has(normalizePath(path)))
    if (missing.length === 0) return undefined
    let alive = true
    probeVideoMetadata(missing, projectRoot, pythonPath)
      .then((rows) => {
        rows.forEach((row) => metadataCache.set(normalizePath(row.path), row))
        if (alive) setMetadata(Object.fromEntries(metadataCache))
      })
      .catch((error) => {
        if (alive) setMergeError(normalizeBackendError(error))
      })
    return () => {
      alive = false
    }
  }, [merge.items, projectRoot, pythonPath, setMergeError, videoPathKey])

  useEffect(() => {
    if (!hasTauriRuntime()) return undefined
    let dispose = () => undefined
    let disposed = false
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setDropActive(true)
        return
      }
      if (event.payload.type === 'leave') {
        setDropActive(false)
        return
      }
      setDropActive(false)
      const audioPaths = event.payload.paths.filter((path) => audioExtensions.has(extension(path)))
      const videoPaths = event.payload.paths.filter((path) => videoExtensions.has(extension(path)))
      const store = useMergeStore.getState()
      if (videoPaths.length > 0) store.addVideos(videoPaths.map((path) => ({ path, name: fileName(path) })))
      if (audioPaths.length > 0) store.addAudioFiles(audioPaths, playheadRef.current)
    }).then((unlisten) => {
      if (disposed) unlisten()
      else dispose = unlisten
    }).catch(() => undefined)
    return () => {
      disposed = true
      dispose()
    }
  }, [])

  const videoTrackIds = useMemo(() => merge.videoTracks.map((track) => track.id), [merge.videoTracks])
  const clipLayouts = useMemo(() => {
    return buildClipLayouts(merge.items, videoTrackIds, metadata)
  }, [merge.items, metadata, videoTrackIds])
  const probing = merge.items.some((item) => !metadata[normalizePath(item.path)])
  const videoDuration = Math.max(0, ...clipLayouts.map((layout) => layout.end))
  const audioTimelineEnd = Math.max(0, ...merge.audioItems.map(
    (audio) => audio.startTime + audioDuration(audio, audioDurations, metadata),
  ))
  const totalDuration = Math.max(videoDuration, audioTimelineEnd)
  const timelineContentWidth = Math.max(timelineMinimumWidth, Math.ceil(totalDuration * timelinePixelsPerSecond))
  const effectiveSelectedClipId = clipLayouts.some((layout) => layout.item.id === selectedClipId)
    ? selectedClipId
    : selectedAudioId ? '' : clipLayouts[0]?.item.id ?? ''
  const selectedLayout = clipLayouts.find((layout) => layout.item.id === effectiveSelectedClipId) ?? null
  const selectedClip = selectedLayout?.item ?? null
  const activeLayouts = activeLayoutsAt(clipLayouts, playhead, videoTrackIds)
  const activeLayoutKey = activeLayouts.map((layout) => layout.item.id).join('|')
  const groupEditing = activeLayouts.length > 1 && groupEditingKey === activeLayoutKey
  const currentLayout = activeLayouts.find((layout) => layout.item.id === effectiveSelectedClipId)
    ?? activeLayouts[0]
    ?? selectedLayout
  const previewClip = currentLayout?.item ?? selectedClip
  const selectedAudio = merge.audioItems.find((item) => item.id === selectedAudioId) ?? null
  const previewLayout = previewClip
    ? clipLayouts.find((layout) => layout.item.id === previewClip.id) ?? null
    : null
  const previewLocalTime = previewLayout
    ? clamp(playhead - previewLayout.start, 0, previewLayout.duration)
    : 0
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
  const resolutionValue = resolutionOptions.some(
    (item) => item.width === merge.settings.width && item.height === merge.settings.height,
  ) ? `${merge.settings.width}x${merge.settings.height}` : 'custom'
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
  const timelineTrackRows = merge.videoTracks.length + merge.audioTracks.length
  const timelineTracksTemplate = `repeat(${timelineTrackRows}, 54px)`
  const timelineContentHeight = 30 + timelineTrackRows * 60

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
    setPlayhead((current) => Math.abs(current - next) >= 0.0005 ? next : current)
    if (layout) {
      setSelectedClipId((current) => layouts.some((active) => active.item.id === current) ? current : layout.item.id)
    }

    const now = Date.now()
    if (!forceMediaUpdate && now - lastScrubMediaUpdateRef.current < scrubMediaIntervalMs) return
    for (const active of layouts) {
      const video = previewVideoRefs.current.get(active.item.id)
      if (!video || video.readyState < 1) continue
      const target = active.item.trimStart + Math.max(0, next - active.start)
      if (Math.abs(video.currentTime - target) >= 0.008) video.currentTime = target
    }
    lastScrubMediaUpdateRef.current = now
  }, [clipLayouts, totalDuration, videoTrackIds])

  const seekGlobal = useCallback((time: number, autoPlay = false) => {
    scrubGlobal(time, true)
    window.requestAnimationFrame(() => {
      if (!autoPlay) return
      playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
      setPlaying(true)
    })
  }, [scrubGlobal])

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
    const layouts = activeLayoutsAt(clipLayouts, playheadRef.current, videoTrackIds)
    for (const layout of layouts) {
      const video = previewVideoRefs.current.get(layout.item.id)
      if (!video) continue
      const target = layout.item.trimStart + Math.max(0, playheadRef.current - layout.start)
      const sync = () => {
        if (Math.abs(video.currentTime - target) > 0.2) video.currentTime = target
        video.playbackRate = 1
        if (playing) void video.play().catch(() => undefined)
        else video.pause()
      }
      if (video.readyState >= 1) sync()
      else video.addEventListener('loadedmetadata', sync, { once: true })
    }
  }, [activeLayoutKey, clipLayouts, playing, videoTrackIds])

  useEffect(() => {
    if (!playing) {
      previewVideoRefs.current.forEach((video) => {
        video.pause()
        video.playbackRate = 1
      })
      return undefined
    }
    playbackAnchorRef.current = { time: playheadRef.current, timestamp: performance.now() }
    const update = (timestamp: number) => {
      const next = playbackAnchorRef.current.time + (timestamp - playbackAnchorRef.current.timestamp) / 1000
      if (next >= totalDuration) {
        playheadRef.current = totalDuration
        setPlayhead(totalDuration)
        setPlaying(false)
        return
      }
      playheadRef.current = next
      if (timestamp - lastPlaybackUiUpdateRef.current > 66) {
        setPlayhead(next)
        keepTimelineTimeVisible(next)
        lastPlaybackUiUpdateRef.current = timestamp
      }
      if (timestamp - lastPlaybackSyncRef.current > 450) {
        const layouts = activeLayoutsAt(clipLayouts, next, videoTrackIds)
        for (const layout of layouts) {
          const video = previewVideoRefs.current.get(layout.item.id)
          if (!video || video.readyState < 1) continue
          const target = layout.item.trimStart + Math.max(0, next - layout.start)
          const drift = target - video.currentTime
          if (Math.abs(drift) > 0.4) {
            video.currentTime = target
            video.playbackRate = 1
          } else {
            video.playbackRate = clamp(1 + drift * 0.12, 0.97, 1.03)
          }
          if (video.paused) void video.play().catch(() => undefined)
        }
        lastPlaybackSyncRef.current = timestamp
      }
      playbackFrameRef.current = window.requestAnimationFrame(update)
    }
    playbackFrameRef.current = window.requestAnimationFrame(update)
    return () => {
      if (playbackFrameRef.current !== null) window.cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = null
    }
  }, [clipLayouts, keepTimelineTimeVisible, playing, totalDuration, videoTrackIds])

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
      merge.addAudioFiles(paths, playhead)
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
    const start = playhead >= totalDuration - 0.02 ? 0 : playhead
    scrubGlobal(start, true)
    playbackAnchorRef.current = { time: start, timestamp: performance.now() }
    setPlaying(true)
  }

  function handleTimelineWheel(event: React.WheelEvent<HTMLDivElement>) {
    const viewport = timelineScrollRef.current
    if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    event.preventDefault()
    viewport.scrollLeft += event.deltaY
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
      if (contentRect) scrubGlobal(timelineTimeFromClientX(latestClientX, contentRect, totalDuration))
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
        if (contentRect) scrubGlobal(timelineTimeFromClientX(latestClientX, contentRect, totalDuration), true)
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
    const rect = timelineRef.current.getBoundingClientRect()
    const resumeAfterSeek = playing
    if (resumeAfterSeek) setPlaying(false)
    let latestTime = timelineTimeFromClientX(event.clientX, rect, totalDuration)

    const scheduleSeek = (clientX: number) => {
      latestTime = timelineTimeFromClientX(clientX, rect, totalDuration)
      if (timelineSeekFrameRef.current !== null) return
      timelineSeekFrameRef.current = window.requestAnimationFrame(() => {
        timelineSeekFrameRef.current = null
        scrubGlobal(latestTime)
      })
    }
    const move = (pointerEvent: PointerEvent) => scheduleSeek(pointerEvent.clientX)
    const end = (pointerEvent: PointerEvent) => {
      latestTime = timelineTimeFromClientX(pointerEvent.clientX, rect, totalDuration)
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
    const layout = findLayoutAt(clipLayouts, playhead)
    if (!layout) return
    splitClipAt(layout, playhead)
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
    setSelectedClipId(layout.item.id)
    merge.setError('')
    setClipContextMenu(null)
  }

  function duplicateClip(layout: ClipLayout) {
    const duplicateId = merge.duplicateVideo(layout.item.id)
    if (duplicateId) setSelectedClipId(duplicateId)
    setSelectedAudioId('')
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
    setSelectedClipId(layout.item.id)
    setClipContextMenu(null)
  }

  function removeClip(layout: ClipLayout) {
    merge.removeVideo(layout.item.id)
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

  function handleVideoClipPointerDown(event: React.PointerEvent, layout: ClipLayout) {
    if (event.button !== 0 || !timelineRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedAudioId('')
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
    const pointerOffset = timelineTimeFromClientX(event.clientX, initialRect, totalDuration) - layout.start
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
          const nextStart = timelineTimeFromClientX(latestX, contentRect, totalDuration) - pointerOffset
          merge.moveVideoTo(layout.item.id, clamp(nextStart, 0, totalDuration), trackId, false)
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
          const nextStart = timelineTimeFromClientX(latestX, contentRect, totalDuration) - pointerOffset
          merge.moveVideoTo(layout.item.id, clamp(nextStart, 0, totalDuration), trackId, false)
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
      const nextTime = contentRect ? timelineTimeFromClientX(latestX, contentRect, totalDuration) : playheadRef.current
      scrubGlobal(nextTime, true)
      if (scrubbed && resumeAfterSeek) seekGlobal(nextTime, true)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }

  function handleAudioPointerDown(event: React.PointerEvent, audio: MergeAudioItem) {
    if (event.button !== 0 || !timelineRef.current || totalDuration <= 0) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedClipId('')
    setSelectedAudioId(audio.id)
    setClipContextMenu(null)
    setAudioContextMenu(null)
    const initialRect = timelineRef.current.getBoundingClientRect()
    const pointerOffset = timelineTimeFromClientX(event.clientX, initialRect, totalDuration) - audio.startTime
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
        const contentRect = timelineRef.current?.getBoundingClientRect()
        if (!contentRect) return
        const next = timelineTimeFromClientX(latestX, contentRect, totalDuration) - pointerOffset
        const trackId = trackIdAtPoint(latestX, latestY, 'audio') ?? audio.trackId
        merge.updateAudio(audio.id, { startTime: clamp(next, 0, totalDuration), trackId }, false)
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

  function scheduleTimelineSeek(clientX: number, rect: DOMRect) {
    const nextTime = timelineTimeFromClientX(clientX, rect, totalDuration)
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
        audioTracks: merge.audioItems.map((item) => ({
          path: item.path,
          startTime: item.startTime,
          trimStart: item.trimStart,
          trimEnd: item.trimEnd > item.trimStart ? item.trimEnd : undefined,
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
          <button type="button" title="在播放头位置拆分当前片段" disabled={!selectedClip} onClick={splitAtPlayhead}>
            <Scissors />拆分
          </button>
          <button
            className="danger"
            type="button"
            title="移除选中的视频或音频片段"
            disabled={!selectedClip && !selectedAudio}
            onClick={() => {
              if (selectedAudio) {
                merge.removeAudio(selectedAudio.id)
                setSelectedAudioId('')
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
        <GlassPanel className="editor-preview-panel frame-preview-card video-preview-card" style={{ maxWidth: 'none' }}>
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
                background: merge.settings.canvasBackground === 'white' ? '#fff' : '#000',
              } : undefined}
            >
              {previewLayouts.length > 0 ? previewLayouts.map((layout, index) => {
                const info = metadata[normalizePath(layout.item.path)]
                const cell = previewCells[index]
                const localCell = cell ? { left: 0, top: 0, width: cell.width, height: cell.height } : undefined
                return (
                  <div
                    className={[
                      'editor-preview-item',
                      effectiveSelectedClipId === layout.item.id ? 'selected' : '',
                      activeLayouts.length > 1 && !cropEditing ? 'draggable' : '',
                    ].filter(Boolean).join(' ')}
                    key={layout.item.id}
                    title={activeLayouts.length > 1 ? `${layout.item.name}：拖动可调整画面位置` : layout.item.name}
                    style={cell ? {
                      left: cell.left,
                      top: cell.top,
                      width: cell.width,
                      height: cell.height,
                    } : undefined}
                    onPointerDown={(event) => handlePreviewLayoutPointerDown(event, layout, index)}
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
                    style={previewExportVideoStyle(
                      layout.item,
                      info?.width ?? 0,
                      info?.height ?? 0,
                      localCell,
                      merge.settings.fitMode,
                      cropEditing,
                    )}
                    muted={layout.item.muted}
                    preload="auto"
                    playsInline
                    onLoadedMetadata={() => {
                      if (layout.item.id === previewClip?.id) updatePreviewGeometry()
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
              {groupEditing && !cropEditing && activeGroupPixelRect && (
                <div
                  className="editor-group-selection"
                  style={{
                    left: activeGroupPixelRect.left,
                    top: activeGroupPixelRect.top,
                    width: activeGroupPixelRect.width,
                    height: activeGroupPixelRect.height,
                  }}
                  onPointerDown={(event) => handleGroupLayoutPointerDown(event, 'move')}
                >
                  <span>组合画面</span>
                  {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as CropHandle[]).map((handle) => (
                    <button
                      type="button"
                      key={handle}
                      className={`editor-group-handle ${handle}`}
                      aria-label={`调整组合画面 ${handle}`}
                      onPointerDown={(event) => handleGroupLayoutPointerDown(event, handle)}
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
                onPointerDown={cropEditing ? (event) => handleCropPointerDown(event, 'draw') : undefined}
              >
                <CropMasks rect={cropRectFromClip(previewClip, cropGeometry)} geometry={cropGeometry} />
                <div
                  className="video-crop-selection"
                  style={cropSelectionStyle(cropRectFromClip(previewClip, cropGeometry), cropGeometry)}
                  onPointerDown={(event) => handleCropPointerDown(event, 'move')}
                >
                  <span>导出区域</span>
                  {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as CropHandle[]).map((handle) => (
                    <button
                      type="button"
                      key={handle}
                      className={`video-crop-handle ${handle}`}
                      aria-label={`调整选区 ${handle}`}
                      onPointerDown={(event) => handleCropPointerDown(event, handle)}
                    />
                  ))}
                </div>
              </div>
            )}
            </div>
            {previewClip && cropEditing && (
              <div className="video-crop-toolbar">
                <strong><SquareDashedMousePointer />调整视频尺寸</strong>
                <span>拖动画面重新框选，拖动红框或控制点微调</span>
                <button type="button" onClick={resetCropSelection}>重置全画面</button>
                <button type="button" onClick={() => setCropEditing(false)}>完成</button>
              </div>
            )}
            <div className="editor-preview-size-tools">
              <button type="button" title="还原播放窗口默认尺寸" onClick={() => setPreviewSize({ width: 720, height: 420 })}>
                <RotateCcw />还原窗口
              </button>
            </div>
            <button
              type="button"
              className="editor-preview-resize-handle"
              aria-label="拖动调整播放窗口尺寸"
              title="按住鼠标左键拖动调整播放窗口尺寸"
              onPointerDown={handlePreviewResizePointerDown}
            />
          </div>
          <div className="editor-player-controls">
            <button type="button" title="回到时间线起点" onClick={() => seekGlobal(0)}><SkipBack /></button>
            <button className="primary" type="button" title={playing ? '暂停' : '播放'} onClick={togglePlayback}>
              {playing ? <Pause /> : <Play />}
            </button>
            <button type="button" title="回到当前片段起点" disabled={!selectedLayout} onClick={() => selectedLayout && seekGlobal(selectedLayout.start)}>
              <RotateCcw />
            </button>
            <time title={`时间线 ${formatPreciseTime(playhead)} / ${formatPreciseTime(totalDuration)}`}>
              片段 {formatPreciseTime(previewLocalTime)} / {formatPreciseTime(previewLayout?.duration ?? 0)}
              <small>时间线 {formatPreciseTime(playhead)} / {formatPreciseTime(totalDuration)}</small>
            </time>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, totalDuration)}
              step={0.001}
              value={Math.min(playhead, Math.max(0.01, totalDuration))}
              onChange={(event) => seekGlobal(Number(event.target.value))}
            />
          </div>
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
              <NumberField
                label="画质 CRF"
                tip="有效设置。H.264 恒定质量参数，数值越低画质越高、文件越大；常用范围 18–28。"
                value={merge.settings.crf}
                min={0}
                max={51}
                onChange={(crf) => merge.setSettings({ crf })}
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

        <GlassPanel className="editor-inspector-panel">
          <div className="editor-inspector-title"><Settings2 /><strong>属性与输出</strong></div>
          {selectedClip ? (
            <div className="editor-selected-media">
              <span>视频片段</span>
              <strong title={selectedClip.path}>{selectedClip.name}</strong>
              <small>
                {formatPreciseTime(selectedClip.trimStart)} - {formatPreciseTime(clipSourceEnd(selectedClip, metadata[normalizePath(selectedClip.path)]))}
                {selectedClip.rotation ? ` · 右旋 ${selectedClip.rotation}°` : ''}
              </small>
              <div className="editor-time-fields">
                <NumberField label="入点" value={selectedClip.trimStart} min={0} step={0.001} onChange={(trimStart) => merge.updateVideo(selectedClip.id, { trimStart })} />
                <NumberField label="出点" value={selectedClip.trimEnd} min={0} step={0.001} placeholder="自动" onChange={(trimEnd) => merge.updateVideo(selectedClip.id, { trimEnd })} />
              </div>
            </div>
          ) : selectedAudio ? (
            <div className="editor-selected-media audio">
              <span>音频片段</span>
              <strong title={selectedAudio.path}>{selectedAudio.name}</strong>
              <div className="editor-time-fields">
                <NumberField label="时间线位置" value={selectedAudio.startTime} min={0} step={0.001} onChange={(startTime) => merge.updateAudio(selectedAudio.id, { startTime })} />
                <NumberField label="音频入点" value={selectedAudio.trimStart} min={0} step={0.001} onChange={(trimStart) => merge.updateAudio(selectedAudio.id, { trimStart })} />
              </div>
            </div>
          ) : <p className="editor-no-selection">选择时间线上的视频或音频片段后可调整属性。</p>}

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
                    const preset = resolutionOptions.find((item) => `${item.width}x${item.height}` === event.target.value)
                    if (preset) merge.setSettings({ width: preset.width, height: preset.height })
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
                onChange={(width) => merge.setSettings({ width: evenDimension(width) })}
              />
              <NumberField
                label="自定义高度"
                tip={`可超过来源最大高度 ${resolutionBounds.height}，技术上限 ${maximumOutputDimension}。多余区域按“空余区域”设置填充。`}
                value={merge.settings.height}
                min={minimumOutputDimension}
                max={maximumOutputDimension}
                step={2}
                onChange={(height) => merge.setSettings({ height: evenDimension(height) })}
              />
            </div>
            <div className={`editor-resize-card ${previewClip?.cropEnabled ? 'active' : ''}`}>
              <div>
                <strong>当前预览片段尺寸</strong>
                <span>{previewClip?.cropEnabled ? `${previewClip.cropWidth} × ${previewClip.cropHeight}，仅显示并导出框内画面` : '当前片段使用完整画面'}</span>
              </div>
              <button type="button" disabled={!previewClip} onClick={openCropEditor}>
                <SquareDashedMousePointer />{previewClip?.cropEnabled ? '编辑红框' : '开始调整'}
              </button>
              {previewClip?.cropEnabled && (
                <button type="button" className="subtle" onClick={() => {
                  merge.updateVideo(previewClip.id, { cropEnabled: false })
                  setCropEditing(false)
                }}>取消调整</button>
              )}
            </div>
          </div>
        </GlassPanel>
      </div>

      <GlassPanel className="editor-timeline-panel">
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
            </div>
          </div>
          <div ref={timelineScrollRef} className="timeline-scroll-viewport" onWheel={handleTimelineWheel}>
            <div
              ref={timelineRef}
              className="timeline-scroll-content"
              style={{ width: timelineContentWidth, minWidth: '100%', minHeight: timelineContentHeight }}
            >
              <div className="timeline-ruler">
                {timeTicks(totalDuration, timelineContentWidth).map((tick) => (
                  <time key={tick} style={{ left: `${percent(tick, totalDuration)}%` }}>{formatTick(tick)}</time>
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
                        left: `${percent(layout.start, totalDuration)}%`,
                        width: `${Math.max(0.3, percent(layout.duration, totalDuration))}%`,
                      }}
                      key={layout.item.id}
                      title={`${layout.item.name}\n${formatPreciseTime(layout.duration)}\n短按或拖动定位播放头，长按后可移动到任意视频线和时间位置，右键打开操作菜单`}
                      onPointerDown={(event) => handleVideoClipPointerDown(event, layout)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const rect = timelineRef.current?.getBoundingClientRect()
                        const contextTime = rect
                          ? clamp(timelineTimeFromClientX(event.clientX, rect, totalDuration), layout.start, layout.end)
                          : layout.start
                        setSelectedAudioId('')
                        setSelectedClipId(layout.item.id)
                        setAudioContextMenu(null)
                        setClipContextMenu({
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 250)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 390)),
                          layout,
                          time: contextTime,
                        })
                      }}
                    >
                      <span className="timeline-clip-grip" aria-hidden="true">
                        <GripVertical />
                      </span>
                      <span>{layout.item.name}</span>
                      {layout.item.rotation !== 0 && <RotateCw className="timeline-transform-icon" aria-label={`右旋 ${layout.item.rotation} 度`} />}
                      {layout.item.cropEnabled && <SquareDashedMousePointer className="timeline-transform-icon" aria-label="该片段已裁剪" />}
                      {layout.item.muted && <VolumeX className="timeline-muted-icon" aria-label="该片段已静音" />}
                      <small>{formatPreciseTime(layout.duration)}</small>
                    </button>
                  ))}
                </div>
                ))}
                {merge.audioTracks.map((track) => {
                  const trackAudio = merge.audioItems.filter((audio) => audio.trackId === track.id)
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
                  {trackAudio.map((audio) => {
                    const duration = audioDuration(audio, audioDurations, metadata)
                    return (
                      <button
                        type="button"
                        className={[
                          'timeline-audio-clip',
                          selectedAudioId === audio.id ? 'selected' : '',
                          draggedAudioId === audio.id ? 'long-press-dragging' : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left: `${percent(audio.startTime, totalDuration)}%`,
                          width: `${Math.max(0.3, percent(duration, totalDuration))}%`,
                        }}
                        key={audio.id}
                        title={`${audio.name}\n长按后拖动可调整时间线位置，右键打开操作菜单`}
                        onPointerDown={(event) => handleAudioPointerDown(event, audio)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setSelectedClipId('')
                          setSelectedAudioId(audio.id)
                          setClipContextMenu(null)
                          setAudioContextMenu({
                            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
                            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 230)),
                            audio,
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
              </div>
              {totalDuration > 0 && (
                <div
                  className={`timeline-playhead ${playheadDragging ? 'dragging' : ''}`}
                  style={{ left: `${percent(playhead, totalDuration)}%` }}
                >
                  <button
                    type="button"
                    className="timeline-playhead-handle"
                    aria-label="长按并拖动播放头"
                    title="长按倒三角后拖动播放位置"
                    onPointerDown={handlePlayheadHandlePointerDown}
                  >
                    <i />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {merge.audioItems.map((audio) => (
          <audio
            key={`probe-${audio.id}`}
            src={localFileSrc(audio.path)}
            preload="metadata"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration
              if (Number.isFinite(duration)) setAudioDurations((current) => ({ ...current, [audio.id]: duration }))
            }}
          />
        ))}
      </GlassPanel>

      <GlassPanel className="editor-export-status">
        <div className="merge-run-head">
          <div><Gauge /><span>导出状态</span><strong title={merge.stage}>{merge.stage}</strong></div>
          <b>{merge.progress.toFixed(2)}%</b>
        </div>
        <div className="merge-progress-track"><span style={{ width: `${merge.progress}%` }} /></div>
        {merge.error && <p className="merge-message error">{merge.error}</p>}
        {merge.outputPaths.length > 0 && (
          <div className="merge-output-list">
            <p><CheckCircle2 />{merge.outputPaths.length} 个输出文件已生成</p>
            {merge.outputPaths.map((path) => <button type="button" key={path} title={path} onClick={() => void revealInFolder(path)}>{path}</button>)}
          </div>
        )}
        <button type="button" className="merge-log-toggle" onClick={() => setLogsExpanded((value) => !value)}>
          <Clock3 />日志 {merge.logs.length} 行
        </button>
        {logsExpanded && (
          <div className="merge-log-view">
            {merge.logs.length > 0
              ? merge.logs.map((log, index) => <div className={log.stream} key={`${log.timestamp}-${index}`}>[{log.stream}] {log.line}</div>)
              : <span>暂无日志</span>}
          </div>
        )}
      </GlassPanel>

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
          <button type="button" role="menuitem" onClick={() => {
            if (trackContextMenu.kind === 'video') merge.addVideoTrack()
            else merge.addAudioTrack()
            setTrackContextMenu(null)
          }}>
            <Plus />新建{trackContextMenu.kind === 'video' ? '视频线' : '音频线'}
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            disabled={trackContextMenu.kind === 'video' ? merge.videoTracks.length <= 1 : merge.audioTracks.length <= 1}
            title="删除轨道后，其中的片段会移动到保留的第一条同类轨道"
            onClick={() => {
              const removed = trackContextMenu.kind === 'video'
                ? merge.removeVideoTrack(trackContextMenu.trackId)
                : merge.removeAudioTrack(trackContextMenu.trackId)
              if (!removed) merge.setError(`${trackContextMenu.kind === 'video' ? '视频线' : '音频线'}至少保留一条。`)
              setTrackContextMenu(null)
            }}
          >
            <Trash2 />删除当前{trackContextMenu.kind === 'video' ? '视频线' : '音频线'}
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
          <strong title={audioContextMenu.audio.path}>{audioContextMenu.audio.name}</strong>
          <span className="clip-context-menu-range">
            时间线位置 {formatPreciseTime(audioContextMenu.audio.startTime)}
          </span>
          <button type="button" role="menuitem" onClick={() => {
            seekGlobal(audioContextMenu.audio.startTime)
            setAudioContextMenu(null)
          }}>
            <SkipBack />定位到音频开头
          </button>
          <button type="button" role="menuitem" onClick={() => {
            merge.updateAudio(audioContextMenu.audio.id, { startTime: playheadRef.current })
            setAudioContextMenu(null)
          }}>
            <ArrowRight />移动到播放头
          </button>
          <button type="button" role="menuitem" disabled={audioContextMenu.audio.startTime === 0} onClick={() => {
            merge.updateAudio(audioContextMenu.audio.id, { startTime: 0 })
            setAudioContextMenu(null)
          }}>
            <RotateCcw />移到时间线起点
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setAudioContextMenu(null)
            void revealInFolder(audioContextMenu.audio.path).catch((error) => merge.setError(normalizeBackendError(error)))
          }}>
            <FolderOpen />在文件夹中显示
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => {
            merge.removeAudio(audioContextMenu.audio.id)
            setSelectedAudioId('')
            setAudioContextMenu(null)
          }}>
            <Trash2 />删除音频片段
          </button>
        </div>
        </Translated>,
        document.body,
      )}
    </div>
    </Translated>
  )
}

function NumberField({
  label,
  tip,
  value,
  min,
  max,
  step = 1,
  placeholder,
  onChange,
}: {
  label: string
  tip?: string
  value: number
  min?: number
  max?: number
  step?: number
  placeholder?: string
  onChange: (value: number) => void
}) {
  return (
    <Translated>
    <label>
      {tip ? <ParameterHint label={label} tip={tip} /> : <span>{label}</span>}
      <TextInput
        type="number"
        value={value || ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(event) => onChange(clamp(numeric(event.target.value), min, max))}
      />
    </label>
    </Translated>
  )
}

function CropMasks({ rect, geometry }: { rect: CropRect; geometry: CropGeometry }) {
  const left = rect.x / geometry.sourceWidth * 100
  const top = rect.y / geometry.sourceHeight * 100
  const right = (rect.x + rect.width) / geometry.sourceWidth * 100
  const bottom = (rect.y + rect.height) / geometry.sourceHeight * 100
  return (
    <>
      <i className="video-crop-mask top" style={{ height: `${top}%` }} />
      <i className="video-crop-mask bottom" style={{ top: `${bottom}%` }} />
      <i className="video-crop-mask left" style={{ top: `${top}%`, width: `${left}%`, height: `${bottom - top}%` }} />
      <i className="video-crop-mask right" style={{ top: `${top}%`, left: `${right}%`, height: `${bottom - top}%` }} />
    </>
  )
}

function cropRectFromClip(
  clip: Pick<MergeQueueItem, 'cropX' | 'cropY' | 'cropWidth' | 'cropHeight'>,
  geometry: CropGeometry,
): CropRect {
  return cropRectForDimensions(clip, geometry.sourceWidth, geometry.sourceHeight)
}

function cropRectForDimensions(
  clip: Pick<MergeQueueItem, 'cropX' | 'cropY' | 'cropWidth' | 'cropHeight'>,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const x = clamp(Math.round(clip.cropX), 0, Math.max(0, sourceWidth - 2))
  const y = clamp(Math.round(clip.cropY), 0, Math.max(0, sourceHeight - 2))
  return {
    x,
    y,
    width: clamp(Math.round(clip.cropWidth || sourceWidth), 2, sourceWidth - x),
    height: clamp(Math.round(clip.cropHeight || sourceHeight), 2, sourceHeight - y),
  }
}

function previewExportVideoStyle(
  clip: MergeQueueItem,
  rawWidth: number,
  rawHeight: number,
  target: PreviewCanvasGeometry | undefined,
  fitMode: MergeFitMode,
  cropEditing: boolean,
): React.CSSProperties {
  if (!target || rawWidth <= 0 || rawHeight <= 0) return { opacity: 0 }
  const source = rotatedDimensions(rawWidth, rawHeight, clip.rotation)
  const crop = cropEditing
    ? { x: 0, y: 0, width: source.width, height: source.height }
    : clip.cropEnabled
      ? cropRectForDimensions(clip, source.width, source.height)
      : { x: 0, y: 0, width: source.width, height: source.height }
  const effectiveFitMode: MergeFitMode = cropEditing ? 'contain' : fitMode
  const canvasWidth = target.width
  const canvasHeight = target.height
  let scaleX = canvasWidth / crop.width
  let scaleY = canvasHeight / crop.height
  if (effectiveFitMode !== 'stretch') {
    const scale = effectiveFitMode === 'cover'
      ? Math.max(scaleX, scaleY)
      : Math.min(scaleX, scaleY)
    scaleX = scale
    scaleY = scale
  }
  const offsetX = target.left + (canvasWidth - crop.width * scaleX) / 2
  const offsetY = target.top + (canvasHeight - crop.height * scaleY) / 2
  const rotation = rotationMatrix(clip.rotation, rawWidth, rawHeight)
  const matrix = [
    scaleX * rotation.a,
    scaleY * rotation.b,
    scaleX * rotation.c,
    scaleY * rotation.d,
    scaleX * rotation.e + offsetX - crop.x * scaleX,
    scaleY * rotation.f + offsetY - crop.y * scaleY,
  ]
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: rawWidth,
    height: rawHeight,
    maxWidth: 'none',
    maxHeight: 'none',
    objectFit: 'fill',
    transform: `matrix(${matrix.join(',')})`,
    transformOrigin: '0 0',
  }
}

function rotationMatrix(rotation: MergeRotation, rawWidth: number, rawHeight: number) {
  if (rotation === 90) return { a: 0, b: 1, c: -1, d: 0, e: rawHeight, f: 0 }
  if (rotation === 180) return { a: -1, b: 0, c: 0, d: -1, e: rawWidth, f: rawHeight }
  if (rotation === 270) return { a: 0, b: -1, c: 1, d: 0, e: 0, f: rawWidth }
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

function rotatedDimensions(width: number, height: number, rotation: MergeRotation) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height }
}

function evenDimension(value: number) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

function cropSelectionStyle(rect: CropRect, geometry: CropGeometry): React.CSSProperties {
  return {
    left: `${rect.x / geometry.sourceWidth * 100}%`,
    top: `${rect.y / geometry.sourceHeight * 100}%`,
    width: `${rect.width / geometry.sourceWidth * 100}%`,
    height: `${rect.height / geometry.sourceHeight * 100}%`,
  }
}

function cropPointFromClient(clientX: number, clientY: number, screenRect: DOMRect, geometry: CropGeometry) {
  return {
    x: clamp(Math.round((clientX - screenRect.left - geometry.left) / geometry.width * geometry.sourceWidth), 0, geometry.sourceWidth),
    y: clamp(Math.round((clientY - screenRect.top - geometry.top) / geometry.height * geometry.sourceHeight), 0, geometry.sourceHeight),
  }
}

function resizeCropRect(
  start: CropRect,
  origin: { x: number; y: number },
  point: { x: number; y: number },
  handle: CropHandle,
  geometry: CropGeometry,
): CropRect {
  if (handle === 'draw') {
    const x = Math.min(origin.x, point.x)
    const y = Math.min(origin.y, point.y)
    return {
      x: clamp(x, 0, geometry.sourceWidth - 2),
      y: clamp(y, 0, geometry.sourceHeight - 2),
      width: clamp(Math.abs(point.x - origin.x), 2, geometry.sourceWidth - x),
      height: clamp(Math.abs(point.y - origin.y), 2, geometry.sourceHeight - y),
    }
  }
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + point.x - origin.x, 0, geometry.sourceWidth - start.width),
      y: clamp(start.y + point.y - origin.y, 0, geometry.sourceHeight - start.height),
    }
  }

  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('w')) left = clamp(point.x, 0, right - 2)
  if (handle.includes('e')) right = clamp(point.x, left + 2, geometry.sourceWidth)
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - 2)
  if (handle.includes('s')) bottom = clamp(point.y, top + 2, geometry.sourceHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function buildClipLayouts(
  items: MergeQueueItem[],
  trackIds: string[],
  metadata: Record<string, VideoMetadata>,
) {
  const cursors = new Map(trackIds.map((trackId) => [trackId, 0]))
  return items.map<ClipLayout>((item) => {
    const trackId = trackIds.includes(item.trackId) ? item.trackId : trackIds[0] ?? item.trackId
    const duration = clipDuration(item, metadata[normalizePath(item.path)])
    const start = item.startTime === null ? cursors.get(trackId) ?? 0 : Math.max(0, item.startTime)
    const end = start + duration
    cursors.set(trackId, Math.max(cursors.get(trackId) ?? 0, end))
    return { item, trackId, start, duration, end }
  })
}

function activeLayoutsAt(layouts: ClipLayout[], time: number, trackIds: string[]) {
  const trackOrder = new Map(trackIds.map((trackId, index) => [trackId, index]))
  return layouts
    .filter((layout) => time >= layout.start && time < layout.end)
    .sort((left, right) => (
      (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0)
      || left.start - right.start
    ))
}

function previewLayoutRects(items: MergeQueueItem[]): NormalizedLayoutRect[] {
  if (items.length === 0) return []
  if (items.length === 1) return [{ x: 0, y: 0, width: 1, height: 1 }]
  if (items.every((item) => item.layoutCustom)) {
    return items.map((item) => normalizeLayoutRect({
      x: item.layoutX,
      y: item.layoutY,
      width: item.layoutWidth,
      height: item.layoutHeight,
    }))
  }
  return presetLayoutRects(items.length, 'grid')
}

function boundingLayoutRect(rects: NormalizedLayoutRect[]): NormalizedLayoutRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return normalizeLayoutRect({ x: left, y: top, width: right - left, height: bottom - top })
}

function normalizedPoint(clientX: number, clientY: number, rect: DOMRect) {
  return {
    x: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
  }
}

function resizeNormalizedRect(
  start: NormalizedLayoutRect,
  origin: { x: number; y: number },
  point: { x: number; y: number },
  handle: CropHandle,
) {
  if (handle === 'move') {
    return normalizeLayoutRect({
      ...start,
      x: start.x + point.x - origin.x,
      y: start.y + point.y - origin.y,
    })
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('w')) left = clamp(point.x, 0, right - 0.08)
  if (handle.includes('e')) right = clamp(point.x, left + 0.08, 1)
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - 0.08)
  if (handle.includes('s')) bottom = clamp(point.y, top + 0.08, 1)
  return normalizeLayoutRect({ x: left, y: top, width: right - left, height: bottom - top })
}

function transformLayoutRects(
  rects: NormalizedLayoutRect[],
  source: NormalizedLayoutRect,
  target: NormalizedLayoutRect,
) {
  return rects.map((rect) => normalizeLayoutRect({
    x: target.x + (rect.x - source.x) / Math.max(0.001, source.width) * target.width,
    y: target.y + (rect.y - source.y) / Math.max(0.001, source.height) * target.height,
    width: rect.width / Math.max(0.001, source.width) * target.width,
    height: rect.height / Math.max(0.001, source.height) * target.height,
  }))
}

function presetLayoutRects(
  count: number,
  mode: 'grid' | 'horizontal' | 'vertical',
): NormalizedLayoutRect[] {
  if (count <= 0) return []
  if (count === 1) return [{ x: 0, y: 0, width: 1, height: 1 }]
  const columns = mode === 'horizontal' ? count : mode === 'vertical' ? 1 : count <= 4 ? 2 : 3
  const rows = mode === 'vertical' ? count : mode === 'horizontal' ? 1 : Math.ceil(count / columns)
  const width = 1 / columns
  const height = 1 / rows
  return Array.from({ length: count }, (_, index) => ({
    x: index % columns * width,
    y: Math.floor(index / columns) * height,
    width,
    height,
  }))
}

function insetLayoutRects(rects: NormalizedLayoutRect[], inset: number) {
  return rects.map((rect) => normalizeLayoutRect({
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - inset * 2,
    height: rect.height - inset * 2,
  }))
}

function resolveDraggedLayout(
  raw: NormalizedLayoutRect,
  others: NormalizedLayoutRect[],
  snap: boolean,
  threshold: number,
) {
  let next = normalizeLayoutRect(raw)
  if (snap) {
    const xCandidates = [0, 1 - next.width]
    const yCandidates = [0, 1 - next.height]
    for (const other of others) {
      xCandidates.push(other.x, other.x + other.width, other.x - next.width, other.x + other.width - next.width)
      yCandidates.push(other.y, other.y + other.height, other.y - next.height, other.y + other.height - next.height)
    }
    next = {
      ...next,
      x: nearestSnap(next.x, xCandidates, threshold),
      y: nearestSnap(next.y, yCandidates, threshold),
    }
    next = normalizeLayoutRect(next)
  }
  if (others.some((other) => layoutRectsOverlap(next, other))) return null
  return next
}

function normalizeLayoutRect(rect: NormalizedLayoutRect): NormalizedLayoutRect {
  const width = clamp(rect.width, 0.05, 1)
  const height = clamp(rect.height, 0.05, 1)
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  }
}

function nearestSnap(value: number, candidates: number[], threshold: number) {
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate - value) <= threshold && Math.abs(candidate - value) < Math.abs(best - value)
      ? candidate
      : best
  ), value)
}

function layoutRectsOverlap(left: NormalizedLayoutRect, right: NormalizedLayoutRect) {
  const epsilon = 0.001
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon
}

function trackIdAtPoint(clientX: number, clientY: number, kind: 'video' | 'audio') {
  const element = document.elementFromPoint(clientX, clientY)
  const track = element?.closest<HTMLElement>(`[data-track-kind="${kind}"]`)
  return track?.dataset.trackId ?? null
}

function previousTrackLayout(layouts: ClipLayout[], layout: ClipLayout, direction: -1 | 1) {
  const trackLayouts = layouts
    .filter((candidate) => candidate.trackId === layout.trackId)
    .sort((left, right) => left.start - right.start)
  const index = trackLayouts.findIndex((candidate) => candidate.item.id === layout.item.id)
  return trackLayouts[index + direction] ?? null
}

function findLayoutAt(layouts: ClipLayout[], time: number) {
  return layouts.find((layout) => time >= layout.start && time < layout.end)
}

function clipDuration(item: MergeQueueItem, info?: VideoMetadata) {
  if (!info?.readable) return Math.max(0.1, item.trimEnd - item.trimStart || 1)
  return Math.max(0.1, clipSourceEnd(item, info) - item.trimStart)
}

function clipSourceEnd(item: MergeQueueItem, info?: VideoMetadata) {
  const duration = info?.readable ? info.duration : Math.max(item.trimEnd, item.trimStart + 1)
  return item.trimEnd > item.trimStart ? Math.min(item.trimEnd, duration) : duration
}

function audioDuration(audio: MergeAudioItem, durations: Record<string, number>, metadata: Record<string, VideoMetadata>) {
  const duration = durations[audio.id] ?? metadata[normalizePath(audio.path)]?.duration ?? 30
  const end = audio.trimEnd > audio.trimStart ? Math.min(audio.trimEnd, duration) : duration
  return Math.max(0.1, end - audio.trimStart)
}

function timeTicks(duration: number, width = timelineMinimumWidth) {
  if (duration <= 0) return [0]
  const targetTicks = clamp(Math.floor(width / 100), 6, 60)
  const raw = duration / targetTicks
  const units = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  const step = units.find((unit) => unit >= raw) ?? Math.ceil(raw / 3600) * 3600
  const ticks = []
  for (let value = 0; value <= duration; value += step) ticks.push(value)
  return ticks
}

function percent(value: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0
}

function timelineTimeFromClientX(clientX: number, rect: DOMRect, totalDuration: number) {
  if (rect.width <= 0 || totalDuration <= 0) return 0
  return clamp((clientX - rect.left) / rect.width * totalDuration, 0, totalDuration)
}

function canSplitClipAt(layout: ClipLayout, timelineTime: number, metadata: Record<string, VideoMetadata>) {
  const sourceTime = layout.item.trimStart + clamp(timelineTime - layout.start, 0, layout.duration)
  const sourceEnd = clipSourceEnd(layout.item, metadata[normalizePath(layout.item.path)])
  return sourceTime > layout.item.trimStart + 0.05 && sourceTime < sourceEnd - 0.05
}

function extension(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function numeric(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  return Math.max(min, Math.min(max, value))
}

function normalizePath(path: string) {
  return path.replaceAll('\\', '/').toLowerCase()
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':')
}

function formatPreciseTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const whole = Math.floor(safe)
  const milliseconds = Math.floor((safe - whole) * 1000)
  return `${formatDuration(whole)}.${String(milliseconds).padStart(3, '0')}`
}

function formatTick(seconds: number) {
  return seconds >= 3600 ? formatDuration(seconds) : formatDuration(seconds).slice(3)
}
