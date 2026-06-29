import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AnalysisConfig, CloseBehavior, SettingsSnapshot } from '@/types/config'

export interface AppInfo {
  projectRoot: string
  defaultVideoDir: string
  defaultCacheDir: string
  defaultOutputDir: string
  appName: string
  version: string
  buildFlavor: string
  installType: string
  installRoot: string
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
  assetName: string
  assetUrl: string
  assetSize: number
  buildFlavor: string
  installType: string
  installRoot: string
  canAutoInstall: boolean
  message: string
}

export interface UpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number
  progress: number
  stage: string
}

export interface ClipModelStatus {
  installed: boolean
  modelDir: string
  sizeBytes: number
  message: string
  requiredFiles: string[]
  missingFiles: string[]
}

export interface VideoFile {
  path: string
  name: string
  extension: string
  sizeBytes: number
  sizeMb: number
  modifiedAtMs: number
}

export interface VideoMetadata {
  path: string
  width: number
  height: number
  duration: number
  fps: number
  frameCount: number
  readable: boolean
  error: string
}

export interface VideoMergeItem {
  path: string
  startTime: number
  trackIndex: number
  trimStart?: number
  trimEnd?: number
  muted?: boolean
  rotation?: number
  cropEnabled?: boolean
  cropX?: number
  cropY?: number
  cropWidth?: number
  cropHeight?: number
  layoutCustom?: boolean
  layoutX?: number
  layoutY?: number
  layoutWidth?: number
  layoutHeight?: number
}

export interface VideoMergeAudioItem {
  path: string
  startTime: number
  trimStart?: number
  trimEnd?: number
}

export interface VideoMergeTextItem {
  text: string
  startTime: number
  duration: number
  x: number
  y: number
  fontSize: number
  color: string
  backgroundColor: string
}

export interface VideoMergeConfig {
  inputs: VideoMergeItem[]
  audioTracks: VideoMergeAudioItem[]
  textTracks: VideoMergeTextItem[]
  outputDir: string
  outputName: string
  width: number
  height: number
  fitMode: 'contain' | 'cover' | 'stretch'
  canvasBackground: 'black' | 'white'
  splitMode: 'none' | 'duration' | 'count'
  splitValue: number
  fps: number
  crf: number
  encoderPreset: string
  includeAudio: boolean
  snapToVideos: boolean
  projectRoot?: string
  pythonPath?: string
}

export interface MergeProgressPayload {
  progress: number
  stage: string
}

export interface MergeFinishedPayload {
  outputPaths: string[]
  message: string
}

export interface RunBatchCompareConfig {
  videoDir: string
  outputDir: string
  cacheDir: string
  pythonPath: string
  projectRoot: string
  skipThreshold: number
  matchThreshold: number
  windowSize: number
  topK: number
  candidateLimit: number
  compareWorkers: number
  maxGapSec: number
  frameStep: number
  cropBlackBorders: boolean
  resizeMode: string
  inputSize: number
  portraitRotation: string
  force: boolean
  earlyStop: boolean
  device: string
  errorTolerancePreset: string
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
  analysisMode?: string
  minSegmentDuration?: number
  minSegmentMatches?: number
  offsetTolerance?: number
  taskId?: string
  taskMatchKey?: string
  executionStage?: AnalysisTaskStageId
  redoStage?: boolean
  videoPaths?: string[]
}

export type ConfigTemplateKind = 'analysis' | 'error_tolerance'

export interface ConfigTemplateRecord<T = unknown> {
  id: string
  kind: ConfigTemplateKind
  name: string
  createdAt: string
  updatedAt: string
  config: T
}

export interface AnalysisTaskVideo {
  path: string
  size?: number | null
  mtimeMs?: number | null
}

export type AnalysisTaskStageId = 'scan' | 'cache' | 'features' | 'candidate' | 'compare' | 'report'

export interface AnalysisTaskStage {
  id: AnalysisTaskStageId
  label: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | string
  progress: number
  weight: number
  startedAt: string
  completedAt: string
  elapsedMs: number
  message: string
}

