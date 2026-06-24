import { create } from 'zustand'
import type { VideoFile } from '@/services/backend'
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
  setAnalysisConfig: (config: Partial<AnalysisConfig>) => void
  setRunningStatus: (status: RunningStatus) => void
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
  resetRunState: () => void
}

const maxRetainedLogs = 5000

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
  errorTolerancePreset: defaultSettings.errorTolerancePreset,
  errorToleranceSevereLimit: defaultSettings.errorToleranceSevereLimit,
  errorToleranceMissingPictureLimit: defaultSettings.errorToleranceMissingPictureLimit,
  errorTolerancePreflightValidation: defaultSettings.errorTolerancePreflightValidation,
  mode: defaultSettings.analysisMode,
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  analysisConfig: initialAnalysisConfig,
  runningStatus: 'idle',
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
          runFinishedAt: state.runStartedAt ? Date.now() : state.runFinishedAt,
        }
      }

      return { runningStatus }
    }),
  setProgress: (progress, stage, subTask) =>
    set((state) => {
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
  appendLog: (log) =>
    set((state) => {
      const totalLogCount = state.totalLogCount + 1
      const logs = [...state.logs, log].slice(-maxRetainedLogs)
      return {
        logs,
        totalLogCount,
        logsDropped: Math.max(0, totalLogCount - logs.length),
      }
    }),
  clearLogs: () => set({ logs: [], totalLogCount: 0, logsDropped: 0 }),
  setReportPaths: (reportPaths) => set({ reportPaths }),
  setResultSummary: (resultSummary) => set({ resultSummary }),
  setSelectedPair: (selectedPair) => set({ selectedPair }),
  setReport: (report) => set({ report }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
  resetRunState: () =>
    set({
      runningStatus: 'idle',
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
    }),
}))

function normalizeProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.max(0, Math.min(100, progress)) * 100) / 100
}

function normalizeVideoPath(path: string) {
  return path.replaceAll('\\', '/').toLocaleLowerCase()
}
