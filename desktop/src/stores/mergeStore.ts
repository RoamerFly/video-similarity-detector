import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AnalysisLog } from '@/stores/analysisStore'

export type MergeFitMode = 'contain' | 'cover' | 'stretch'
export type MergeSplitMode = 'none' | 'duration' | 'count'
export type MergeRotation = 0 | 90 | 180 | 270
export type MergeCanvasBackground = 'black' | 'white'

export interface MergeTrack {
  id: string
  name: string
}

export interface MergeQueueItem {
  id: string
  path: string
  name: string
  trackId: string
  startTime: number | null
  trimStart: number
  trimEnd: number
  muted: boolean
  rotation: MergeRotation
  cropEnabled: boolean
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
  layoutCustom: boolean
  layoutX: number
  layoutY: number
  layoutWidth: number
  layoutHeight: number
}

export interface MergeAudioItem {
  id: string
  path: string
  name: string
  trackId: string
  startTime: number
  trimStart: number
  trimEnd: number
  sourceType: 'external' | 'video'
  sourceClipId?: string
}

export interface MergeSettings {
  outputDir: string
  outputName: string
  width: number
  height: number
  fitMode: MergeFitMode
  canvasBackground: MergeCanvasBackground
  splitMode: MergeSplitMode
  splitValue: number
  fps: number
  crf: number
  encoderPreset: string
  includeAudio: boolean
  snapToVideos: boolean
}

type MergeVideoPatch = Partial<Pick<
  MergeQueueItem,
  | 'trackId'
  | 'startTime'
  | 'trimStart'
  | 'trimEnd'
  | 'muted'
  | 'rotation'
  | 'cropEnabled'
  | 'cropX'
  | 'cropY'
  | 'cropWidth'
  | 'cropHeight'
  | 'layoutCustom'
  | 'layoutX'
  | 'layoutY'
  | 'layoutWidth'
  | 'layoutHeight'
>>

interface MergeHistorySnapshot {
  items: MergeQueueItem[]
  audioItems: MergeAudioItem[]
  videoTracks: MergeTrack[]
  audioTracks: MergeTrack[]
  settings: MergeSettings
}

interface MergeState {
  items: MergeQueueItem[]
  audioItems: MergeAudioItem[]
  videoTracks: MergeTrack[]
  audioTracks: MergeTrack[]
  settings: MergeSettings
  running: boolean
  progress: number
  stage: string
  logs: AnalysisLog[]
  error: string
  outputPaths: string[]
  canUndo: boolean
  canRedo: boolean
  undoStack: MergeHistorySnapshot[]
  redoStack: MergeHistorySnapshot[]
  historyTransaction: MergeHistorySnapshot | null
  addVideoTrack: () => string
  addAudioTrack: () => string
  removeVideoTrack: (id: string) => boolean
  removeAudioTrack: (id: string) => boolean
  addVideo: (path: string, name?: string, trackId?: string) => boolean
  addVideos: (videos: Array<{ path: string; name?: string }>, trackId?: string) => number
  removeVideo: (id: string) => void
  duplicateVideo: (id: string) => string | null
  moveVideo: (id: string, direction: -1 | 1) => void
  moveVideoTo: (id: string, startTime: number, trackId: string, recordHistory?: boolean) => void
  updateVideo: (id: string, patch: MergeVideoPatch, recordHistory?: boolean) => void
  splitVideo: (id: string, sourceTime: number, timelineTime: number) => string | null
  clearVideos: () => void
  addAudio: (audio: Omit<MergeAudioItem, 'id' | 'trackId'> & { trackId?: string }) => string
  addAudioFiles: (paths: string[], startTime?: number, trackId?: string) => number
  updateAudio: (
    id: string,
    patch: Partial<Pick<MergeAudioItem, 'trackId' | 'startTime' | 'trimStart' | 'trimEnd'>>,
    recordHistory?: boolean,
  ) => void
  removeAudio: (id: string) => void
  clearAudio: () => void
  setSettings: (patch: Partial<MergeSettings>, recordHistory?: boolean) => void
  beginHistoryTransaction: () => void
  endHistoryTransaction: () => void
  undo: () => void
  redo: () => void
  setRunning: (running: boolean) => void
  setProgress: (progress: number, stage: string) => void
  appendLog: (log: AnalysisLog) => void
  clearLogs: () => void
  setError: (error: string) => void
  setOutputPaths: (paths: string[]) => void
}