export interface AnalysisTaskCacheArtifact {
  path: string
  pathBase?: 'cacheDir' | 'projectRoot' | 'absolute' | string
  category: string
  description: string
  createdAt: string
}

export interface AnalysisTaskRecord {
  version: number
  id: string
  name: string
  status: 'created' | 'preparing' | 'running' | 'paused' | 'failed' | 'completed' | string
  createdAt: string
  updatedAt: string
  videoDir: string
  videoCount: number
  totalPairs: number
  completedPairs: number
  progress: number
  stage: string
  matchKey: string
  videos: AnalysisTaskVideo[]
  config: RunBatchCompareConfig
  reportJson: string
  reportCsv: string
  reportHtml: string
  activeStage: AnalysisTaskStageId | ''
  stages: AnalysisTaskStage[]
  cacheArtifacts: AnalysisTaskCacheArtifact[]
  reusedVideoCaches: number
  generatedVideoCaches: number
}

export interface DuplicateFileCheckConfig {
  videoDir: string
  outputDir: string
  projectRoot: string
  recursive?: boolean
  videoPaths?: string[]
}

export interface ReportPathsPayload {
  reportJson: string
  reportCsv: string
  reportHtml: string
}

export interface ReportSummary {
  id: string
  path: string
  jsonPath?: string
  csvPath?: string
  htmlPath?: string
  name: string
  createdAt: string
  modifiedAt: string
  sizeBytes: number
  videoCount: number
  pairCount: number
  warningCount: number
  status: string
  formats: string[]
}

export interface PythonEnvStatus {
  ok: boolean
  pythonVersion?: string
  resolvedPythonPath?: string
  message: string
  scriptsOk: boolean
  reportDirOk: boolean
  gpuAvailable?: boolean
  gpuMessage?: string
}

export interface PythonEnvConfig {
  pythonPath: string
  projectRoot: string
  reportDir: string
  quickCheck?: boolean
}

export interface AnalysisLogPayload {
  stream: 'stdout' | 'stderr'
  line: string
  timestamp: number
}

export interface AnalysisProgressPayload {
  stage: string
  progress: number
  subStage?: string | null
  subProgress?: number | null
}

export interface AnalysisStageFinishedPayload {
  taskId: string
  stageId: AnalysisTaskStageId
}

export interface AnalysisErrorPayload {
  message: string
}

export interface AnalysisVideoQuarantinedPayload {
  originalPath: string
  destinationPath: string
  remainingVideos: number
  removedVideos: number
  moved: boolean
}

export interface PathStatus {
  exists: boolean
  isFile: boolean
  normalizedPath: string
}

export interface ComparisonFrameOptions {
  cropBlackBorders: boolean
  resizeMode: string
  inputSize: number
  portraitRotation: string
}

export interface ClearCacheResult {
  removedEntries: number
  message: string
}

export interface CacheEntry {
  id: string
  path: string
  name: string
  kind: string
  category: string
  description: string
  sizeBytes: number
  entryCount: number
}

export interface CacheScanResult {
  cacheDir: string
  items: CacheEntry[]
  totalSizeBytes: number
  totalEntries: number
  message: string
}

export interface DeleteFilesResult {
  deletedPaths: string[]
  failed: Array<{ path: string; error: string }>
  message: string
}

export interface MoveFilesResult {
  movedPaths: Array<{ from: string; to: string }>
  failed: Array<{ path: string; error: string }>
  message: string
}

export interface FileMoveStatus {
  running: boolean
  cancelRequested: boolean
  targetDir: string
  currentPath: string | null
  pendingPaths: string[]
}

export interface ReportPairIdentity {
  videoA: string
  videoB: string
  videoAPath: string
  videoBPath: string
}

export interface UpdateReportEntriesResult {
  removedCount: number
  remainingCount: number
  updatedFiles: string[]
}

interface RuntimeWindow extends Window {
  __TAURI_INTERNALS__?: { invoke?: unknown }
}

export function hasTauriRuntime() {
  return typeof (window as RuntimeWindow).__TAURI_INTERNALS__?.invoke === 'function'
}

