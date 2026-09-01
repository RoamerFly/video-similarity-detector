import { create } from 'zustand'
import type { VideoFile } from '@/services/backend'
import type { RunBatchCompareConfig } from '@/services/backend'
import type { AnalysisConfig } from '@/types/config'
import { defaultSettings } from '@/types/config'
import type { BatchReport, ReportPair, ReportSummaryStats } from '@/utils/reportParser'

export type RunningStatus = 'idle' | 'running' | 'paused' | 'success' | 'error' | 'cancelled'

export interface AnalysisLog {
  stream: 'stdout' | 'stderr'
  line: string
  timestamp: number
}

export interface ReportPaths {
  reportJson: string
  reportCsv: string
  reportHtml: string
}

interface AnalysisState {
  analysisConfig: AnalysisConfig
  runningStatus: RunningStatus
  pausePending: boolean
  progress: number
  stage: string
  subProgress: number | null
  subStage: string
  scannedVideos: VideoFile[]
  scannedDir: string
  scanMessage: string
  logs: AnalysisLog[]
  totalLogCount: number
  logsDropped: number
  runStartedAt: number | null
  runFinishedAt: number | null
  reportPaths: ReportPaths | null
  resultSummary: ReportSummaryStats | null
  selectedPair: ReportPair | null
  report: BatchReport | null
  errorMessage: string
  activeTaskId: string
  activeRunId: string | null
  activeTaskConfig: RunBatchCompareConfig | null
  selectedVideoPaths: Set<string>
  videoMultiSelect: boolean
  isScanning: boolean
  activeSubpage: 'analysis' | 'history'
  setAnalysisConfig: (config: Partial<AnalysisConfig>) => void
  setRunningStatus: (status: RunningStatus) => void
  setPausePending: (pending: boolean, progress?: number, stage?: string) => void
  setProgress: (progress: number, stage?: string, subTask?: { subProgress?: number | null; subStage?: string | null }) => void
  setScannedVideos: (videos: VideoFile[], scannedDir: string) => void
  quarantineScannedVideo: (originalPath: string, destinationPath: string, moved: boolean) => void
  setScanMessage: (message: string) => void
  appendLog: (log: AnalysisLog) => void
  clearLogs: () => void
  setReportPaths: (paths: ReportPaths | null) => void
  setResultSummary: (summary: ReportSummaryStats | null) => void
  setSelectedPair: (pair: ReportPair | null) => void
  setReport: (report: BatchReport | null) => void
  setErrorMessage: (message: string) => void
  setActiveTaskId: (taskId: string) => void
  setActiveRunId: (runId: string | null) => void
  setActiveTaskConfig: (config: RunBatchCompareConfig | null) => void
  setSelectedVideoPaths: (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  setVideoMultiSelect: (enabled: boolean) => void
  setIsScanning: (scanning: boolean) => void
  setActiveSubpage: (subpage: 'analysis' | 'history') => void
  renameScannedVideo: (oldPath: string, newPath: string) => void
  resetRunState: () => void
}

const maxRetainedLogs = 5000
const logFlushIntervalMs = 300

// 日志批量合并：指纹判重与相似度分析都会逐视频打印日志，若每条日志都触发一次
// set()，前端会高频整页重渲染，导致任务执行期间卡顿、无法切换页面。这里把
// logFlushIntervalMs 内的日志攒成一批，统一刷入 store，收敛为低频状态更新。
let pendingLogs: AnalysisLog[] = []
let pendingLogsTotal = 0
let logFlushTimer: ReturnType<typeof setTimeout> | null = null

function cancelLogFlush() {
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer)
    logFlushTimer = null
  }
}

function flushPendingLogs() {
  logFlushTimer = null
  if (pendingLogs.length === 0) return
  const batch = pendingLogs
  const batchTotal = pendingLogsTotal
  pendingLogs = []
  pendingLogsTotal = 0
  useAnalysisStore.setState((state) => {
    const totalLogCount = state.totalLogCount + batchTotal
    const logs = [...state.logs, ...batch].slice(-maxRetainedLogs)
    return {
      logs,
      totalLogCount,
      logsDropped: Math.max(0, totalLogCount - logs.length),
    }
  })
}

function scheduleLogFlush() {
  if (logFlushTimer !== null) return
  logFlushTimer = setTimeout(flushPendingLogs, logFlushIntervalMs)
}