const defaultVideoTrack: MergeTrack = { id: 'video-track-1', name: '视频线 1' }
const defaultAudioTrack: MergeTrack = { id: 'audio-track-1', name: '音频线 1' }

const defaultSettings: MergeSettings = {
  outputDir: 'data/merged',
  outputName: 'merged_video',
  width: 1920,
  height: 1080,
  fitMode: 'contain',
  canvasBackground: 'black',
  splitMode: 'none',
  splitValue: 600,
  fps: 30,
  crf: 23,
  encoderPreset: 'medium',
  includeAudio: true,
  snapToVideos: true,
}

const historyLimit = 100

export const useMergeStore = create<MergeState>()(
  persist(
    (set, get) => ({
      items: [],
      audioItems: [],
      videoTracks: [{ ...defaultVideoTrack }],
      audioTracks: [{ ...defaultAudioTrack }],
      settings: defaultSettings,
      running: false,
      progress: 0,
      stage: '等待开始',
      logs: [],
      error: '',
      outputPaths: [],
      canUndo: false,
      canRedo: false,
      undoStack: [],
      redoStack: [],
      historyTransaction: null,
      addVideoTrack: () => {
        const id = createId('video-track')
        set((state) => commitHistory(state, {
          videoTracks: [...state.videoTracks, { id, name: `视频线 ${state.videoTracks.length + 1}` }],
        }))
        return id
      },
      addAudioTrack: () => {
        const id = createId('audio-track')
        set((state) => commitHistory(state, {
          audioTracks: [...state.audioTracks, { id, name: `音频线 ${state.audioTracks.length + 1}` }],
        }))
        return id
      },
      removeVideoTrack: (id) => {
        const state = get()
        if (state.videoTracks.length <= 1 || !state.videoTracks.some((track) => track.id === id)) return false
        set((current) => {
          const videoTracks = current.videoTracks
            .filter((track) => track.id !== id)
            .map((track, index) => ({ ...track, name: `视频线 ${index + 1}` }))
          const fallbackTrackId = videoTracks[0].id
          const items = current.items.map((item) => item.trackId === id
            ? { ...item, trackId: fallbackTrackId }
            : item)
          return commitHistory(current, { videoTracks, items })
        })
        return true
      },
      removeAudioTrack: (id) => {
        const state = get()
        if (state.audioTracks.length <= 1 || !state.audioTracks.some((track) => track.id === id)) return false
        set((current) => {
          const audioTracks = current.audioTracks
            .filter((track) => track.id !== id)
            .map((track, index) => ({ ...track, name: `音频线 ${index + 1}` }))
          const fallbackTrackId = audioTracks[0].id
          const audioItems = current.audioItems.map((item) => item.trackId === id
            ? { ...item, trackId: fallbackTrackId }
            : item)
          return commitHistory(current, { audioTracks, audioItems })
        })
        return true
      },
      addVideo: (path, name, trackId) => {
        const normalized = normalizePath(path)
        if (!normalized) {
          return false
        }
        const targetTrackId = validTrackId(get().videoTracks, trackId, defaultVideoTrack.id)
        set((state) => commitHistory(state, {
          items: [...state.items, createVideoItem(path, name || fileName(path), targetTrackId)],
        }))
        return true
      },
      addVideos: (videos, trackId) => {
        const state = get()
        const targetTrackId = validTrackId(state.videoTracks, trackId, defaultVideoTrack.id)
        const additions: MergeQueueItem[] = []
        for (const video of videos) {
          const normalized = normalizePath(video.path)
          if (!normalized) continue
          additions.push(createVideoItem(video.path, video.name || fileName(video.path), targetTrackId))
        }
        if (additions.length > 0) {
          set((current) => commitHistory(current, { items: [...current.items, ...additions] }))
        }
        return additions.length
      },
      removeVideo: (id) => set((state) => commitHistory(state, {
        items: state.items.filter((item) => item.id !== id),
        audioItems: state.audioItems.filter((item) => item.sourceClipId !== id),
      })),
      duplicateVideo: (id) => {
        const source = get().items.find((item) => item.id === id)
        if (!source) return null
        const duplicateId = createId('clip')
        set((state) => {
          const index = state.items.findIndex((item) => item.id === id)
          if (index < 0) return state
          const duplicate: MergeQueueItem = {
            ...state.items[index],
            id: duplicateId,
            name: `${baseClipName(state.items[index].name)} · 副本`,
          }
          const items = [...state.items]
          items.splice(index + 1, 0, duplicate)
          return commitHistory(state, { items })
        })
        return duplicateId
      },
      moveVideo: (id, direction) => set((state) => {
        const index = state.items.findIndex((item) => item.id === id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= state.items.length) return state
        const items = [...state.items]
        ;[items[index], items[target]] = [items[target], items[index]]
        return commitHistory(state, { items })
      }),
      moveVideoTo: (id, startTime, trackId, recordHistory = true) => set((state) => {
        if (!state.videoTracks.some((track) => track.id === trackId)) return state
        const items = state.items.map((item) => item.id === id
          ? { ...item, startTime: Math.max(0, startTime), trackId }
          : item)
        return recordHistory ? commitHistory(state, { items }) : { items }
      }),
      updateVideo: (id, patch, recordHistory = true) => set((state) => {
        const items = state.items.map((item) => item.id === id ? normalizeVideoItem({ ...item, ...patch }, state.videoTracks) : item)
        return recordHistory ? commitHistory(state, { items }) : { items }
      }),
      splitVideo: (id, sourceTime, timelineTime) => {
        const item = get().items.find((candidate) => candidate.id === id)
        if (!item) return null
        const splitAt = Math.max(item.trimStart + 0.05, sourceTime)
        if (item.trimEnd > item.trimStart && splitAt >= item.trimEnd - 0.05) return null
        const rightId = createId('clip')
        set((state) => {
          const index = state.items.findIndex((candidate) => candidate.id === id)
          if (index < 0) return state
          const clipStart = Math.max(0, timelineTime - (splitAt - state.items[index].trimStart))
          const left = { ...state.items[index], startTime: clipStart, trimEnd: splitAt }
          const right: MergeQueueItem = {
            ...state.items[index],
            id: rightId,
            name: `${baseClipName(state.items[index].name)} · 片段`,
            startTime: Math.max(0, timelineTime),
            trimStart: splitAt,
          }
          const items = [...state.items]
          items.splice(index, 1, left, right)
          return commitHistory(state, { items })
        })
        return rightId
      },
      clearVideos: () => set((state) => commitHistory(state, { items: [], audioItems: [] })),
      addAudio: (audio) => {
        const id = createId('audio')
        const trackId = validTrackId(get().audioTracks, audio.trackId, defaultAudioTrack.id)
        set((state) => commitHistory(state, {
          audioItems: [...state.audioItems, normalizeAudioItem({ ...audio, id, trackId }, state.audioTracks)],
        }))
        return id
      },
      addAudioFiles: (paths, startTime = 0, trackId) => {
        const state = get()
        const targetTrackId = validTrackId(state.audioTracks, trackId, defaultAudioTrack.id)
        const existing = new Set(
          state.audioItems
            .filter((item) => item.sourceType === 'external')
            .map((item) => normalizePath(item.path)),
        )
        const additions: MergeAudioItem[] = []
        for (const path of paths) {
          const normalized = normalizePath(path)
          if (!normalized || existing.has(normalized)) continue
          existing.add(normalized)
          additions.push(normalizeAudioItem({
            id: createId('audio'),
            path,
            name: fileName(path),
            trackId: targetTrackId,
            startTime,
            trimStart: 0,
            trimEnd: 0,
            sourceType: 'external',
          }, state.audioTracks))
        }
        if (additions.length > 0) {
          set((current) => commitHistory(current, { audioItems: [...current.audioItems, ...additions] }))
        }
        return additions.length
      },
      updateAudio: (id, patch, recordHistory = true) => set((state) => {
        const audioItems = state.audioItems.map((item) => item.id === id
          ? normalizeAudioItem({ ...item, ...patch }, state.audioTracks)
          : item)
        return recordHistory ? commitHistory(state, { audioItems }) : { audioItems }
      }),
      removeAudio: (id) => set((state) => commitHistory(state, {
        audioItems: state.audioItems.filter((item) => item.id !== id),
      })),
      clearAudio: () => set((state) => commitHistory(state, { audioItems: [] })),
      setSettings: (patch, recordHistory = true) => set((state) => {
        const settings = normalizeSettings({ ...state.settings, ...patch })
        return recordHistory ? commitHistory(state, { settings }) : { settings }
      }),
      beginHistoryTransaction: () => set((state) => state.historyTransaction
        ? state
        : { historyTransaction: createSnapshot(state) }),
      endHistoryTransaction: () => set((state) => {
        const transaction = state.historyTransaction
        if (!transaction) return state
        if (sameSnapshot(transaction, createSnapshot(state))) return { historyTransaction: null }
        const undoStack = [...state.undoStack, transaction].slice(-historyLimit)
        return {
          historyTransaction: null,
          undoStack,
          redoStack: [],
          canUndo: undoStack.length > 0,
          canRedo: false,
        }
      }),
      undo: () => set((state) => {
        const snapshot = state.undoStack.at(-1)
        if (!snapshot) return state
        const redoStack = [...state.redoStack, createSnapshot(state)].slice(-historyLimit)
        const undoStack = state.undoStack.slice(0, -1)
        return {
          ...cloneSnapshot(snapshot),
          undoStack,
          redoStack,
          historyTransaction: null,
          canUndo: undoStack.length > 0,
          canRedo: true,
        }
      }),
      redo: () => set((state) => {
        const snapshot = state.redoStack.at(-1)
        if (!snapshot) return state
        const undoStack = [...state.undoStack, createSnapshot(state)].slice(-historyLimit)
        const redoStack = state.redoStack.slice(0, -1)
        return {
          ...cloneSnapshot(snapshot),
          undoStack,
          redoStack,
          historyTransaction: null,
          canUndo: true,
          canRedo: redoStack.length > 0,
        }
      }),
      setRunning: (running) => set({
        running,
        progress: running ? 0 : get().progress,
        error: running ? '' : get().error,
        outputPaths: running ? [] : get().outputPaths,
      }),
      setProgress: (progress, stage) => set({
        progress: Math.max(0, Math.min(100, progress)),
        stage,
      }),
      appendLog: (log) => set((state) => ({ logs: [...state.logs, log].slice(-1000) })),
      clearLogs: () => set({ logs: [] }),
      setError: (error) => set({ error }),
      setOutputPaths: (outputPaths) => set({ outputPaths }),
    }),
    {
      name: 'video-similarity-merge:v2',
      partialize: (state) => ({
        items: state.items,
        audioItems: state.audioItems,
        videoTracks: state.videoTracks,
        audioTracks: state.audioTracks,
        settings: state.settings,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<MergeState> | undefined
        const videoTracks = normalizeTracks(saved?.videoTracks, defaultVideoTrack, '视频线')
        const audioTracks = normalizeTracks(saved?.audioTracks, defaultAudioTrack, '音频线')
        return {
          ...current,
          ...saved,
          videoTracks,
          audioTracks,
          items: (saved?.items ?? []).map((item) => normalizeVideoItem(item, videoTracks)),
          audioItems: (saved?.audioItems ?? []).map((item) => normalizeAudioItem(item, audioTracks)),
          settings: normalizeSettings(saved?.settings),
          running: false,
          progress: 0,
          stage: '等待开始',
          logs: [],
          error: '',
          outputPaths: [],
          canUndo: false,
          canRedo: false,
          undoStack: [],
          redoStack: [],
          historyTransaction: null,
        }
      },
    },
  ),
)

function commitHistory(
  state: MergeState,
  patch: Partial<Pick<MergeState, 'items' | 'audioItems' | 'videoTracks' | 'audioTracks' | 'settings'>>,
) {
  if (state.historyTransaction) return patch
  const undoStack = [...state.undoStack, createSnapshot(state)].slice(-historyLimit)
  return {
    ...patch,
    undoStack,
    redoStack: [],
    canUndo: true,
    canRedo: false,
  }
}

function createSnapshot(
  state: Pick<MergeState, 'items' | 'audioItems' | 'videoTracks' | 'audioTracks' | 'settings'>,
): MergeHistorySnapshot {
  return {
    items: state.items.map((item) => ({ ...item })),
    audioItems: state.audioItems.map((item) => ({ ...item })),
    videoTracks: state.videoTracks.map((track) => ({ ...track })),
    audioTracks: state.audioTracks.map((track) => ({ ...track })),
    settings: { ...state.settings },
  }
}

function cloneSnapshot(snapshot: MergeHistorySnapshot): MergeHistorySnapshot {
  return {
    items: snapshot.items.map((item) => ({ ...item })),
    audioItems: snapshot.audioItems.map((item) => ({ ...item })),
    videoTracks: snapshot.videoTracks.map((track) => ({ ...track })),
    audioTracks: snapshot.audioTracks.map((track) => ({ ...track })),
    settings: { ...snapshot.settings },
  }
}

function sameSnapshot(left: MergeHistorySnapshot, right: MergeHistorySnapshot) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function createVideoItem(path: string, name: string, trackId: string): MergeQueueItem {
  return {
    id: createId('clip'),
    path,
    name,
    trackId,
    startTime: null,
    trimStart: 0,
    trimEnd: 0,
    muted: false,
    rotation: 0,
    cropEnabled: false,
    cropX: 0,
    cropY: 0,
    cropWidth: 0,
    cropHeight: 0,
    layoutCustom: false,
    layoutX: 0,
    layoutY: 0,
    layoutWidth: 1,
    layoutHeight: 1,
  }
}

function normalizeVideoItem(
  item: Partial<MergeQueueItem> & Pick<MergeQueueItem, 'path' | 'name'>,
  tracks: MergeTrack[],
): MergeQueueItem {
  const trackId = validTrackId(tracks, item.trackId, tracks[0]?.id ?? defaultVideoTrack.id)
  const startTime = item.startTime === null || item.startTime === undefined
    ? null
    : Math.max(0, Number(item.startTime) || 0)
  return {
    ...createVideoItem(item.path, item.name, trackId),
    ...item,
    id: item.id && item.id.includes('-') ? item.id : createId('clip'),
    trackId,
    startTime,
    trimStart: Math.max(0, Number(item.trimStart) || 0),
    trimEnd: Math.max(0, Number(item.trimEnd) || 0),
    muted: Boolean(item.muted),
    rotation: normalizeRotation(item.rotation),
    cropEnabled: Boolean(item.cropEnabled),
    cropX: Math.max(0, Number(item.cropX) || 0),
    cropY: Math.max(0, Number(item.cropY) || 0),
    cropWidth: Math.max(0, Number(item.cropWidth) || 0),
    cropHeight: Math.max(0, Number(item.cropHeight) || 0),
    layoutCustom: Boolean(item.layoutCustom),
    layoutX: clamp01(Number(item.layoutX) || 0),
    layoutY: clamp01(Number(item.layoutY) || 0),
    layoutWidth: clamp01(Number(item.layoutWidth) || 1),
    layoutHeight: clamp01(Number(item.layoutHeight) || 1),
  }
}

function normalizeAudioItem<T extends Partial<MergeAudioItem> & Pick<MergeAudioItem, 'path' | 'name'>>(
  item: T,
  tracks: MergeTrack[],
): MergeAudioItem {
  return {
    id: item.id && item.id.includes('-') ? item.id : createId('audio'),
    path: item.path,
    name: item.name,
    trackId: validTrackId(tracks, item.trackId, tracks[0]?.id ?? defaultAudioTrack.id),
    startTime: Math.max(0, Number(item.startTime) || 0),
    trimStart: Math.max(0, Number(item.trimStart) || 0),
    trimEnd: Math.max(0, Number(item.trimEnd) || 0),
    sourceType: item.sourceType === 'video' ? 'video' : 'external',
    sourceClipId: item.sourceClipId,
  }
}

function normalizeSettings(settings?: Partial<MergeSettings>): MergeSettings {
  return {
    ...defaultSettings,
    ...settings,
    width: Math.max(2, Number(settings?.width) || defaultSettings.width),
    height: Math.max(2, Number(settings?.height) || defaultSettings.height),
    canvasBackground: settings?.canvasBackground === 'white' ? 'white' : 'black',
  }
}

function normalizeTracks(
  tracks: MergeTrack[] | undefined,
  fallback: MergeTrack,
  prefix: string,
) {
  const normalized = (tracks ?? [])
    .filter((track) => track?.id)
    .map((track, index) => ({
      id: track.id,
      name: track.name || `${prefix} ${index + 1}`,
    }))
  return normalized.length > 0 ? normalized : [{ ...fallback }]
}

function validTrackId(tracks: MergeTrack[], requested: string | undefined, fallback: string) {
  return tracks.some((track) => track.id === requested) ? requested as string : tracks[0]?.id ?? fallback
}

function normalizeRotation(rotation?: number): MergeRotation {
  const normalized = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized
  return 0
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function baseClipName(name: string) {
  return name.replace(/\s*·\s*(?:片段|副本)(?:\s*\d+)?$/, '')
}

function normalizePath(path: string) {
  return path.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