export function normalizeBackendError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  if (/plugin:event\|listen|event.*listen.*not allowed|not allowed by ACL/i.test(message)) {
    return '实时进度通道未获得授权，请使用更新后的打包版本并重启应用。'
  }
  if (/plugin:dialog|dialog.*not allowed|pick_file|pick_folder/i.test(message)) {
    return '文件选择权限未获得授权，请使用更新后的打包版本并重启应用。'
  }
  if (/plugin:shell|shell.*not allowed/i.test(message)) {
    return '系统打开文件权限未获得授权，请使用更新后的打包版本并重启应用。'
  }
  if (/command.*not found|unknown command/i.test(message)) {
    return '当前应用版本缺少所需后端命令，请重新打包后再运行。'
  }
  return message
}

export async function getAppInfo() {
  if (!hasTauriRuntime()) {
    return {
      projectRoot: '',
      defaultVideoDir: 'videos',
      defaultCacheDir: 'data',
      defaultOutputDir: 'data/reports',
      appName: 'video-similarity-desktop',
      version: '0.1.0',
      buildFlavor: 'cpu',
      installType: 'portable',
      installRoot: '',
    } satisfies AppInfo
  }
  return invoke<AppInfo>('get_app_info')
}

export async function checkForUpdates() {
  if (!hasTauriRuntime()) {
    return {
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/RoamerFly/video-similarity-detector/releases',
      releaseNotes: '',
      publishedAt: '',
      assetName: '',
      assetUrl: '',
      assetSize: 0,
      buildFlavor: 'cpu',
      installType: 'portable',
      installRoot: '',
      canAutoInstall: false,
      message: '浏览器预览模式不检查更新。',
    } satisfies UpdateInfo
  }
  return invoke<UpdateInfo>('check_for_updates')
}

export async function downloadAndInstallUpdate() {
  if (!hasTauriRuntime()) throw new Error('覆盖更新需要在桌面应用中运行。')
  return invoke<void>('download_and_install_update')
}

export async function cancelUpdateDownload() {
  if (!hasTauriRuntime()) return
  return invoke<void>('cancel_update_download')
}

