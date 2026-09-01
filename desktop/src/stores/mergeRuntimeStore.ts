import { create } from 'zustand'
import type { AnalysisLog } from '@/stores/analysisStore'

/**
 * Ephemeral state for the merge worker.
 *
 * This store is intentionally not wrapped in `persist`. Progress and log
 * output can update dozens of times per second; keeping it outside the
 * project store prevents every update from serializing the whole edit
 * project and writing it to localStorage.
 */
export interface MergeRuntimeState {
  running: boolean
  progress: number
  stage: string
  logs: AnalysisLog[]
  error: string
  outputPaths: string[]
  setRunning: (running: boolean) => void
  setProgress: (progress: number, stage: string) => void
  appendLog: (log: AnalysisLog) => void
  appendLogs: (logs: AnalysisLog[]) => void
  clearLogs: () => void
  setError: (error: string) => void
  setOutputPaths: (paths: string[]) => void
}

export const useMergeRuntimeStore = create<MergeRuntimeState>((set, get) => ({
  running: false,
  progress: 0,
  stage: '等待开始',
  logs: [],
  error: '',
  outputPaths: [],
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
  appendLogs: (logs) => set((state) => logs.length === 0
    ? state
    : { logs: [...state.logs, ...logs].slice(-1000) }),
  clearLogs: () => set({ logs: [] }),
  setError: (error) => set({ error }),
  setOutputPaths: (outputPaths) => set({ outputPaths }),
}))
