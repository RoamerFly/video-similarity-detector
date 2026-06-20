import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AnalysisLog } from '@/stores/analysisStore'

export type MergeFitMode = 'contain' | 'cover' | 'stretch'
export type MergeSplitMode = 'none' | 'duration' | 'count'
export type MergeRotation = 0 | 90 | 180 | 270

export interface MergeQueueItem {
  id: string
  path: string
  name: string
  trimStart: number
  trimEnd: number
  muted: boolean
  rotation: MergeRotation
  cropEnabled: boolean
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
}

export interface MergeAudioItem {
  id: string
  path: string
  name: string
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
  splitMode: MergeSplitMode
  splitValue: number
  fps: number
  crf: number
  encoderPreset: string
  includeAudio: boolean
}

type MergeVideoPatch = Partial<Pick<
  MergeQueueItem,
  | 'trimStart'
  | 'trimEnd'
  | 'muted'
  | 'rotation'
  | 'cropEnabled'
  | 'cropX'
  | 'cropY'
  | 'cropWidth'
  | 'cropHeight'
>>

interface MergeHistorySnapshot {
  items: MergeQueueItem[]
  audioItems: MergeAudioItem[]
  settings: MergeSettings
}

interface MergeState {
  items: MergeQueueItem[]
  audioItems: MergeAudioItem[]
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
  addVideo: (path: string, name?: string) => boolean
  addVideos: (videos: Array<{ path: string; name?: string }>) => number
  removeVideo: (id: string) => void
  duplicateVideo: (id: string) => string | null
  moveVideo: (id: string, direction: -1 | 1) => void
  moveVideoTo: (id: string, targetId: string) => void
  updateVideo: (id: string, patch: MergeVideoPatch, recordHistory?: boolean) => void
  splitVideo: (id: string, sourceTime: number) => string | null
  clearVideos: () => void
  addAudio: (audio: Omit<MergeAudioItem, 'id'>) => string
  addAudioFiles: (paths: string[], startTime?: number) => number
  updateAudio: (
    id: string,
    patch: Partial<Pick<MergeAudioItem, 'startTime' | 'trimStart' | 'trimEnd'>>,
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

const defaultSettings: MergeSettings = {
  outputDir: 'data/merged',
  outputName: 'merged_video',
  width: 1920,
  height: 1080,
  fitMode: 'contain',
  splitMode: 'none',
  splitValue: 600,
  fps: 30,
  crf: 23,
  encoderPreset: 'medium',
  includeAudio: true,
}

const historyLimit = 100

export const useMergeStore = create<MergeState>()(
  persist(
    (set, get) => ({
      items: [],
      audioItems: [],
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
      addVideo: (path, name) => {
        const normalized = normalizePath(path)
        if (!normalized || get().items.some((item) => normalizePath(item.path) === normalized && item.trimStart === 0 && item.trimEnd === 0)) {
          return false
        }
        set((state) => commitHistory(state, {
          items: [...state.items, createVideoItem(path, name || fileName(path))],
        }))
        return true
      },
      addVideos: (videos) => {
        const existing = new Set(
          get().items
            .filter((item) => item.trimStart === 0 && item.trimEnd === 0)
            .map((item) => normalizePath(item.path)),
        )
        const additions: MergeQueueItem[] = []
        for (const video of videos) {
          const normalized = normalizePath(video.path)
          if (!normalized || existing.has(normalized)) continue
          existing.add(normalized)
          additions.push(createVideoItem(video.path, video.name || fileName(video.path)))
        }
        if (additions.length > 0) {
          set((state) => commitHistory(state, { items: [...state.items, ...additions] }))
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
      moveVideoTo: (id, targetId) => set((state) => {
        const sourceIndex = state.items.findIndex((item) => item.id === id)
        const targetIndex = state.items.findIndex((item) => item.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return state
        const items = [...state.items]
        const [moved] = items.splice(sourceIndex, 1)
        items.splice(targetIndex, 0, moved)
        return commitHistory(state, { items })
      }),
      updateVideo: (id, patch, recordHistory = true) => set((state) => {
        const items = state.items.map((item) => item.id === id ? { ...item, ...patch } : item)
        return recordHistory ? commitHistory(state, { items }) : { items }
      }),
      splitVideo: (id, sourceTime) => {
        const item = get().items.find((candidate) => candidate.id === id)
        if (!item) return null
        const splitAt = Math.max(item.trimStart + 0.05, sourceTime)
        if (item.trimEnd > item.trimStart && splitAt >= item.trimEnd - 0.05) return null
        const rightId = createId('clip')
        set((state) => {
          const index = state.items.findIndex((candidate) => candidate.id === id)
          if (index < 0) return state
          const left = { ...state.items[index], trimEnd: splitAt }
          const right: MergeQueueItem = {
            ...state.items[index],
            id: rightId,
            name: `${baseClipName(state.items[index].name)} · 片段`,
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
        set((state) => commitHistory(state, {
          audioItems: [...state.audioItems, normalizeAudioItem({ ...audio, id })],
        }))
        return id
      },
      addAudioFiles: (paths, startTime = 0) => {
        const existing = new Set(
          get().audioItems
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
            startTime,
            trimStart: 0,
            trimEnd: 0,
            sourceType: 'external',
          }))
        }
        if (additions.length > 0) {
          set((state) => commitHistory(state, { audioItems: [...state.audioItems, ...additions] }))
        }
        return additions.length
      },
      updateAudio: (id, patch, recordHistory = true) => set((state) => {
        const audioItems = state.audioItems.map((item) => item.id === id ? { ...item, ...patch } : item)
        return recordHistory ? commitHistory(state, { audioItems }) : { audioItems }
      }),
      removeAudio: (id) => set((state) => commitHistory(state, {
        audioItems: state.audioItems.filter((item) => item.id !== id),
      })),
      clearAudio: () => set((state) => commitHistory(state, { audioItems: [] })),
      setSettings: (patch, recordHistory = true) => set((state) => {
        const settings = { ...state.settings, ...patch }
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
        settings: state.settings,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<MergeState> | undefined
        return {
          ...current,
          ...saved,
          items: (saved?.items ?? []).map((item) => normalizeVideoItem(item)),
          audioItems: (saved?.audioItems ?? []).map(normalizeAudioItem),
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
  patch: Partial<Pick<MergeState, 'items' | 'audioItems' | 'settings'>>,
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

function createSnapshot(state: Pick<MergeState, 'items' | 'audioItems' | 'settings'>): MergeHistorySnapshot {
  return {
    items: state.items.map((item) => ({ ...item })),
    audioItems: state.audioItems.map((item) => ({ ...item })),
    settings: { ...state.settings },
  }
}

function cloneSnapshot(snapshot: MergeHistorySnapshot): MergeHistorySnapshot {
  return {
    items: snapshot.items.map((item) => ({ ...item })),
    audioItems: snapshot.audioItems.map((item) => ({ ...item })),
    settings: { ...snapshot.settings },
  }
}

function sameSnapshot(left: MergeHistorySnapshot, right: MergeHistorySnapshot) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function createVideoItem(path: string, name: string): MergeQueueItem {
  return {
    id: createId('clip'),
    path,
    name,
    trimStart: 0,
    trimEnd: 0,
    muted: false,
    rotation: 0,
    cropEnabled: false,
    cropX: 0,
    cropY: 0,
    cropWidth: 0,
    cropHeight: 0,
  }
}

function normalizeVideoItem(item: Partial<MergeQueueItem> & Pick<MergeQueueItem, 'path' | 'name'>): MergeQueueItem {
  return {
    ...createVideoItem(item.path, item.name),
    ...item,
    id: item.id && item.id.includes('-') ? item.id : createId('clip'),
    muted: Boolean(item.muted),
    rotation: normalizeRotation(item.rotation),
    cropEnabled: Boolean(item.cropEnabled),
    cropX: Math.max(0, Number(item.cropX) || 0),
    cropY: Math.max(0, Number(item.cropY) || 0),
    cropWidth: Math.max(0, Number(item.cropWidth) || 0),
    cropHeight: Math.max(0, Number(item.cropHeight) || 0),
  }
}

function normalizeAudioItem<T extends MergeAudioItem>(item: T): T {
  return {
    ...item,
    startTime: Math.max(0, Number(item.startTime) || 0),
    trimStart: Math.max(0, Number(item.trimStart) || 0),
    trimEnd: Math.max(0, Number(item.trimEnd) || 0),
  }
}

function normalizeSettings(settings?: Partial<MergeSettings>): MergeSettings {
  return {
    ...defaultSettings,
    ...settings,
    width: Math.max(2, Number(settings?.width) || defaultSettings.width),
    height: Math.max(2, Number(settings?.height) || defaultSettings.height),
  }
}

function normalizeRotation(rotation?: number): MergeRotation {
  const normalized = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized
  return 0
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