export async function openReleasePage(url: string) {
  if (!hasTauriRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  return invoke<void>('open_release_page', { url })
}

export async function getClipModelStatus() {
  if (!hasTauriRuntime()) {
    return {
      installed: false,
      modelDir: 'models/clip-vit-base-patch32',
      sizeBytes: 0,
      message: '浏览器预览模式无法检测本地模型。',
      requiredFiles: ['config.json', 'preprocessor_config.json', 'pytorch_model.bin'],
      missingFiles: ['config.json', 'preprocessor_config.json', 'pytorch_model.bin'],
    } satisfies ClipModelStatus
  }
  return invoke<ClipModelStatus>('get_clip_model_status')
}

export async function installClipModel() {
  if (!hasTauriRuntime()) throw new Error('离线模型安装需要在桌面应用中运行。')
  return invoke<ClipModelStatus>('install_clip_model')
}

export async function selectVideoDirectory() {
  if (!hasTauriRuntime()) throw new Error('目录选择需要在 Tauri 应用中运行。')
  return invoke<string | null>('select_video_directory')
}

export async function selectVideoFiles() {
  if (!hasTauriRuntime()) throw new Error('视频选择需要在 Tauri 应用中运行。')
  return invoke<string[]>('select_video_files')
}

export async function selectAudioFiles() {
  if (!hasTauriRuntime()) throw new Error('音频选择需要在 Tauri 应用中运行。')
  return invoke<string[]>('select_audio_files')
}

export async function selectSubtitleFiles() {
  if (!hasTauriRuntime()) throw new Error('字幕选择需要在 Tauri 应用中运行。')
  return invoke<string[]>('select_subtitle_files')
}

export async function selectOutputDirectory() {
  if (!hasTauriRuntime()) throw new Error('目录选择需要在 Tauri 应用中运行。')
  return invoke<string | null>('select_output_directory')
}

export async function selectPythonExecutable() {
  if (!hasTauriRuntime()) throw new Error('Python 路径选择需要在 Tauri 应用中运行。')
  return invoke<string | null>('select_python_executable')
}

export async function scanVideos(inputDir: string, recursive = true) {
  if (!hasTauriRuntime()) return []
  return invoke<VideoFile[]>('scan_videos', {
    request: { inputDir, recursive },
  })
}

export async function listConfigTemplates<T>(
  kind: ConfigTemplateKind,
  projectRoot?: string,
) {
  if (!hasTauriRuntime()) return []
  return invoke<ConfigTemplateRecord<T>[]>('list_config_templates', {
    request: { kind, projectRoot },
  })
}

export async function saveConfigTemplate<T>(
  kind: ConfigTemplateKind,
  name: string,
  config: T,
  projectRoot?: string,
  id?: string,
) {
  if (!hasTauriRuntime()) throw new Error('配置模板需要在桌面应用中保存。')
  return invoke<ConfigTemplateRecord<T>>('save_config_template', {
    request: { kind, name, config, projectRoot, id },
  })
}

export async function deleteConfigTemplate(
  kind: ConfigTemplateKind,
  id: string,
  projectRoot?: string,
) {
  if (!hasTauriRuntime()) return
  return invoke<void>('delete_config_template', {
    request: { kind, id, projectRoot },
  })
}

export async function listAnalysisTasks(cacheDir: string, projectRoot?: string) {
  if (!hasTauriRuntime()) return []
  return invoke<AnalysisTaskRecord[]>('list_analysis_tasks', {
    request: { cacheDir, projectRoot },
  })
}

export async function createAnalysisTask(
  config: RunBatchCompareConfig,
  taskMatchKey: string,
  taskName?: string,
) {
  if (!hasTauriRuntime()) {
    const now = new Date().toISOString()
    const id = `analysis-${Date.now()}`
    return {
      version: 1,
      id,
      name: taskName?.trim() || id,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      videoDir: config.videoDir,
      videoCount: 0,
      totalPairs: 0,
      completedPairs: 0,
      progress: 0,
      stage: '等待启动',
      matchKey: taskMatchKey,
      videos: [],
      config,
      reportJson: '',
      reportCsv: '',
      reportHtml: '',
      activeStage: '',
      stages: [],
      cacheArtifacts: [],
      reusedVideoCaches: 0,
      generatedVideoCaches: 0,
    } satisfies AnalysisTaskRecord
  }
  return invoke<AnalysisTaskRecord>('create_analysis_task', {
    request: {
      cacheDir: config.cacheDir,
      projectRoot: config.projectRoot,
      config,
      taskMatchKey,
      taskName: taskName?.trim() || undefined,
    },
  })
}

export async function updateAnalysisTask(
  taskId: string,
  cacheDir: string,
  projectRoot: string | undefined,
  patch: {
    status?: string
    stage?: string
    progress?: number
    totalPairs?: number
    completedPairs?: number
    videos?: VideoFile[]
    reportJson?: string
    reportCsv?: string
    reportHtml?: string
  },
) {
  if (!hasTauriRuntime()) return
  return invoke<AnalysisTaskRecord>('update_analysis_task', {
    request: {
      taskId,
      cacheDir,
      projectRoot,
      ...patch,
      videos: patch.videos?.map((video) => ({
        path: video.path,
        size: video.sizeBytes,
        mtimeMs: video.modifiedAtMs,
      })),
    },
  })
}

export async function deleteAnalysisTask(taskId: string, cacheDir: string, projectRoot?: string, deleteCache = false) {
  if (!hasTauriRuntime()) return
  return invoke<void>('delete_analysis_task', {
    request: { taskId, cacheDir, projectRoot, deleteCache },
  })
}

export async function scanAnalysisTaskCache(taskId: string, cacheDir: string, projectRoot?: string) {
  if (!hasTauriRuntime()) {
    return {
      cacheDir,
      items: [],
      totalSizeBytes: 0,
      totalEntries: 0,
      message: '任务缓存检查需要在 Tauri 应用中运行。',
    } satisfies CacheScanResult
  }
  return invoke<CacheScanResult>('scan_analysis_task_cache', {
    request: { taskId, cacheDir, projectRoot },
  })
}

export async function probeVideoMetadata(paths: string[], projectRoot?: string, pythonPath?: string) {
  if (!hasTauriRuntime()) return []
  return invoke<VideoMetadata[]>('probe_video_metadata', {
    request: { paths, projectRoot, pythonPath },
  })
}

export async function runVideoMerge(config: VideoMergeConfig) {
  if (!hasTauriRuntime()) throw new Error('视频合并需要在 Tauri 应用中运行。')
  return invoke<string>('run_video_merge', { config })
}

export async function cancelVideoMerge() {
  if (!hasTauriRuntime()) return
  return invoke<void>('cancel_video_merge')
}

export async function checkPythonEnv(config: PythonEnvConfig) {
  if (!hasTauriRuntime()) throw new Error('环境检测需要在 Tauri 应用中运行。')
  return invoke<PythonEnvStatus>('check_python_env', { config })
}

export async function runBatchCompare(config: RunBatchCompareConfig) {
  if (!hasTauriRuntime()) throw new Error('当前环境不可用：需要在 Tauri 应用中运行分析。')
  return invoke<ReportPathsPayload>('run_batch_compare', { config })
}

export function buildAnalysisTaskMatchKey(config: RunBatchCompareConfig) {
  return JSON.stringify({
    version: 1,
    videoDir: normalizeTaskPath(config.videoDir),
    skipThreshold: config.skipThreshold,
    matchThreshold: config.matchThreshold,
    windowSize: config.windowSize,
    topK: config.topK,
    candidateLimit: config.candidateLimit,
    compareWorkers: config.compareWorkers,
    maxGapSec: config.maxGapSec,
    frameStep: config.frameStep,
    cropBlackBorders: config.cropBlackBorders,
    resizeMode: config.resizeMode,
    inputSize: config.inputSize,
    portraitRotation: config.portraitRotation,
    force: config.force,
    earlyStop: config.earlyStop ?? true,
    device: config.device,
    errorTolerancePreset: config.errorTolerancePreset,
    errorToleranceSevereLimit: config.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: config.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: config.errorTolerancePreflightValidation,
    analysisMode: config.analysisMode,
    minSegmentDuration: config.minSegmentDuration,
    minSegmentMatches: config.minSegmentMatches,
    offsetTolerance: config.offsetTolerance,
    videoPaths: (config.videoPaths || []).map(normalizeTaskPath),
  })
}

export function analysisTaskMatchesVideos(task: AnalysisTaskRecord, videos: VideoFile[]) {
  if (task.videoCount !== videos.length || task.videos.length !== videos.length) return false
  const expected = new Map(
    task.videos.map((video) => [
      normalizeTaskPath(video.path),
      `${video.size ?? ''}:${video.mtimeMs ?? ''}`,
    ]),
  )
  return videos.every((video) => (
    expected.get(normalizeTaskPath(video.path))
    === `${video.sizeBytes}:${video.modifiedAtMs || ''}`
  ))
}

export async function runDuplicateFileCheck(config: DuplicateFileCheckConfig) {
  if (!hasTauriRuntime()) throw new Error('当前环境不可用：需要在 Tauri 应用中运行相同文件检查。')
  return invoke<ReportPathsPayload>('run_duplicate_file_check', { config })
}

export async function cancelCurrentTask() {
  if (!hasTauriRuntime()) return
  return invoke<void>('cancel_current_task')
}

export async function listReports(outputDir: string, refresh = false) {
  if (!hasTauriRuntime()) return []
  return invoke<ReportSummary[]>('list_reports', {
    request: { outputDir, refresh },
  })
}

export async function readReport(path: string) {
  if (!hasTauriRuntime()) throw new Error('当前环境不可用：需要在 Tauri 应用中读取报告。')
  return invoke<unknown>('read_report', {
    request: { path },
  })
}

export async function readTextFile(path: string) {
  if (!hasTauriRuntime()) throw new Error('当前环境不可用：需要在 Tauri 应用中读取文件。')
  return invoke<string>('read_text_file', {
    request: { path },
  })
}

export async function pathStatus(path: string): Promise<PathStatus> {
  if (!path.trim()) {
    return { exists: false, isFile: false, normalizedPath: '' }
  }
  if (!hasTauriRuntime()) {
    return { exists: true, isFile: true, normalizedPath: path }
  }
  return invoke<PathStatus>('path_status', {
    request: { path },
  })
}

export async function captureVideoFrame(
  path: string,
  timestamp: number | null | undefined,
  frameIndex?: number | null,
) {
  if (!path.trim() || !Number.isFinite(timestamp ?? Number.NaN)) return ''
  if (!hasTauriRuntime()) return ''
  return invoke<string>('capture_video_frame', {
    request: { path, timestamp, frameIndex },
  })
}

export async function captureComparisonFrame(
  path: string,
  timestamp: number | null | undefined,
  options: ComparisonFrameOptions,
  frameIndex?: number | null,
) {
  if (!path.trim() || !Number.isFinite(timestamp ?? Number.NaN)) return ''
  if (!hasTauriRuntime()) return ''
  return invoke<string>('capture_comparison_frame', {
    request: {
      path,
      timestamp,
      frameIndex,
      cropBlackBorders: options.cropBlackBorders,
      resizeMode: options.resizeMode,
      inputSize: options.inputSize,
      portraitRotation: options.portraitRotation,
    },
  })
}

export async function deleteReport(path: string) {
  if (!hasTauriRuntime()) return
  return invoke<void>('delete_report', {
    request: { path },
  })
}

export async function updateReportEntries(path: string, pairs: ReportPairIdentity[]) {
  if (!hasTauriRuntime()) {
    return {
      removedCount: pairs.length,
      remainingCount: 0,
      updatedFiles: [],
    } satisfies UpdateReportEntriesResult
  }
  return invoke<UpdateReportEntriesResult>('update_report_entries', {
    request: { path, pairs },
  })
}

export async function clearCache(cacheDir: string, projectRoot: string) {
  if (!hasTauriRuntime()) return { removedEntries: 0, message: '清空缓存需要在 Tauri 应用中运行。' }
  return invoke<ClearCacheResult>('clear_cache', {
    request: { cacheDir, projectRoot },
  })
}

export async function scanCache(cacheDir: string, projectRoot: string) {
  if (!hasTauriRuntime()) {
    return {
      cacheDir,
      items: [],
      totalSizeBytes: 0,
      totalEntries: 0,
      message: '扫描缓存需要在 Tauri 应用中运行。',
    } satisfies CacheScanResult
  }
  return invoke<CacheScanResult>('scan_cache', {
    request: { cacheDir, projectRoot },
  })
}

export async function clearCacheItems(cacheDir: string, projectRoot: string, paths: string[]) {
  if (!hasTauriRuntime()) return { removedEntries: 0, message: '清理缓存需要在 Tauri 应用中运行。' }
  return invoke<ClearCacheResult>('clear_cache_items', {
    request: { cacheDir, projectRoot, paths },
  })
}

export async function deleteFiles(paths: string[]) {
  if (!hasTauriRuntime()) return { deletedPaths: [], failed: [], message: '删除文件需要在 Tauri 应用中运行。' }
  return invoke<DeleteFilesResult>('delete_files', {
    request: { paths },
  })
}

export async function moveFiles(paths: string[], targetDir: string) {
  if (!hasTauriRuntime()) return { movedPaths: [], failed: [], message: '移动文件需要在 Tauri 应用中运行。' }
  return invoke<MoveFilesResult>('move_files', {
    request: { paths, targetDir },
  })
}

export async function cancelMoveFiles() {
  if (!hasTauriRuntime()) {
    return {
      running: false,
      cancelRequested: false,
      targetDir: '',
      currentPath: null,
      pendingPaths: [],
    } satisfies FileMoveStatus
  }
  return invoke<FileMoveStatus>('cancel_move_files')
}

export async function getFileMoveStatus() {
  if (!hasTauriRuntime()) {
    return {
      running: false,
      cancelRequested: false,
      targetDir: '',
      currentPath: null,
      pendingPaths: [],
    } satisfies FileMoveStatus
  }
  return invoke<FileMoveStatus>('get_file_move_status')
}

export async function openFile(path: string) {
  if (!hasTauriRuntime()) return
  return invoke<void>('open_file', {
    request: { path },
  })
}

export async function revealInFolder(path: string) {
  if (!hasTauriRuntime()) return
  return invoke<void>('reveal_in_folder', {
    request: { path },
  })
}

export async function openPath(path: string) {
  if (!hasTauriRuntime()) return
  return invoke<void>('open_path', {
    request: { path },
  })
}

export async function minimizeWindow() {
  if (!hasTauriRuntime()) return
  return invoke<void>('minimize_window')
}

export async function maximizeWindow() {
  if (!hasTauriRuntime()) return false
  return invoke<boolean>('maximize_window')
}

export async function toggleMaximizeWindow() {
  if (!hasTauriRuntime()) return false
  return invoke<boolean>('toggle_maximize_window')
}

export async function setCloseToTray(enabled: boolean) {
  if (!hasTauriRuntime()) return
  return invoke<void>('set_close_to_tray', { enabled })
}

export async function setCloseBehavior(behavior: CloseBehavior) {
  if (!hasTauriRuntime()) return
  return invoke<void>('set_close_behavior', { behavior })
}

export async function closeWindow(minimizeToTray: boolean) {
  if (!hasTauriRuntime()) return
  return invoke<void>('close_window', {
    request: { minimizeToTray },
  })
}

export async function isWindowMaximized() {
  if (!hasTauriRuntime()) return false
  return invoke<boolean>('is_window_maximized')
}

export async function listenAnalysisEvents(handlers: {
  onLog?: (payload: AnalysisLogPayload) => void
  onProgress?: (payload: AnalysisProgressPayload) => void
  onVideoQuarantined?: (payload: AnalysisVideoQuarantinedPayload) => void
  onFinished?: (payload: ReportPathsPayload) => void
  onStageFinished?: (payload: AnalysisStageFinishedPayload) => void
  onError?: (payload: AnalysisErrorPayload) => void
}) {
  if (!hasTauriRuntime()) return () => undefined

  const unlisten: UnlistenFn[] = []
  try {
    unlisten.push(await listen<AnalysisLogPayload>('analysis-log', (event) => handlers.onLog?.(event.payload)))
    unlisten.push(await listen<AnalysisProgressPayload>('analysis-progress', (event) => handlers.onProgress?.(event.payload)))
    unlisten.push(await listen<AnalysisVideoQuarantinedPayload>('analysis-video-quarantined', (event) => handlers.onVideoQuarantined?.(event.payload)))
    unlisten.push(await listen<ReportPathsPayload>('analysis-finished', (event) => handlers.onFinished?.(event.payload)))
    unlisten.push(await listen<AnalysisStageFinishedPayload>('analysis-stage-finished', (event) => handlers.onStageFinished?.(event.payload)))
    unlisten.push(await listen<AnalysisErrorPayload>('analysis-error', (event) => handlers.onError?.(event.payload)))
  } catch (error) {
    unlisten.forEach((stop) => stop())
    throw new Error(normalizeBackendError(error), { cause: error })
  }

  return () => {
    unlisten.forEach((stop: UnlistenFn) => stop())
  }
}

export async function listenMergeEvents(handlers: {
  onLog?: (payload: AnalysisLogPayload) => void
  onProgress?: (payload: MergeProgressPayload) => void
  onFinished?: (payload: MergeFinishedPayload) => void
  onError?: (payload: AnalysisErrorPayload) => void
}) {
  if (!hasTauriRuntime()) return () => undefined

  const unlisten: UnlistenFn[] = []
  try {
    unlisten.push(await listen<AnalysisLogPayload>('merge-log', (event) => handlers.onLog?.(event.payload)))
    unlisten.push(await listen<MergeProgressPayload>('merge-progress', (event) => handlers.onProgress?.(event.payload)))
    unlisten.push(await listen<MergeFinishedPayload>('merge-finished', (event) => handlers.onFinished?.(event.payload)))
    unlisten.push(await listen<AnalysisErrorPayload>('merge-error', (event) => handlers.onError?.(event.payload)))
  } catch (error) {
    unlisten.forEach((stop) => stop())
    throw new Error(normalizeBackendError(error), { cause: error })
  }

  return () => {
    unlisten.forEach((stop) => stop())
  }
}

export async function listenAppCloseRequested(handler: () => void) {
  if (!hasTauriRuntime()) return () => undefined
  const unlisten = await listen('app-close-requested', () => handler())
  return () => {
    unlisten()
  }
}

export async function listenAppExitRequested(handler: () => void) {
  if (!hasTauriRuntime()) return () => undefined
  const unlisten = await listen('app-exit-requested', () => handler())
  return () => {
    unlisten()
  }
}

export async function listenUpdateDownloadProgress(
  handler: (payload: UpdateDownloadProgress) => void,
) {
  if (!hasTauriRuntime()) return () => undefined
  const unlisten = await listen<UpdateDownloadProgress>(
    'update-download-progress',
    (event) => handler(event.payload),
  )
  return () => {
    unlisten()
  }
}

export async function listenClipModelInstallProgress(
  handler: (payload: UpdateDownloadProgress) => void,
) {
  if (!hasTauriRuntime()) return () => undefined
  const unlisten = await listen<UpdateDownloadProgress>(
    'clip-model-install-progress',
    (event) => handler(event.payload),
  )
  return () => {
    unlisten()
  }
}

export function buildRunBatchCompareConfig(
  settings: SettingsSnapshot,
  analysisConfig: AnalysisConfig,
): RunBatchCompareConfig {
  return {
    videoDir: analysisConfig.videoDir,
    outputDir: analysisConfig.outputDir || settings.reportDir,
    cacheDir: settings.cacheDir,
    pythonPath: settings.pythonPath,
    projectRoot: settings.projectRoot,
    skipThreshold: analysisConfig.skipThreshold,
    matchThreshold: analysisConfig.matchThreshold,
    windowSize: analysisConfig.windowSize,
    topK: analysisConfig.topK,
    candidateLimit: analysisConfig.candidateLimit ?? settings.defaultCandidateLimit,
    compareWorkers: analysisConfig.compareWorkers || settings.defaultCompareWorkers,
    maxGapSec: analysisConfig.maxGapSec,
    frameStep: analysisConfig.frameStep || settings.defaultFrameStep,
    minSegmentDuration: analysisConfig.minSegmentDuration || settings.defaultMinSegmentDuration,
    minSegmentMatches: analysisConfig.minSegmentMatches || settings.defaultMinSegmentMatches,
    offsetTolerance: analysisConfig.offsetTolerance || settings.defaultOffsetTolerance,
    cropBlackBorders: analysisConfig.cropBlackBorders,
    resizeMode: analysisConfig.resizeMode,
    inputSize: analysisConfig.inputSize || settings.defaultInputSize,
    portraitRotation: analysisConfig.portraitRotation || settings.defaultPortraitRotation,
    force: analysisConfig.force,
    earlyStop: analysisConfig.earlyStop ?? settings.defaultEarlyStop,
    device: settings.defaultDevice,
    errorTolerancePreset: analysisConfig.errorTolerancePreset,
    errorToleranceSevereLimit: analysisConfig.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: analysisConfig.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: analysisConfig.errorTolerancePreflightValidation,
    analysisMode: analysisConfig.mode,
  }
}

export function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function localFileSrc(path: string) {
  if (!path) return ''
  return hasTauriRuntime() ? convertFileSrc(path) : path
}

export function siblingPath(path: string, extension: string) {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : ''
  const file = slashIndex >= 0 ? path.slice(slashIndex + 1) : path
  const dotIndex = file.lastIndexOf('.')
  const stem = dotIndex >= 0 ? file.slice(0, dotIndex) : file
  return `${directory}${stem}${normalizedExtension}`
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function formatDateTime(value?: string) {
  if (!value) return '-'
  const numeric = Number(value)
  const date = Number.isFinite(numeric) && /^\d+$/.test(value)
    ? new Date(numeric * 1000)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function normalizeTaskPath(path: string) {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
}