const initialAnalysisConfig: AnalysisConfig = {
  videoDir: defaultSettings.videoDir,
  outputDir: defaultSettings.reportDir,
  skipThreshold: defaultSettings.defaultSkipThreshold,
  matchThreshold: defaultSettings.defaultMatchThreshold,
  windowSize: defaultSettings.defaultWindowSize,
  topK: defaultSettings.defaultTopK,
  candidateLimit: defaultSettings.defaultCandidateLimit,
  compareWorkers: defaultSettings.defaultCompareWorkers,
  maxGapSec: defaultSettings.defaultMaxGapSec,
  frameStep: defaultSettings.defaultFrameStep,
  minSegmentDuration: defaultSettings.defaultMinSegmentDuration,
  minSegmentMatches: defaultSettings.defaultMinSegmentMatches,
  offsetTolerance: defaultSettings.defaultOffsetTolerance,
  cropBlackBorders: defaultSettings.defaultCropBlackBorders,
  resizeMode: defaultSettings.defaultResizeMode,
  inputSize: defaultSettings.defaultInputSize,
  portraitRotation: defaultSettings.defaultPortraitRotation,
  force: defaultSettings.defaultForce,
  earlyStop: defaultSettings.defaultEarlyStop,
  errorTolerancePreset: defaultSettings.errorTolerancePreset,
  errorToleranceSevereLimit: defaultSettings.errorToleranceSevereLimit,
  errorToleranceMissingPictureLimit: defaultSettings.errorToleranceMissingPictureLimit,
  errorTolerancePreflightValidation: defaultSettings.errorTolerancePreflightValidation,
  mode: defaultSettings.analysisMode,
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  analysisConfig: initialAnalysisConfig,
  runningStatus: 'idle',
  pausePending: false,
  progress: 0,
  stage: '尚未运行分析',
  subProgress: null,
  subStage: '',
  scannedVideos: [],
  scannedDir: '',
  scanMessage: '请先在设置页配置视频目录，然后扫描视频。',
  logs: [],
  totalLogCount: 0,
  logsDropped: 0,
  runStartedAt: null,
  runFinishedAt: null,
  reportPaths: null,
  resultSummary: null,
  selectedPair: null,
  report: null,
  errorMessage: '',
  activeTaskId: '',
  activeRunId: null,
  activeTaskConfig: null,
  selectedVideoPaths: new Set<string>(),
  videoMultiSelect: false,
  isScanning: false,
  activeSubpage: 'analysis',

  setAnalysisConfig: (config) =>
    set((state) => ({
      analysisConfig: { ...state.analysisConfig, ...config },
    })),
  setRunningStatus: (runningStatus) =>
    set((state) => {
      if (runningStatus === 'running') {
        return {
          runningStatus,
          runStartedAt: state.runningStatus === 'running' && state.runStartedAt ? state.runStartedAt : Date.now(),
          runFinishedAt: null,
        }
      }

      if (['paused', 'success', 'error', 'cancelled'].includes(runningStatus)) {
        return {
          runningStatus,
          pausePending: false,
          runFinishedAt: state.runStartedAt ? Date.now() : state.runFinishedAt,
        }
      }

      return { runningStatus }
    }),
  setPausePending: (pausePending, progress, stage = '正在暂停分析任务') =>
    set((state) => pausePending
      ? {
          pausePending: true,
          progress: progress === undefined ? state.progress : normalizeProgress(progress),
          stage,
          subProgress: null,
          subStage: '',
        }
      : { pausePending: false }),
  setProgress: (progress, stage, subTask) =>
    set((state) => {
      // cancel_current_task and the old Python worker can still emit progress
      // while the process tree is unwinding. Keep the value captured when the
      // user clicked pause until the shutdown boundary is confirmed.
      if (state.pausePending) return state
      const hasSubProgress = subTask ? Object.prototype.hasOwnProperty.call(subTask, 'subProgress') : false
      const hasSubStage = subTask ? Object.prototype.hasOwnProperty.call(subTask, 'subStage') : false
      return {
        progress: normalizeProgress(progress),
        stage: stage ?? state.stage,
        subProgress: hasSubProgress
          ? (subTask?.subProgress == null ? null : normalizeProgress(subTask.subProgress))
          : state.subProgress,
        subStage: hasSubStage ? (subTask?.subStage ?? '') : state.subStage,
      }
    }),
  setScannedVideos: (scannedVideos, scannedDir) =>
    set({
      scannedVideos,
      scannedDir,
    }),
  quarantineScannedVideo: (originalPath, destinationPath, moved) =>
    set((state) => {
      const normalizedOriginal = normalizeVideoPath(originalPath)
      const scannedVideos = state.scannedVideos.filter(
        (video) => normalizeVideoPath(video.path) !== normalizedOriginal,
      )
      const pairCount = Math.max(0, (scannedVideos.length * (scannedVideos.length - 1)) / 2)
      return {
        scannedVideos,
        scanMessage: moved
          ? `已将错误视频移至 ${destinationPath}；当前剩余 ${scannedVideos.length} 个视频，预计比较 ${pairCount} 对。`
          : `错误视频移动失败，但已移出本次比较列表；当前剩余 ${scannedVideos.length} 个视频，预计比较 ${pairCount} 对。`,
      }
    }),
  setScanMessage: (scanMessage) => set({ scanMessage }),
  appendLog: (log) => {
    pendingLogs.push(log)
    pendingLogsTotal += 1
    scheduleLogFlush()
  },
  clearLogs: () => {
    cancelLogFlush()
    pendingLogs = []
    pendingLogsTotal = 0
    set({ logs: [], totalLogCount: 0, logsDropped: 0 })
  },
  setReportPaths: (reportPaths) => set({ reportPaths }),
  setResultSummary: (resultSummary) => set({ resultSummary }),
  setSelectedPair: (selectedPair) => set({ selectedPair }),
  setReport: (report) => set({ report }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
  setActiveRunId: (activeRunId) => set({ activeRunId }),
  setActiveTaskConfig: (activeTaskConfig) => set({ activeTaskConfig }),
  setSelectedVideoPaths: (updater) =>
    set((state) => ({
      selectedVideoPaths:
        typeof updater === 'function' ? updater(state.selectedVideoPaths) : updater,
    })),
  setVideoMultiSelect: (videoMultiSelect) => set({ videoMultiSelect }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setActiveSubpage: (activeSubpage) => set({ activeSubpage }),
  renameScannedVideo: (oldPath, newPath) =>
    set((state) => {
      const normalizedOld = normalizeVideoPath(oldPath)
      const normalizedNew = normalizeVideoPath(newPath)
      const fileName = newPath.split(/[\\/]/).filter(Boolean).pop() ?? newPath
      const dotIndex = fileName.lastIndexOf('.')
      const extension = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
      const scannedVideos = state.scannedVideos.map((video) =>
        normalizeVideoPath(video.path) === normalizedOld
          ? { ...video, path: newPath, name: fileName, extension }
          : video,
      )
      let selectedVideoPaths = state.selectedVideoPaths
      if (selectedVideoPaths.has(normalizedOld)) {
        const next = new Set(selectedVideoPaths)
        next.delete(normalizedOld)
        next.add(normalizedNew)
        selectedVideoPaths = next
      }
      return { scannedVideos, selectedVideoPaths }
    }),
  resetRunState: () => {
    cancelLogFlush()
    pendingLogs = []
    pendingLogsTotal = 0
    set({
      runningStatus: 'idle',
      pausePending: false,
      progress: 0,
      stage: '尚未运行分析',
      subProgress: null,
      subStage: '',
      scannedVideos: [],
      scannedDir: '',
      scanMessage: '请先在设置页配置视频目录，然后扫描视频。',
      logs: [],
      totalLogCount: 0,
      logsDropped: 0,
      runStartedAt: null,
      runFinishedAt: null,
      reportPaths: null,
      resultSummary: null,
      selectedPair: null,
      report: null,
      errorMessage: '',
      activeTaskId: '',
      activeRunId: null,
      activeTaskConfig: null,
      selectedVideoPaths: new Set<string>(),
      videoMultiSelect: false,
      isScanning: false,
      activeSubpage: 'analysis',
    })
  },
}))

function normalizeProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.max(0, Math.min(100, progress)) * 100) / 100
}

function normalizeVideoPath(path: string) {
  return path.replaceAll('\\', '/').toLocaleLowerCase()
}
