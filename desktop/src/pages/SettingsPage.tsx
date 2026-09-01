import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  CircleStop,
  Download,
  ExternalLink,
  FileSearch,
  Film,
  FolderOpen,
  Github,
  Info,
  PackageCheck,
  RefreshCw,
  Save,
  ScanSearch,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import {
  GlassPanel,
  NeonButton,
  ParameterHint,
  SelectInput,
  Slider,
  TextInput,
  Toggle,
} from '@/components/DesignSystem'
import { CacheCleanupDialog } from '@/components/CacheCleanupDialog'
import { RuntimeSettingsCard } from '@/components/RuntimeSettingsCard'
import { MergeRuntimeSettingsCard } from '@/components/MergeRuntimeSettingsCard'
import { Translated } from '@/i18n/Translated'
import {
  cancelUpdateDownload,
  checkClipModelUpdate,
  checkPythonEnv,
  checkForUpdates,
  clearCacheItems,
  deleteConfigTemplate,
  downloadAndInstallUpdate,
  formatBytes,
  getAppInfo,
  getClipModelStatus,
  getMergeRuntimeStatus,
  getRuntimeStatus,
  installClipModel,
  listConfigTemplates,
  listenClipModelInstallProgress,
  listenUpdateDownloadProgress,
  normalizeBackendError,
  openProjectPage,
  openReleasePage,
  PROJECT_ISSUES_URL,
  PROJECT_LICENSE_URL,
  PROJECT_REPOSITORY_URL,
  scanCache,
  saveConfigTemplate,
  selectOutputDirectory,
  selectPythonExecutable,
  selectVideoDirectory,
  type AppInfo,
  type CacheScanResult,
  type ClipModelStatus,
  type MergeRuntimeStatus,
  type RuntimeStatus,
  type ConfigTemplateRecord,
  type UpdateDownloadProgress,
  type UpdateInfo,
  type ResourceUpdateCheck,
} from '@/services/backend'
import * as backendApi from '@/services/backend'
import { useEnvironmentStore } from '@/stores/environmentStore'
import { analysisPresetFromSettings, settingsSnapshotFromState, useSettingsStore } from '@/stores/settingsStore'
import type {
  AnalysisPresetConfig,
  AppLanguage,
  CloseBehavior,
  DeviceMode,
  ErrorTolerancePreset,
  PortraitRotation,
  ResizeMode,
  SettingsSnapshot,
  VideoScanDurationUnit,
  VideoScanFilterKey,
  VideoScanNumericValue,
  VideoScanSizeUnit,
  VideoScanSortBy,
  VideoScanSortDirection,
} from '@/types/config'
import { analysisPresetOptions, errorToleranceOptions } from '@/types/config'
import { parameterHints, withEnglish } from '@/utils/parameterHints'

type SettingsTab = 'base' | 'analysis' | 'error_tolerance' | 'video_scan'

type DownloadTaskKind = 'clip-model' | 'update'

interface DownloadTaskSnapshot {
  active: boolean
  progress: UpdateDownloadProgress | null
  error: string
  terminal?: 'success' | 'cancelled' | 'failed'
  generation: number
  notifyCompletion?: boolean
}

interface BackendDownloadTaskStatus {
  task?: string
  phase?: string
  stage?: string
  running?: boolean
  cancelled?: boolean
  cancelRequested?: boolean
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
}

type DownloadTaskStatusApi = {
  getDownloadTaskStatus?: (task: string) => Promise<BackendDownloadTaskStatus>
  getClipModelDownloadStatus?: () => Promise<BackendDownloadTaskStatus>
  getUpdateDownloadStatus?: () => Promise<BackendDownloadTaskStatus>
  cancelDownloadTask?: (task: string) => Promise<void>
  cancelClipModelDownload?: () => Promise<void>
  cancelClipModelInstall?: () => Promise<void>
}

const optionalDownloadApi = backendApi as typeof backendApi & DownloadTaskStatusApi

async function queryDownloadTaskStatus(kind: DownloadTaskKind) {
  const task = kind === 'clip-model' ? 'clip-model' : 'update'
  const status = optionalDownloadApi.getDownloadTaskStatus
    ? await optionalDownloadApi.getDownloadTaskStatus(task)
    : kind === 'clip-model' && optionalDownloadApi.getClipModelDownloadStatus
      ? await optionalDownloadApi.getClipModelDownloadStatus()
      : kind === 'update' && optionalDownloadApi.getUpdateDownloadStatus
        ? await optionalDownloadApi.getUpdateDownloadStatus()
        : null
  return status
}

async function cancelDownloadTask(kind: DownloadTaskKind) {
  const task = kind === 'clip-model' ? 'clip-model' : 'update'
  if (optionalDownloadApi.cancelDownloadTask) {
    await optionalDownloadApi.cancelDownloadTask(task)
    return
  }
  if (kind === 'clip-model') {
    if (optionalDownloadApi.cancelClipModelDownload) {
      await optionalDownloadApi.cancelClipModelDownload()
      return
    }
    if (optionalDownloadApi.cancelClipModelInstall) {
      await optionalDownloadApi.cancelClipModelInstall()
      return
    }
  }
  if (kind === 'update') {
    await cancelUpdateDownload()
    return
  }
  throw new Error('当前版本不支持取消离线模型下载。')
}

function progressFromDownloadStatus(status: BackendDownloadTaskStatus): UpdateDownloadProgress {
  return {
    downloadedBytes: Number.isFinite(status.downloadedBytes) ? Number(status.downloadedBytes) : 0,
    totalBytes: Number.isFinite(status.totalBytes) ? Number(status.totalBytes) : 0,
    progress: Number.isFinite(status.progress) ? Number(status.progress) : 0,
    stage: status.stage || status.phase || '',
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function downloadStatusIsActive(status: BackendDownloadTaskStatus) {
  // A cancellation request is asynchronous: keep the button in its cancel
  // state until the backend has actually released the task, avoiding a race
  // where a second install starts while the first task is still unwinding.
  return status.running === true && status.cancelled !== true
}

type DownloadTerminal = 'success' | 'cancelled' | 'failed'

// A progress event is only a hint: the native installer can emit 100% before
// verification, extraction, or the OS installer has finished. The status
// endpoint is the source of truth for releasing the action button.
// eslint-disable-next-line react-refresh/only-export-components
export function downloadStatusTerminal(
  kind: DownloadTaskKind,
  status: BackendDownloadTaskStatus,
): DownloadTerminal | null {
  const stage = (status.stage || status.phase || '').trim()
  if (status.running === true || /正在取消/.test(stage)) return null
  if (status.cancelled === true || /已取消|取消完成/.test(stage)) return 'cancelled'
  if (/失败|错误/.test(stage)) return 'failed'
  if (kind === 'update' && /已安装|安装完成|更新完成|更新已完成|应用已更新|应用即将退出|已完成/.test(stage)) return 'success'
  if (kind === 'clip-model' && /已安装|安装完成|模型下载完成|已完成/.test(stage)) return 'success'
  return null
}

// eslint-disable-next-line react-refresh/only-export-components
export function downloadStatusHasSettled(
  kind: DownloadTaskKind,
  status: BackendDownloadTaskStatus,
  expected?: DownloadTerminal,
) {
  const terminal = downloadStatusTerminal(kind, status)
  return terminal !== null && (expected === undefined || terminal === expected)
}

/**
 * Progress events do not carry the backend's `running` flag.  In particular,
 * update installation emits 100% when the archive has been verified, before
 * the installer is launched.  Only an explicit terminal stage may end the
 * task here; the numeric percentage is never used as a terminal signal.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function downloadProgressIsTerminal(
  kind: DownloadTaskKind,
  progress: UpdateDownloadProgress,
) {
  const stage = progress.stage.trim()
  if (!stage) return false
  // "正在取消" is still a running backend task. Keep the action disabled
  // from starting a second task until the status query reports stopped.
  if (/失败|错误|已取消|取消完成/.test(stage)) return true
  if (kind === 'update') {
    return /已安装|安装完成|更新完成|更新已完成|应用已更新|应用即将退出|已完成/.test(stage)
  }
  return /已安装|安装完成|模型下载完成|已完成/.test(stage)
}

// eslint-disable-next-line react-refresh/only-export-components
export function downloadProgressEventIsActive(
  kind: DownloadTaskKind,
  progress: UpdateDownloadProgress,
) {
  return !downloadProgressIsTerminal(kind, progress)
}

async function waitForDownloadTaskSettlement(
  kind: DownloadTaskKind,
  expected?: DownloadTerminal,
) {
  let latest: BackendDownloadTaskStatus | null = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await queryDownloadTaskStatus(kind).catch(() => null)
    if (latest && downloadStatusHasSettled(kind, latest, expected)) return latest
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
  }
  return latest
}

// Keep download state outside the dialog component tree.  Dialogs are
// intentionally ephemeral (and may be closed while a download continues), so
// local modal state must never be the source of truth for the action button.
const downloadTaskSnapshots: Record<DownloadTaskKind, DownloadTaskSnapshot> = {
  'clip-model': { active: false, progress: null, error: '', generation: 0, notifyCompletion: false },
  update: { active: false, progress: null, error: '', generation: 0, notifyCompletion: false },
}

function getDownloadTaskSnapshot(kind: DownloadTaskKind): DownloadTaskSnapshot {
  const snapshot = downloadTaskSnapshots[kind]
  return {
    active: snapshot.active,
    progress: snapshot.progress ? { ...snapshot.progress } : null,
    error: snapshot.error,
    terminal: snapshot.terminal,
    generation: snapshot.generation,
    notifyCompletion: snapshot.notifyCompletion,
  }
}

function setDownloadTaskSnapshot(kind: DownloadTaskKind, patch: Partial<DownloadTaskSnapshot>) {
  downloadTaskSnapshots[kind] = {
    ...downloadTaskSnapshots[kind],
    ...patch,
  }
}

function beginDownloadTask(kind: DownloadTaskKind, notifyCompletion = false) {
  const generation = downloadTaskSnapshots[kind].generation + 1
  setDownloadTaskSnapshot(kind, { generation, active: true, terminal: undefined, notifyCompletion })
  return generation
}

function isCurrentDownloadGeneration(kind: DownloadTaskKind, generation: number) {
  return downloadTaskSnapshots[kind].generation === generation
}

function formatResourceCheckDetails(check: ResourceUpdateCheck) {
  const versions = check.installedVersion && check.remoteVersion
    ? `（本地 v${check.installedVersion}，GitHub v${check.remoteVersion}）`
    : check.remoteVersion
      ? `（GitHub v${check.remoteVersion}）`
      : ''
  const hashes = check.localSha256 && check.remoteSha256
    ? `（本地 SHA-256 ${check.localSha256.slice(0, 12)}…，远端 ${check.remoteSha256.slice(0, 12)}…）`
    : ''
  return `${versions}${hashes}`
}

// eslint-disable-next-line react-refresh/only-export-components
export function clipModelUpdatePrompt(check: ResourceUpdateCheck) {
  const details = formatResourceCheckDetails(check)
  if (!check.installed) return `已找到 GitHub 最新版离线 CLIP 模型${details}，是否安装？`
  if (check.comparisonAvailable && check.updateAvailable) return `检测到离线 CLIP 模型有可用更新${details}，是否更新？`
  if (check.comparisonAvailable) return `当前离线 CLIP 模型已是最新版${details}。是否仍要强制重装？`
  return '无法可靠比较离线 CLIP 模型的本地版本与 GitHub 最新版。是否强制重装？'
}

// eslint-disable-next-line react-refresh/only-export-components
export function clipModelProgressCanCancel(stage: string) {
  return !/正在取消|解压|校验|验证|提交|切换|正在安装|收尾|已完成/.test(stage)
}

interface ErrorToleranceTemplateConfig {
  errorTolerancePreset: ErrorTolerancePreset
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
}

const videoScanFilterOptions: Array<{
  id: VideoScanFilterKey
  name: string
  summary: string
}> = [
  { id: 'size', name: '文件大小', summary: '大小' },
  { id: 'name', name: '名称', summary: '前缀 / 包含' },
  { id: 'duration', name: '时长', summary: '时间' },
  { id: 'resolution', name: '分辨率', summary: '宽高' },
  { id: 'fps', name: '帧率', summary: 'FPS' },
  { id: 'extension', name: '格式', summary: '扩展名' },
]

const videoScanSizeUnitOptions: Array<{ value: VideoScanSizeUnit; label: string }> = [
  { value: 'B', label: 'B' },
  { value: 'KB', label: 'KB' },
  { value: 'MB', label: 'MB' },
  { value: 'GB', label: 'GB' },
  { value: 'TB', label: 'TB' },
]

const videoScanDurationUnitOptions: Array<{ value: VideoScanDurationUnit; label: string }> = [
  { value: 'ms', label: '毫秒' },
  { value: 'sec', label: '秒' },
  { value: 'min', label: '分钟' },
  { value: 'hour', label: '小时' },
]

const videoScanSortByOptions: Array<{ value: VideoScanSortBy; label: string }> = [
  { value: 'name', label: '名称' },
  { value: 'duration', label: '时长' },
  { value: 'size', label: '大小' },
  { value: 'fps', label: '帧率' },
  { value: 'resolution', label: '分辨率' },
  { value: 'modified', label: '修改时间' },
]

const videoScanSortDirectionOptions: Array<{ value: VideoScanSortDirection; label: string }> = [
  { value: 'asc', label: '升序' },
  { value: 'desc', label: '降序' },
]

async function runEnvironmentCheck(quickCheck = false) {
  const state = useSettingsStore.getState()
  return checkPythonEnv({
    pythonPath: state.pythonPath,
    projectRoot: state.projectRoot,
    reportDir: state.reportDir,
    quickCheck,
  })
}

export function SettingsPage() {
  const settings = useSettingsStore()
  const [activeTab, setActiveTab] = useState<SettingsTab>('base')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const environment = useEnvironmentStore((state) => state.status)
  const checking = useEnvironmentStore((state) => state.checking)
  const environmentError = useEnvironmentStore((state) => state.error)
  const checkedEnvironmentKey = useEnvironmentStore((state) => state.configKey)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheDialogOpen, setCacheDialogOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [cacheScan, setCacheScan] = useState<CacheScanResult | null>(null)
  const [selectedCachePaths, setSelectedCachePaths] = useState<Set<string>>(() => new Set())
  const [savedMessage, setSavedMessage] = useState('')
  const [error, setError] = useState('')
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const saveMessageTimer = useRef<number | null>(null)
  const saveFeedbackTimer = useRef<number | null>(null)
  const savedSettingsRef = useRef<SettingsSnapshot>(settingsSnapshotFromState(useSettingsStore.getState()))
  const [saveFeedback, setSaveFeedback] = useState<'idle' | 'saving' | 'saved'>('idle')
  const environmentConfigKey = buildEnvironmentConfigKey(settings.pythonPath, settings.projectRoot, settings.reportDir)

  const executeEnvironmentCheck = useCallback(async (quickCheck = false) => {
    useEnvironmentStore.getState().setChecking(true)
    useEnvironmentStore.getState().setError('')
    setError('')
    try {
      const status = await runEnvironmentCheck(quickCheck)
      useEnvironmentStore.getState().setStatus(status, environmentConfigKey)
    } catch (err) {
      const message = normalizeBackendError(err)
      useEnvironmentStore.getState().setStatus({
        ok: false,
        message,
        scriptsOk: false,
        reportDirOk: false,
        gpuAvailable: undefined,
        gpuMessage: '未检测',
      }, environmentConfigKey)
      useEnvironmentStore.getState().setError(message)
      setError(message)
    } finally {
      useEnvironmentStore.getState().setChecking(false)
    }
  }, [environmentConfigKey])

  useEffect(() => {
    let alive = true
    getAppInfo()
      .then((info) => {
        if (!alive) return
        setAppInfo(info)
        useSettingsStore.getState().hydrateAppDefaults({
          projectRoot: info.projectRoot,
          videoDir: info.defaultVideoDir,
          cacheDir: info.defaultCacheDir,
          reportDir: info.defaultOutputDir,
        })
      })
      .catch((err) => setError(normalizeBackendError(err)))

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!settings.checkEnvOnStartup) return undefined
    if (environment && checkedEnvironmentKey === environmentConfigKey) return undefined

    let alive = true
    const timer = window.setTimeout(() => {
      if (alive) void executeEnvironmentCheck(true)
    }, 450)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [checkedEnvironmentKey, environment, environmentConfigKey, executeEnvironmentCheck, settings.checkEnvOnStartup])

  useEffect(() => () => {
    if (saveMessageTimer.current) window.clearTimeout(saveMessageTimer.current)
    if (saveFeedbackTimer.current) window.clearTimeout(saveFeedbackTimer.current)
    const current = useSettingsStore.getState()
    if (buildSettingsSignature(current) !== buildSettingsSignature(savedSettingsRef.current)) {
      current.replaceSettings(savedSettingsRef.current)
    }
  }, [])

  useEffect(() => {
    const activeButton = tabsRef.current?.querySelector<HTMLButtonElement>('button.active')
    activeButton?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, settings.appLanguage])

  const environmentRows = useMemo(() => [
    {
      label: 'Python 环境',
      ok: environment?.ok,
      value: environment ? (environment.ok ? environment.pythonVersion || '正常' : '异常') : checking ? '检测中' : '未检测',
    },
    {
      label: '分析脚本',
      ok: environment?.scriptsOk,
      value: environment ? (environment.scriptsOk ? '可用' : '不可用') : checking ? '检测中' : '未检测',
    },
    {
      label: '报告目录',
      ok: environment?.reportDirOk,
      value: environment ? (environment.reportDirOk ? '已连接' : '不存在') : checking ? '检测中' : '未检测',
    },
    {
      label: 'GPU 加速(CUDA)',
      ok: environment?.gpuAvailable,
      value: environment ? environment.gpuMessage || (environment.gpuAvailable ? '可用' : '不可用') : checking ? '检测中' : '未检测',
    },
  ], [checking, environment])

  async function handleCheckEnvironment() {
    await executeEnvironmentCheck(false)
  }

  async function chooseVideoDir() {
    setError('')
    try {
      const selected = await selectVideoDirectory()
      if (selected) settings.setVideoDir(selected)
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  async function choosePythonPath() {
    setError('')
    try {
      const selected = await selectPythonExecutable()
      if (selected) {
        settings.setPythonPath(selected)
        showSettingsMessage('Python 路径已选择，请点击“保存设置”应用。')
      }
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  function useBundledPython() {
    settings.setPythonPath('python')
    showSettingsMessage('已选择内置 env 环境，请点击“保存设置”应用。')
  }

  async function chooseCacheDir() {
    await chooseDirectory((selected) => settings.setCacheDir(selected))
  }

  async function chooseReportDir() {
    await chooseDirectory((selected) => settings.setReportDir(selected))
  }

  async function chooseDirectory(setter: (path: string) => void) {
    setError('')
    try {
      const selected = await selectOutputDirectory()
      if (selected) setter(selected)
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  const showSettingsMessage = useCallback((message: string, duration = 2200) => {
    setSavedMessage(message)
    if (saveMessageTimer.current) window.clearTimeout(saveMessageTimer.current)
    saveMessageTimer.current = window.setTimeout(() => setSavedMessage(''), duration)
  }, [])

  const showResourceCompleted = useCallback((message: string) => {
    setError('')
    showSettingsMessage(message)
  }, [showSettingsMessage])

  function handleSave(message = '设置已保存，后续任务将使用新配置。') {
    if (saveFeedbackTimer.current) window.clearTimeout(saveFeedbackTimer.current)
    setSaveFeedback('saving')
    const current = useSettingsStore.getState()
    current.saveSettings()
    const snapshot = settingsSnapshotFromState(current)
    savedSettingsRef.current = snapshot
    saveFeedbackTimer.current = window.setTimeout(() => {
      setSaveFeedback('saved')
      showSettingsMessage(message)
      saveFeedbackTimer.current = window.setTimeout(() => setSaveFeedback('idle'), 1200)
    }, 140)
  }

  async function handleClearCache() {
    const cacheDir = settings.cacheDir.trim()
    if (!cacheDir) {
      setError('请先配置缓存目录。')
      return
    }

    setClearingCache(true)
    setError('')
    try {
      const result = await scanCache(cacheDir, settings.projectRoot)
      setCacheScan(result)
      setSelectedCachePaths(new Set(result.items.map((item) => item.path)))
      setCacheDialogOpen(true)
    } catch (err) {
      setError(normalizeBackendError(err))
    } finally {
      setClearingCache(false)
    }
  }

  async function handleConfirmClearCache(paths: string[]) {
    if (paths.length === 0) {
      setError('请先选择要清理的缓存项目。')
      return
    }
    const confirmed = window.confirm(`确认清理选中的 ${paths.length} 个缓存项目吗？此操作不可撤销，但不会删除原始视频。`)
    if (!confirmed) return

    setClearingCache(true)
    setError('')
    try {
      const result = await clearCacheItems(settings.cacheDir, settings.projectRoot, paths)
      setSavedMessage(result.message)
      window.setTimeout(() => setSavedMessage(''), 2200)
      const nextScan = await scanCache(settings.cacheDir, settings.projectRoot)
      setCacheScan(nextScan)
      setSelectedCachePaths(new Set(nextScan.items.map((item) => item.path)))
      if (nextScan.items.length === 0) setCacheDialogOpen(false)
    } catch (err) {
      setError(normalizeBackendError(err))
    } finally {
      setClearingCache(false)
    }
  }

  function handleReset() {
    if (!window.confirm(resetConfirmMessage)) return
    if (activeTab === 'analysis') {
      settings.resetAnalysisSettings()
      showSettingsMessage('已恢复默认分析配置，请点击“保存设置”应用。')
      return
    }
    if (activeTab === 'error_tolerance') {
      settings.resetErrorToleranceSettings()
      showSettingsMessage('已恢复默认错误容忍设置，请点击“保存设置”应用。')
      return
    }
    if (activeTab === 'video_scan') {
      settings.resetVideoScanFilters()
      showSettingsMessage('已恢复默认视频扫描范围，请点击“保存设置”应用。')
      return
    }

    settings.resetBaseSettings({
      projectRoot: appInfo?.projectRoot || settings.projectRoot,
      videoDir: appInfo?.defaultVideoDir || settings.videoDir,
      cacheDir: appInfo?.defaultCacheDir || settings.cacheDir,
      reportDir: appInfo?.defaultOutputDir || settings.reportDir,
    })
    useEnvironmentStore.getState().resetEnvironment()
    showSettingsMessage('已恢复默认基础设置，请点击“保存设置”应用。')
  }

  const resetLabel = activeTab === 'analysis'
    ? '恢复当前预设默认'
    : activeTab === 'error_tolerance'
      ? '恢复错误容忍默认'
      : activeTab === 'video_scan'
        ? '恢复视频扫描范围默认'
        : '恢复基础默认'
  const resetConfirmMessage = activeTab === 'analysis'
    ? '此操作将恢复当前预设的分析配置默认设置'
    : activeTab === 'error_tolerance'
      ? '此操作将恢复错误容忍设置的默认值'
      : activeTab === 'video_scan'
        ? '此操作将恢复视频扫描范围的默认设置'
        : '此操作将恢复设置到基础的默认设置'
  const toastMessage = error || savedMessage || (saveFeedback === 'saved' ? '设置保存成功' : '')

  return (
    <Translated>
    <div className="route-fill settings-shell">
      <GlassPanel className="settings-tab-panel">
        <div className="settings-tab-toolbar">
          <div className="settings-tabs" role="tablist" aria-label="设置分类" ref={tabsRef}>
            <button
              type="button"
              className={activeTab === 'base' ? 'active' : ''}
              title="基础设置"
              onClick={() => setActiveTab('base')}
            >
              <Settings size={18} />
              基础设置
            </button>
            <button
              type="button"
              className={activeTab === 'analysis' ? 'active' : ''}
              title="分析配置"
              onClick={() => setActiveTab('analysis')}
            >
              <SlidersHorizontal size={18} />
              分析配置
            </button>
            <button
              type="button"
              className={activeTab === 'error_tolerance' ? 'active' : ''}
              title="错误容忍设置"
              onClick={() => setActiveTab('error_tolerance')}
            >
              <ShieldCheck size={18} />
              错误容忍设置
            </button>
            <button
              type="button"
              className={activeTab === 'video_scan' ? 'active' : ''}
              title="视频扫描范围"
              onClick={() => setActiveTab('video_scan')}
            >
              <ScanSearch size={18} />
              视频扫描范围
            </button>
          </div>
          <div className="settings-fixed-actions">
            <NeonButton
              className="settings-reset-button"
              variant="outline"
              type="button"
              onClick={handleReset}
              title={resetLabel}
              aria-label={resetLabel}
            >
              重置
            </NeonButton>
            <NeonButton
              className={`settings-save-button ${saveFeedback === 'saving' ? 'is-saving' : saveFeedback === 'saved' ? 'is-saved' : ''}`}
              type="button"
              onClick={() => handleSave()}
            >
              {saveFeedback === 'saved' ? <CheckCircle2 size={18} /> : <Save size={18} />}
              {saveFeedback === 'saving' ? '正在保存' : saveFeedback === 'saved' ? '保存成功' : '保存设置'}
            </NeonButton>
            <NeonButton variant="outline" type="button" onClick={() => setUpdateDialogOpen(true)}>
              检查更新
            </NeonButton>
            <NeonButton className="cache-check-button" tone="red" variant="outline" type="button" onClick={() => void handleClearCache()} disabled={clearingCache}>
              {clearingCache ? '检查中' : '检查缓存'}
            </NeonButton>
          </div>
        </div>

        <div className="settings-tab-content">
          {activeTab === 'base' ? (
            <BaseSettings
              appInfo={appInfo}
              onChoosePythonPath={choosePythonPath}
              onUseBundledPython={useBundledPython}
              onChooseVideoDir={chooseVideoDir}
              onChooseCacheDir={chooseCacheDir}
              onChooseReportDir={chooseReportDir}
              onResourceCompleted={showResourceCompleted}
            />
          ) : activeTab === 'analysis' ? (
            <AnalysisSettings
              onPresetSaved={(presetName) => {
                handleSave(`已保存到“${presetName}”预设。`)
              }}
            />
          ) : activeTab === 'error_tolerance' ? (
            <ErrorToleranceSettings
              onMessage={(message) => {
                setSavedMessage(message)
                window.setTimeout(() => setSavedMessage(''), 1800)
              }}
            />
          ) : (
            <VideoScanRangeSettings />
          )}
        </div>

        {toastMessage && (
          <div className={error ? 'settings-save-toast is-error' : 'settings-save-toast'} role="status" aria-live="polite">
            {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            {toastMessage}
          </div>
        )}
      </GlassPanel>
      <GlassPanel className="environment-status-panel compact">
        <div className="environment-status-inline">
          <strong>
            <ShieldCheck size={17} />
            环境状态
          </strong>
          {environmentRows.map((row) => (
            <span className={row.ok === false ? 'is-failed' : ''} title={`${row.label}：${row.value}`} key={row.label}>
              {row.ok === false || row.ok == null ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
              {row.label}：{row.value}
            </span>
          ))}
          <span className="environment-inline-message" title={error || environmentError || environment?.message || environment?.resolvedPythonPath || ''}>
            {error || environmentError || environment?.message || environment?.resolvedPythonPath || '等待检测'}
          </span>
          <NeonButton variant="ghost" type="button" onClick={() => void handleCheckEnvironment()} disabled={checking}>
            <RefreshCw size={16} className={checking ? 'spin-slow' : ''} />
            {checking ? '检测中' : '重新检测'}
          </NeonButton>
        </div>
      </GlassPanel>
      <UpdateDialog
        open={updateDialogOpen}
        appInfo={appInfo}
        proxyUrl={settings.networkProxy}
        onClose={() => setUpdateDialogOpen(false)}
      />
      <CacheCleanupDialog
        open={cacheDialogOpen}
        scan={cacheScan}
        selectedPaths={selectedCachePaths}
        busy={clearingCache}
        onTogglePath={(path, checked) => {
          setSelectedCachePaths((current) => {
            const next = new Set(current)
            if (checked) next.add(path)
            else next.delete(path)
            return next
          })
        }}
        onSelectAll={() => setSelectedCachePaths(new Set(cacheScan?.items.map((item) => item.path) ?? []))}
        onClearSelection={() => setSelectedCachePaths(new Set())}
        onClose={() => setCacheDialogOpen(false)}
        onConfirm={(paths) => void handleConfirmClearCache(paths)}
      />
    </div>
    </Translated>
  )
}

function BaseSettings({
  appInfo,
  onChoosePythonPath,
  onUseBundledPython,
  onChooseVideoDir,
  onChooseCacheDir,
  onChooseReportDir,
  onResourceCompleted,
}: {
  appInfo: AppInfo | null
  onChoosePythonPath: () => Promise<void>
  onUseBundledPython: () => void
  onChooseVideoDir: () => Promise<void>
  onChooseCacheDir: () => Promise<void>
  onChooseReportDir: () => Promise<void>
  onResourceCompleted: (message: string) => void
}) {
  const settings = useSettingsStore()
  const [modelStatus, setModelStatus] = useState<ClipModelStatus | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelInstalling, setModelInstalling] = useState(() => getDownloadTaskSnapshot('clip-model').active)
  const [modelProgress, setModelProgress] = useState<UpdateDownloadProgress | null>(() => getDownloadTaskSnapshot('clip-model').progress)
  const modelOperationRef = useRef(0)
  const modelStatusRequestRef = useRef(0)
  const [modelError, setModelError] = useState(() => getDownloadTaskSnapshot('clip-model').error)
  const [modelChecking, setModelChecking] = useState(false)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [mergeRuntimeStatus, setMergeRuntimeStatus] = useState<MergeRuntimeStatus | null>(null)
  const [mergeRuntimeLoading, setMergeRuntimeLoading] = useState(false)
  const [resourceDialog, setResourceDialog] = useState<'about' | 'runtime' | 'clip-model' | 'merge' | null>(null)
  const [aboutError, setAboutError] = useState('')
  const runtimeCompleted = useCallback(() => onResourceCompleted('AI 运行环境重装/更新完成'), [onResourceCompleted])
  const mergeRuntimeCompleted = useCallback(() => onResourceCompleted('视频合并环境重装/更新完成'), [onResourceCompleted])

  const handleOpenProjectPage = useCallback(async (url: string) => {
    setAboutError('')
    try {
      await openProjectPage(url)
    } catch (err) {
      setAboutError(normalizeBackendError(err))
    }
  }, [])

  const refreshRuntimeStatuses = useCallback(async () => {
    setRuntimeLoading(true)
    setMergeRuntimeLoading(true)
    const [runtime, mergeRuntime] = await Promise.all([
      getRuntimeStatus().catch(() => null),
      getMergeRuntimeStatus().catch(() => null),
    ])
    setRuntimeStatus(runtime)
    setMergeRuntimeStatus(mergeRuntime)
    setRuntimeLoading(false)
    setMergeRuntimeLoading(false)
  }, [])

  const refreshClipModelStatus = useCallback(async () => {
    setModelLoading(true)
    setModelError('')
    try {
      setModelStatus(await getClipModelStatus())
    } catch (err) {
      setModelError(normalizeBackendError(err))
    } finally {
      setModelLoading(false)
    }
  }, [])

  const syncModelDownloadStatus = useCallback(async () => {
    const request = modelStatusRequestRef.current + 1
    modelStatusRequestRef.current = request
    try {
      const status = await queryDownloadTaskStatus('clip-model')
      if (!status || request !== modelStatusRequestRef.current) return
      const currentSnapshot = getDownloadTaskSnapshot('clip-model')
      // A delayed status response from the previous request must not reopen
      // a task after its successful install has already settled locally.
      if (currentSnapshot.terminal === 'success' && status.running === true) return
      const settled = downloadStatusHasSettled('clip-model', status)
      // A status response with running=false but no terminal stage can be a
      // stale response during extraction. Do not unlock a new install then.
      const active = status.running === true || (currentSnapshot.active && !settled)
      const nextProgress = progressFromDownloadStatus(status)
      setDownloadTaskSnapshot('clip-model', {
        active,
        progress: nextProgress.stage ? nextProgress : currentSnapshot.progress,
        terminal: settled ? downloadStatusTerminal('clip-model', status) || undefined : active ? undefined : currentSnapshot.terminal,
      })
      setModelInstalling(active)
      if (nextProgress.stage) setModelProgress(nextProgress)
    } catch {
      // Status polling is best-effort.  The progress event and install
      // promise remain authoritative when running against an older backend.
    }
  }, [])

  const closeResourceDialog = useCallback(() => {
    // Closing a resource dialog is presentation-only.  In particular, it
    // must not cancel a download; the module-level task snapshot keeps the
    // action button in sync when the dialog is opened again.
    setResourceDialog(null)
    void refreshRuntimeStatuses()
    void refreshClipModelStatus()
  }, [refreshRuntimeStatuses, refreshClipModelStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshClipModelStatus(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshClipModelStatus])

  useEffect(() => {
    let active = true
    const sync = () => {
      if (active) void syncModelDownloadStatus()
    }
    sync()
    const timer = window.setInterval(sync, 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [syncModelDownloadStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshRuntimeStatuses(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshRuntimeStatuses])

  useEffect(() => {
    let active = true
    let stop = () => undefined
    void listenClipModelInstallProgress((payload) => {
      if (!active) return
      const terminal = downloadProgressIsTerminal('clip-model', payload)
      const generation = getDownloadTaskSnapshot('clip-model').generation
      setDownloadTaskSnapshot('clip-model', {
        // Never unlock from an event alone. The native task may emit 100%
        // before its final install/cleanup work has released the lock.
        active: true,
        progress: payload,
        error: '',
        terminal: undefined,
      })
      setModelProgress(payload)
      setModelInstalling(true)
      if (terminal) {
        const expected = /取消/.test(payload.stage) ? 'cancelled' : /失败|错误/.test(payload.stage) ? 'failed' : 'success'
        void waitForDownloadTaskSettlement('clip-model', expected).then((finalStatus) => {
          if (!active || !isCurrentDownloadGeneration('clip-model', generation) || !finalStatus) return
          if (!downloadStatusHasSettled('clip-model', finalStatus, expected)) return
          const settledProgress = progressFromDownloadStatus(finalStatus)
          const shouldNotify = expected === 'success' && getDownloadTaskSnapshot('clip-model').notifyCompletion === true
          setModelProgress(settledProgress.stage ? settledProgress : payload)
          setDownloadTaskSnapshot('clip-model', {
            active: false,
            progress: settledProgress.stage ? settledProgress : payload,
            error: '',
            terminal: expected,
            notifyCompletion: false,
          })
          setModelInstalling(false)
          if (shouldNotify) onResourceCompleted('离线 CLIP 模型重装/更新完成')
        })
      }
    })
      .then((unlisten) => {
        if (!active) unlisten()
        else stop = unlisten
      })
      .catch((err) => {
        if (active) setModelError(normalizeBackendError(err))
      })
    return () => {
      active = false
      stop()
    }
  }, [onResourceCompleted])

  async function handleInstallClipModel() {
    if (modelInstalling || modelChecking) return
    setModelChecking(true)
    setModelError('')
    let updateCheck: ResourceUpdateCheck
    try {
      updateCheck = await checkClipModelUpdate(settings.networkProxy)
    } catch (err) {
      setModelError(normalizeBackendError(err))
      setModelChecking(false)
      return
    }
    setModelChecking(false)
    const confirmed = window.confirm(clipModelUpdatePrompt(updateCheck))
    if (!confirmed) return
    const operation = modelOperationRef.current + 1
    modelOperationRef.current = operation
    const generation = beginDownloadTask('clip-model', true)
    modelStatusRequestRef.current += 1
    setModelInstalling(true)
    setDownloadTaskSnapshot('clip-model', { active: true, error: '', terminal: undefined })
    setModelError('')
    const initialProgress = {
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: '正在准备模型安装',
    }
    setModelProgress(initialProgress)
    setDownloadTaskSnapshot('clip-model', { progress: initialProgress })
    try {
      const status = await installClipModel(settings.networkProxy)
      if (operation !== modelOperationRef.current || !isCurrentDownloadGeneration('clip-model', generation)) return
      setModelStatus(status)
      const currentProgress = getDownloadTaskSnapshot('clip-model').progress
      const completedProgress = {
        downloadedBytes: currentProgress?.downloadedBytes ?? status.sizeBytes,
        totalBytes: currentProgress?.totalBytes ?? status.sizeBytes,
        progress: 100,
        stage: '离线 CLIP 模型已安装',
      }
      setModelProgress(completedProgress)
      setDownloadTaskSnapshot('clip-model', { active: true, progress: completedProgress, error: '', terminal: undefined })
      const finalStatus = await waitForDownloadTaskSettlement('clip-model', 'success')
      if (operation !== modelOperationRef.current || !isCurrentDownloadGeneration('clip-model', generation)) return
      if (finalStatus && downloadStatusHasSettled('clip-model', finalStatus, 'success')) {
        const settledProgress = progressFromDownloadStatus(finalStatus)
        const finalProgress = settledProgress.stage ? settledProgress : completedProgress
        setModelProgress(finalProgress)
        const shouldNotify = getDownloadTaskSnapshot('clip-model').notifyCompletion === true
        setDownloadTaskSnapshot('clip-model', { active: false, progress: finalProgress, error: '', terminal: 'success', notifyCompletion: false })
        setModelInstalling(false)
        if (shouldNotify) onResourceCompleted('离线 CLIP 模型重装/更新完成')
      }
    } catch (err) {
      if (operation !== modelOperationRef.current) return
      const message = normalizeBackendError(err)
      if (operation !== modelOperationRef.current || !isCurrentDownloadGeneration('clip-model', generation)) return
      setModelError(message)
      const finalStatus = await waitForDownloadTaskSettlement('clip-model')
      if (operation !== modelOperationRef.current || !isCurrentDownloadGeneration('clip-model', generation)) return
      if (finalStatus && downloadStatusHasSettled('clip-model', finalStatus)) {
        const terminal = downloadStatusTerminal('clip-model', finalStatus) || 'failed'
        setDownloadTaskSnapshot('clip-model', { active: false, error: terminal === 'cancelled' ? '' : message, terminal, notifyCompletion: false })
        setModelInstalling(false)
      }
    }
  }

  async function handleCancelClipModel() {
    if (!modelInstalling || !clipModelProgressCanCancel(modelProgress?.stage || '')) return
    modelOperationRef.current += 1
    modelStatusRequestRef.current += 1
    setModelError('')
    const cancellingProgress: UpdateDownloadProgress = {
      ...(getDownloadTaskSnapshot('clip-model').progress || {
        downloadedBytes: 0,
        totalBytes: 0,
        progress: 0,
      }),
      stage: '正在取消模型下载',
    }
    setModelProgress(cancellingProgress)
    setDownloadTaskSnapshot('clip-model', { progress: cancellingProgress })
    try {
      await cancelDownloadTask('clip-model')
      const finalStatus = await waitForDownloadTaskSettlement('clip-model', 'cancelled')
      const cancelledProgress = { ...cancellingProgress, stage: '离线 CLIP 模型下载已取消' }
      if (finalStatus) {
        const settledProgress = progressFromDownloadStatus(finalStatus)
        cancelledProgress.downloadedBytes = settledProgress.downloadedBytes
        cancelledProgress.totalBytes = settledProgress.totalBytes
        cancelledProgress.progress = settledProgress.progress
      }
      if (!finalStatus || finalStatus.running || !downloadStatusHasSettled('clip-model', finalStatus, 'cancelled')) {
        // The backend may still be unwinding a blocked network read or
        // extraction after accepting cancellation. Keep the cancel state
        // visible and let the existing status poll/event listener settle it;
        // never expose the install action while the task is still running.
        const pendingProgress = { ...cancellingProgress, stage: '正在取消模型下载' }
        setModelInstalling(true)
        setModelProgress(pendingProgress)
        setDownloadTaskSnapshot('clip-model', { active: true, progress: pendingProgress })
        return
      }
      setModelInstalling(false)
      setModelProgress(cancelledProgress)
      setDownloadTaskSnapshot('clip-model', { active: false, progress: cancelledProgress, error: '', terminal: 'cancelled', notifyCompletion: false })
    } catch (err) {
      const message = normalizeBackendError(err)
      setDownloadTaskSnapshot('clip-model', { notifyCompletion: false })
      setModelError(message)
      setDownloadTaskSnapshot('clip-model', { error: message })
    }
  }

  const modelProgressValue = Math.max(0, Math.min(100, modelProgress?.progress || 0))
  const modelMissingFiles = modelStatus?.missingFiles ?? []

  return (
    <Translated>
    <div className="settings-panel-grid base">
      <div className="settings-compact-grid">
        <label className="settings-row settings-python-row">
          <ParameterHint label="Python 路径" tip={parameterHints.pythonPath} />
          <TextInput
            title={settings.pythonPath}
            value={settings.pythonPath}
            placeholder="python 或 C:\\path\\to\\python.exe"
            onChange={(event) => settings.setPythonPath(event.target.value)}
          />
          <div className="settings-path-actions">
            <NeonButton variant="outline" type="button" onClick={() => void onChoosePythonPath()}>
              <FileSearch size={17} />
              选择 exe
            </NeonButton>
            <NeonButton variant="outline" type="button" onClick={onUseBundledPython}>
              <PackageCheck size={17} />
              内置 env
            </NeonButton>
          </div>
        </label>

        <ReadOnlyPathSetting
          label="项目目录"
          tip={parameterHints.projectRoot}
          value={settings.projectRoot || appInfo?.projectRoot || ''}
        />
        <PathSetting label="视频目录" tip={parameterHints.videoDir} value={settings.videoDir} onChange={settings.setVideoDir} onChoose={onChooseVideoDir} />
        <PathSetting label="缓存目录" tip={parameterHints.cacheDir} value={settings.cacheDir} onChange={settings.setCacheDir} onChoose={onChooseCacheDir} />
        <PathSetting label="报告目录" tip={parameterHints.reportDir} value={settings.reportDir} onChange={settings.setReportDir} onChoose={onChooseReportDir} />
        <label className="settings-row settings-row-wide">
          <ParameterHint label="网络代理" tip={parameterHints.networkProxy} />
          <TextInput
            value={settings.networkProxy}
            placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
            onChange={(event) => settings.setNetworkProxy(event.target.value)}
          />
        </label>

        <label className="settings-toggle-row">
          <ParameterHint label="打开时最大化窗口" tip={parameterHints.openMaximized} />
          <Toggle checked={settings.openMaximized} onChange={settings.setOpenMaximized} />
        </label>
        <label className="settings-toggle-row close-behavior-row">
          <ParameterHint label="关闭窗口时" tip={parameterHints.closeBehavior} />
          <SelectInput
            value={settings.closeBehavior}
            onChange={(event) => settings.setCloseBehavior(event.target.value as CloseBehavior)}
          >
            <option value="ask">每次询问</option>
            <option value="tray">最小化到托盘运行</option>
            <option value="exit">退出程序</option>
          </SelectInput>
        </label>
        <NumberSetting label="并行设置" tip={parameterHints.compareWorkers} value={settings.defaultCompareWorkers} min={1} max={8} onChange={settings.setDefaultCompareWorkers} />
        <label className="settings-toggle-row language-row">
          <ParameterHint label="界面语言" tip={parameterHints.appLanguage} />
          <SelectInput
            value={settings.appLanguage}
            onChange={(event) => settings.setAppLanguage(event.target.value as AppLanguage)}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </SelectInput>
        </label>
      </div>

      <div className="settings-resource-buttons" role="group" aria-label="运行环境与版本">
        <button className="settings-resource-button" type="button" onClick={() => setResourceDialog('about')}>
          <Info size={21} />
          <span><strong>关于与版本</strong><small>应用、框架与引擎信息</small></span>
        </button>
        <button className="settings-resource-button" type="button" onClick={() => { setResourceDialog('runtime'); void refreshRuntimeStatuses() }}>
          <PackageCheck size={21} />
          <span><strong>AI 运行环境</strong><small>Python / CUDA 环境</small></span>
          <ResourceStatusBadge state={resourceStatus(runtimeStatus?.ready, runtimeLoading)} />
        </button>
        <button className="settings-resource-button" type="button" onClick={() => setResourceDialog('clip-model')}>
          {modelStatus?.installed ? <CheckCircle2 size={21} /> : <PackageCheck size={21} />}
          <span><strong>离线 CLIP 模型</strong><small>{modelLoading ? '正在检测' : modelStatus?.installed ? '已安装，可离线运行' : '未安装'}</small></span>
          <ResourceStatusBadge state={resourceStatus(modelStatus?.installed, modelLoading || modelInstalling)} />
        </button>
        <button className="settings-resource-button" type="button" onClick={() => { setResourceDialog('merge'); void refreshRuntimeStatuses() }}>
          <Film size={21} />
          <span><strong>视频合并环境</strong><small>独立 FFmpeg / FFprobe</small></span>
          <ResourceStatusBadge state={resourceStatus(mergeRuntimeStatus?.ready, mergeRuntimeLoading)} />
        </button>
      </div>

      <SettingsResourceDialog open={resourceDialog === 'about'} title="关于与版本" icon={<Info size={21} />} onClose={() => setResourceDialog(null)}>
        <div className="settings-about-card">
          <div className="about-grid compact">
            <div><span>应用版本</span><strong title={`v${appInfo?.version ?? '0.1.0'}`}>v{appInfo?.version ?? '0.1.0'}</strong></div>
            <div><span>运行版本</span><strong>{appInfo?.buildFlavor === 'gpu' ? 'GPU / CUDA' : 'CPU'}</strong></div>
            <div><span>安装方式</span><strong>{appInfo?.installType === 'installed' ? '安装版' : '便携版'}</strong></div>
            <div><span>开发者</span><strong>RoamerFly</strong></div>
            <div><span>界面框架</span><strong title="桌面界面(Tauri + React)">桌面界面(Tauri + React)</strong></div>
            <div><span>核心引擎</span><strong title="Python 视频相似度引擎(Python Video Similarity Engine)">Python 视频相似度引擎(Python Video Similarity Engine)</strong></div>
          </div>
          <div className="about-project-links">
            <div className="about-project-heading">
              <Github size={18} />
              <div><span>开源项目</span><strong>video-similarity-detector</strong></div>
            </div>
            <p className="about-project-url" title={PROJECT_REPOSITORY_URL}>{PROJECT_REPOSITORY_URL}</p>
            <div className="about-project-actions">
              <NeonButton variant="outline" type="button" onClick={() => void handleOpenProjectPage(PROJECT_REPOSITORY_URL)}>
                <Github size={15} />
                项目主页
              </NeonButton>
              <NeonButton variant="outline" type="button" onClick={() => void handleOpenProjectPage(PROJECT_ISSUES_URL)}>
                <ExternalLink size={15} />
                问题反馈
              </NeonButton>
              <NeonButton variant="outline" type="button" onClick={() => void handleOpenProjectPage(PROJECT_LICENSE_URL)}>
                <ExternalLink size={15} />
                开源许可
              </NeonButton>
            </div>
            {aboutError ? <p className="inline-error about-project-error" role="alert">{aboutError}</p> : null}
          </div>
        </div>
      </SettingsResourceDialog>
      <SettingsResourceDialog open={resourceDialog === 'runtime'} title="AI 运行环境" icon={<PackageCheck size={21} />} onClose={closeResourceDialog}>
        <RuntimeSettingsCard onCompleted={runtimeCompleted} />
      </SettingsResourceDialog>
      <SettingsResourceDialog open={resourceDialog === 'clip-model'} title="离线 CLIP 模型" icon={modelStatus?.installed ? <CheckCircle2 size={21} /> : <PackageCheck size={21} />} onClose={closeResourceDialog}>
        <ClipModelSettingsCard
          status={modelStatus}
          loading={modelLoading}
          checking={modelChecking}
          installing={modelInstalling}
          progress={modelProgress}
          error={modelError}
          missingFiles={modelMissingFiles}
          progressValue={modelProgressValue}
          onRefresh={() => void refreshClipModelStatus()}
          onInstall={() => void handleInstallClipModel()}
          onCancel={() => void handleCancelClipModel()}
        />
      </SettingsResourceDialog>
      <SettingsResourceDialog open={resourceDialog === 'merge'} title="视频合并环境" icon={<Film size={21} />} onClose={closeResourceDialog}>
        <MergeRuntimeSettingsCard onCompleted={mergeRuntimeCompleted} />
      </SettingsResourceDialog>
    </div>
    </Translated>
  )
}

type ResourceStatus = 'installed' | 'missing' | 'checking'

function resourceStatus(ready: boolean | undefined, loading: boolean): ResourceStatus {
  if (loading || ready === undefined) return 'checking'
  return ready ? 'installed' : 'missing'
}

function ResourceStatusBadge({ state }: { state: ResourceStatus }) {
  const label = state === 'installed' ? '已安装' : state === 'missing' ? '缺失' : '检测中'
  return <span className={`settings-resource-status ${state}`}>{label}</span>
}

function ClipModelSettingsCard({
  status,
  loading,
  checking,
  installing,
  progress,
  error,
  missingFiles,
  progressValue,
  onRefresh,
  onInstall,
  onCancel,
}: {
  status: ClipModelStatus | null
  loading: boolean
  checking: boolean
  installing: boolean
  progress: UpdateDownloadProgress | null
  error: string
  missingFiles: string[]
  progressValue: number
  onRefresh: () => void
  onInstall: () => void
  onCancel: () => void
}) {
  const canCancel = installing && clipModelProgressCanCancel(progress?.stage || '')
  return (
    <div className="settings-about-card">
      <div className="about-grid compact">
        <div><span>安装状态</span><strong>{loading ? '检测中' : status?.installed ? '已安装' : '未安装'}</strong></div>
        <div><span>模型大小</span><strong>{status?.sizeBytes ? formatBytes(status.sizeBytes) : '未检测到'}</strong></div>
      </div>
      {status?.modelDir ? <p className="update-install-path" title={status.modelDir}>模型目录：{status.modelDir}</p> : null}
      <p className={error ? 'inline-error update-status-copy' : 'update-status-copy'}>{error || (checking ? '正在检查更新' : status?.message || '正在检测离线模型状态。')}</p>
      {missingFiles.length > 0 ? <p className="update-install-path">缺失文件：{missingFiles.join(', ')}</p> : null}
      {progress && (
        <div className="update-progress-block">
          <div><span>{progress.stage || '正在处理模型'}</span><strong>{progressValue.toFixed(0)}%</strong></div>
          <div className="update-progress-track"><span style={{ width: `${progressValue}%` }} /></div>
          <small>{formatBytes(progress.downloadedBytes)}{progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}</small>
        </div>
      )}
      <div className="settings-path-actions">
        <NeonButton variant="outline" type="button" onClick={onRefresh} disabled={loading || installing || checking}>
          <RefreshCw size={17} />刷新
        </NeonButton>
        <NeonButton
          variant={installing || checking ? 'outline' : 'primary'}
          type="button"
          onClick={installing && canCancel ? onCancel : onInstall}
          disabled={checking || (installing && !canCancel)}
        >
          {checking ? <RefreshCw size={17} className="spin-slow" /> : installing && canCancel ? <CircleStop size={17} /> : installing ? <RefreshCw size={17} className="spin-slow" /> : <Download size={17} />}
          {checking ? '正在检查更新' : installing && canCancel ? '取消下载' : installing ? '正在安装模型' : '重装/更新环境'}
        </NeonButton>
      </div>
    </div>
  )
}

function SettingsResourceDialog({
  open,
  title,
  icon,
  children,
  onClose,
}: {
  open: boolean
  title: string
  icon: ReactNode
  children: ReactNode
  onClose: () => void
}) {
  if (!open) return null
  return createPortal(
    <Translated>
      <div
        className="modal-backdrop settings-resource-dialog-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <section className="settings-resource-dialog" role="dialog" aria-modal="true" aria-label={title}>
          <div className="settings-resource-dialog-head">
            <div className="about-title">{icon}<h3>{title}</h3></div>
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
          </div>
          <div className="settings-resource-dialog-body">{children}</div>
        </section>
      </div>
    </Translated>,
    document.body,
  )
}

function UpdateDialog({
  open,
  appInfo,
  proxyUrl,
  onClose,
}: {
  open: boolean
  appInfo: AppInfo | null
  proxyUrl: string
  onClose: () => void
}) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(() => getDownloadTaskSnapshot('update').active)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(() => getDownloadTaskSnapshot('update').progress)
  const [error, setError] = useState(() => getDownloadTaskSnapshot('update').error)
  const updateOperationRef = useRef(0)
  const updateStatusRequestRef = useRef(0)

  const handleCheckUpdate = useCallback(async () => {
    if (getDownloadTaskSnapshot('update').active) return
    setChecking(true)
    setError('')
    setUpdate(null)
    setProgress(null)
    try {
      setUpdate(await checkForUpdates(proxyUrl))
    } catch (err) {
      setError(normalizeBackendError(err))
    } finally {
      setChecking(false)
    }
  }, [proxyUrl])

  const syncUpdateDownloadStatus = useCallback(async () => {
    const request = updateStatusRequestRef.current + 1
    updateStatusRequestRef.current = request
    try {
      const status = await queryDownloadTaskStatus('update')
      if (!status || request !== updateStatusRequestRef.current) return
      const currentSnapshot = getDownloadTaskSnapshot('update')
      // The updater can answer one last `running` snapshot while the native
      // installer has already been launched. Never let that stale response
      // turn the completed action back into a second cancellable download.
      if (currentSnapshot.terminal === 'success' && status.running === true) return
      const settled = downloadStatusHasSettled('update', status)
      const active = status.running === true || (currentSnapshot.active && !settled)
      const nextProgress = progressFromDownloadStatus(status)
      setDownloadTaskSnapshot('update', {
        active,
        progress: nextProgress.stage ? nextProgress : currentSnapshot.progress,
        terminal: settled ? downloadStatusTerminal('update', status) || undefined : active ? undefined : currentSnapshot.terminal,
      })
      setInstalling(active)
      if (nextProgress.stage) setProgress(nextProgress)
    } catch {
      // Older backends do not expose a status query.  Event updates and the
      // download promise continue to provide the normal behavior there.
    }
  }, [])

  useEffect(() => {
    let active = true
    let stop = () => undefined
    void listenUpdateDownloadProgress((payload) => {
      if (!active) return
      const terminal = downloadProgressIsTerminal('update', payload)
      const generation = getDownloadTaskSnapshot('update').generation
      setDownloadTaskSnapshot('update', {
        // 100% can mean verified/downloaded, not that the updater has
        // stopped. Wait for the status endpoint before enabling "立即更新".
        active: true,
        progress: payload,
        error: '',
        terminal: undefined,
      })
      setProgress(payload)
      setInstalling(true)
      if (terminal) {
        const expected = /取消/.test(payload.stage) ? 'cancelled' : /失败|错误/.test(payload.stage) ? 'failed' : 'success'
        void waitForDownloadTaskSettlement('update', expected).then((finalStatus) => {
          if (!active || !isCurrentDownloadGeneration('update', generation) || !finalStatus) return
          if (!downloadStatusHasSettled('update', finalStatus, expected)) return
          const settledProgress = progressFromDownloadStatus(finalStatus)
          const finalProgress = settledProgress.stage ? settledProgress : payload
          setProgress(finalProgress)
          setDownloadTaskSnapshot('update', { active: false, progress: finalProgress, error: '', terminal: expected })
          setInstalling(false)
        })
      }
    })
      .then((unlisten) => {
        if (!active) unlisten()
        else stop = unlisten
      })
      .catch((err) => {
        if (active) setError(normalizeBackendError(err))
      })
    return () => {
      active = false
      stop()
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const checkTimer = window.setTimeout(() => {
      void syncUpdateDownloadStatus()
      if (!getDownloadTaskSnapshot('update').active) void handleCheckUpdate()
    }, 0)
    const statusTimer = window.setInterval(() => void syncUpdateDownloadStatus(), 1000)
    return () => {
      window.clearTimeout(checkTimer)
      window.clearInterval(statusTimer)
    }
  }, [handleCheckUpdate, open, syncUpdateDownloadStatus])

  async function handleInstallUpdate() {
    if (!update?.canAutoInstall || installing) return
    const confirmed = window.confirm(
      `将下载 ${update.buildFlavor.toUpperCase()} 安装包，完成后自动退出并覆盖安装到：\n${update.installRoot}\n\n数据、报告、缓存和设置不会被删除。是否继续？`,
    )
    if (!confirmed) return
    const operation = updateOperationRef.current + 1
    updateOperationRef.current = operation
    const generation = beginDownloadTask('update')
    updateStatusRequestRef.current += 1
    setInstalling(true)
    setDownloadTaskSnapshot('update', { active: true, error: '', terminal: undefined })
    setError('')
    const initialProgress = {
      downloadedBytes: 0,
      totalBytes: update.assetSize,
      progress: 0,
      stage: '正在连接 GitHub Releases',
    }
    setProgress(initialProgress)
    setDownloadTaskSnapshot('update', { progress: initialProgress })
    try {
      await downloadAndInstallUpdate(proxyUrl)
      if (operation !== updateOperationRef.current || !isCurrentDownloadGeneration('update', generation)) return
      const completedProgress: UpdateDownloadProgress = {
        ...(getDownloadTaskSnapshot('update').progress || initialProgress),
        progress: 100,
        stage: '更新已安装，等待应用重启',
      }
      setProgress(completedProgress)
      setError('')
      setUpdate((current) => current
        ? { ...current, message: '更新已安装，等待应用重启。' }
        : current)
      setDownloadTaskSnapshot('update', {
        active: true,
        progress: completedProgress,
        error: '',
        terminal: undefined,
      })
      const finalStatus = await waitForDownloadTaskSettlement('update', 'success')
      if (operation !== updateOperationRef.current || !isCurrentDownloadGeneration('update', generation)) return
      if (finalStatus && downloadStatusHasSettled('update', finalStatus, 'success')) {
        const settledProgress = progressFromDownloadStatus(finalStatus)
        const finalProgress = settledProgress.stage ? settledProgress : completedProgress
        setProgress(finalProgress)
        setInstalling(false)
        setDownloadTaskSnapshot('update', { active: false, progress: finalProgress, error: '', terminal: 'success' })
      }
    } catch (err) {
      if (operation !== updateOperationRef.current || !isCurrentDownloadGeneration('update', generation)) return
      const message = normalizeBackendError(err)
      const finalStatus = await waitForDownloadTaskSettlement('update')
      if (!finalStatus || finalStatus.running || !downloadStatusHasSettled('update', finalStatus)) {
        if (finalStatus?.stage) setProgress(progressFromDownloadStatus(finalStatus))
        setInstalling(true)
        setDownloadTaskSnapshot('update', { active: true, error: message })
        return
      }
      const terminal = downloadStatusTerminal('update', finalStatus)
      const cancelled = terminal === 'cancelled'
      setInstalling(false)
      setDownloadTaskSnapshot('update', {
        active: false,
        error: cancelled || terminal === 'success' ? '' : message,
        terminal: terminal || 'failed',
      })
      setError(cancelled || terminal === 'success' ? '' : message)
      if (cancelled) {
        const cancelledProgress = {
          ...(getDownloadTaskSnapshot('update').progress || initialProgress),
          stage: '更新下载已取消',
        }
        setProgress(cancelledProgress)
        setDownloadTaskSnapshot('update', { progress: cancelledProgress })
      }
    }
  }

  async function handleCancelUpdate() {
    if (!getDownloadTaskSnapshot('update').active) return
    updateOperationRef.current += 1
    updateStatusRequestRef.current += 1
    try {
      await cancelUpdateDownload()
      const finalStatus = await waitForDownloadTaskSettlement('update')
      const cancelledProgress: UpdateDownloadProgress = {
        ...(getDownloadTaskSnapshot('update').progress || {
          downloadedBytes: 0,
          totalBytes: 0,
          progress: 0,
        }),
        stage: '更新下载已取消',
      }
      if (finalStatus) {
        const settledProgress = progressFromDownloadStatus(finalStatus)
        cancelledProgress.downloadedBytes = settledProgress.downloadedBytes
        cancelledProgress.totalBytes = settledProgress.totalBytes
        cancelledProgress.progress = settledProgress.progress
      }
      if (!finalStatus || finalStatus.running || !downloadStatusHasSettled('update', finalStatus)) {
        const pendingProgress = {
          ...(getDownloadTaskSnapshot('update').progress || cancelledProgress),
          stage: '正在取消更新下载',
        }
        setInstalling(true)
        setProgress(pendingProgress)
        setDownloadTaskSnapshot('update', { active: true, progress: pendingProgress })
        return
      }
      const terminal = downloadStatusTerminal('update', finalStatus)
      setProgress(cancelledProgress)
      setDownloadTaskSnapshot('update', { active: false, progress: cancelledProgress, error: '', terminal: terminal || 'cancelled' })
      setInstalling(false)
    } catch (err) {
      const message = normalizeBackendError(err)
      setError(message)
      setDownloadTaskSnapshot('update', { error: message })
    }
  }

  const statusText = checking
    ? '正在连接 GitHub Releases，请稍候...'
    : error || update?.message || '打开窗口后会自动检查，也可以点击下方按钮重试。'
  const currentVersion = update?.currentVersion || appInfo?.version || '0.1.0'
  const targetVersion = update?.latestVersion || currentVersion
  const installProgress = Math.max(0, Math.min(100, progress?.progress || 0))
  const releaseNoteItems = useMemo(
    () => formatReleaseNotes(update?.releaseNotes || ''),
    [update?.releaseNotes],
  )
  const releaseNoteFallback = update
    ? update.updateAvailable
      ? '当前检查通道未返回发布说明，可打开发布页查看完整更新内容。'
      : '当前版本没有新的发布说明。'
    : checking
      ? '正在读取最新版本信息...'
      : '完成检查后会在这里显示新版本更新内容。'

  if (!open) return null

  return createPortal(
    <Translated>
    <div className="modal-backdrop cache-cleanup-backdrop settings-update-backdrop" role="presentation">
      <section className="cache-cleanup-dialog settings-update-dialog" role="dialog" aria-modal="true" aria-label="检查更新">
        <div className="cache-cleanup-head settings-update-dialog-head">
          <div className="about-title">
            <Download size={24} />
            <h3>检查更新</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭检查更新">
            <X size={18} />
          </button>
        </div>
        <div className="settings-update-card">
      <div className="update-version-line">
        <span>当前 v{currentVersion}</span>
        <strong>{update?.updateAvailable ? `可更新至 v${targetVersion}` : `${appInfo?.buildFlavor === 'gpu' ? 'GPU' : 'CPU'} 版`}</strong>
      </div>
      {update && (
        <div className="update-meta-grid">
          <div>
            <span>目标包</span>
            <strong>{update.assetName || `${update.buildFlavor.toUpperCase()} 安装包`}</strong>
          </div>
          <div>
            <span>包大小</span>
            <strong>{update.assetSize > 0 ? formatBytes(update.assetSize) : '未获取'}</strong>
          </div>
          <div>
            <span>发布时间</span>
            <strong>{formatUpdatePublishedAt(update.publishedAt)}</strong>
          </div>
        </div>
      )}
      <p className={error ? 'inline-error update-status-copy' : 'update-status-copy'}>{statusText}</p>
      {(appInfo?.installRoot || update?.installRoot) && (
        <p className="update-install-path" title={update?.installRoot || appInfo?.installRoot}>
          安装位置：{update?.installRoot || appInfo?.installRoot}
        </p>
      )}
      <div className="update-release-notes">
        <div className="update-release-notes-head">
          <strong>新版本更新内容</strong>
          {update?.releaseUrl ? (
            <button type="button" onClick={() => void openReleasePage(update.releaseUrl)}>
              <ExternalLink size={14} />
              发布页
            </button>
          ) : null}
        </div>
        {releaseNoteItems.length ? (
          <div className="update-release-notes-body">
            {releaseNoteItems.map((item, index) => (
              item.kind === 'heading' ? (
                <h4 key={`${item.kind}-${index}`}>{item.text}</h4>
              ) : item.kind === 'bullet' ? (
                <p className="update-release-note-bullet" key={`${item.kind}-${index}`}>{item.text}</p>
              ) : (
                <p key={`${item.kind}-${index}`}>{item.text}</p>
              )
            ))}
          </div>
        ) : (
          <p className="update-release-notes-empty">{releaseNoteFallback}</p>
        )}
      </div>
      {installing && (
        <div className="update-progress-block">
          <div>
            <span>{progress?.stage || '正在准备更新'}</span>
            <strong>{installProgress.toFixed(0)}%</strong>
          </div>
          <div className="update-progress-track">
            <span style={{ width: `${installProgress}%` }} />
          </div>
          {progress?.totalBytes ? (
            <small>{formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)}</small>
          ) : null}
        </div>
      )}
      <div className="update-actions">
        <NeonButton
          variant="outline"
          type="button"
          onClick={() => void handleCheckUpdate()}
          disabled={checking || installing}
        >
          <RefreshCw size={17} className={checking ? 'spin-slow' : ''} />
          {checking ? '检查中' : '检查更新'}
        </NeonButton>
        {installing ? (
          <NeonButton
            type="button"
            onClick={() => void handleCancelUpdate()}
          >
            <CircleStop size={17} />
            取消下载
          </NeonButton>
        ) : update?.canAutoInstall ? (
          <NeonButton type="button" onClick={() => void handleInstallUpdate()} disabled={installing}>
            <Download size={17} />
            立即更新
          </NeonButton>
        ) : update?.updateAvailable && update.releaseUrl ? (
          <NeonButton variant="outline" type="button" onClick={() => void openReleasePage(update.releaseUrl)}>
            <ExternalLink size={17} />
            打开发布页
          </NeonButton>
        ) : null}
      </div>
      <small className="update-preserve-note">覆盖升级仅替换程序文件，保留 data、videos、embeddings、报告和界面设置。</small>
        </div>
      </section>
    </div>
    </Translated>,
    document.body,
  )
}

type ReleaseNoteItem = {
  kind: 'heading' | 'bullet' | 'paragraph'
  text: string
}

function formatReleaseNotes(notes: string): ReleaseNoteItem[] {
  const lines = notes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => cleanReleaseNoteLine(line))
    .filter(Boolean)
    .slice(0, 28)

  return lines.map((line) => {
    if (/^#{1,6}\s+/.test(line)) {
      return { kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') }
    }
    if (/^[-*]\s+/.test(line)) {
      return { kind: 'bullet', text: line.replace(/^[-*]\s+/, '') }
    }
    return { kind: 'paragraph', text: line }
  })
}

function cleanReleaseNoteLine(line: string) {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
}

function formatUpdatePublishedAt(value: string) {
  if (!value) return '未获取'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function AnalysisSettings({ onPresetSaved }: { onPresetSaved: (presetName: string) => void }) {
  const settings = useSettingsStore()
  const activePreset = settings.selectedAnalysisPreset
  const activePresetOption = analysisPresetOptions.find((preset) => preset.id === activePreset)
  const saveTargetPreset = activePreset === 'custom' ? settings.customAnalysisPresetSource : activePreset
  const saveTargetOption = analysisPresetOptions.find((preset) => preset.id === saveTargetPreset)
  const [analysisTemplates, setAnalysisTemplates] = useState<ConfigTemplateRecord<AnalysisPresetConfig>[]>([])
  const [selectedAnalysisTemplate, setSelectedAnalysisTemplate] = useState('')
  const [templateMessage, setTemplateMessage] = useState('')

  const refreshTemplates = useCallback(async () => {
    try {
      const analysis = await listConfigTemplates<AnalysisPresetConfig>('analysis', settings.projectRoot)
      setAnalysisTemplates(analysis)
      setSelectedAnalysisTemplate((current) => analysis.some((item) => item.id === current) ? current : (analysis[0]?.id ?? ''))
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }, [settings.projectRoot])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshTemplates(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshTemplates])

  async function saveAnalysisTemplate(template?: ConfigTemplateRecord<AnalysisPresetConfig>) {
    const name = template?.name ?? window.prompt('请输入分析配置模板名称：')?.trim()
    if (!name) return
    try {
      const saved = await saveConfigTemplate(
        'analysis',
        name,
        analysisPresetFromSettings(useSettingsStore.getState()),
        settings.projectRoot,
        template?.id,
      )
      await refreshTemplates()
      setSelectedAnalysisTemplate(saved.id)
      setTemplateMessage(`已保存分析模板“${saved.name}”`)
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }

  async function removeTemplate(kind: 'analysis' | 'error_tolerance', id: string, name: string) {
    if (!id || !window.confirm(`确认删除模板“${name}”吗？`)) return
    try {
      await deleteConfigTemplate(kind, id, settings.projectRoot)
      await refreshTemplates()
      setTemplateMessage(`已删除模板“${name}”`)
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }

  return (
    <Translated>
    <div className="settings-panel-grid analysis">
      <div className="analysis-preset-section">
        <div className="analysis-preset-row" aria-label="分析预设">
          {analysisPresetOptions.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={activePreset === preset.id ? 'analysis-preset-card active' : 'analysis-preset-card'}
              title={preset.tip}
              aria-pressed={activePreset === preset.id}
              onClick={() => settings.applyAnalysisPreset(preset.id)}
            >
              <span title={preset.tip}>{preset.name}</span>
              <strong title={preset.tip}>{preset.description}</strong>
              <small title={preset.tip}>
                {preset.id === 'duplicate_file'
                  ? preset.summary
                  : formatPresetSummary(settings.customAnalysisPresets[preset.id])}
              </small>
            </button>
          ))}
        </div>
        <div className="analysis-preset-actions">
          <p>
            选择预设后修改参数会先进入“自定义”。需要覆盖某个预设时，再点击右侧保存按钮。
          </p>
          <NeonButton
            variant="outline"
            type="button"
            disabled={activePreset === 'duplicate_file'}
            onClick={() => {
              settings.saveCurrentAnalysisPreset()
              onPresetSaved(saveTargetOption?.name ?? activePresetOption?.name ?? '当前')
            }}
          >
            <Save size={17} />
            保存到“{saveTargetOption?.name ?? activePresetOption?.name ?? '当前'}”
          </NeonButton>
        </div>
        <TemplateToolbar
          label="分析配置模板"
          templates={analysisTemplates}
          selectedId={selectedAnalysisTemplate}
          onSelect={setSelectedAnalysisTemplate}
          onSave={() => void saveAnalysisTemplate()}
          onOverwrite={() => {
            const template = analysisTemplates.find((item) => item.id === selectedAnalysisTemplate)
            if (template && window.confirm(`使用当前分析配置覆盖模板“${template.name}”吗？`)) {
              void saveAnalysisTemplate(template)
            }
          }}
          onLoad={() => {
            const template = analysisTemplates.find((item) => item.id === selectedAnalysisTemplate)
            if (!template) return
            settings.applyAnalysisTemplate(template.config)
            setTemplateMessage(`已读取分析模板“${template.name}”`)
          }}
          onDelete={() => {
            const template = analysisTemplates.find((item) => item.id === selectedAnalysisTemplate)
            if (template) void removeTemplate('analysis', template.id, template.name)
          }}
        />
        {templateMessage && <p className="settings-note template-message">{templateMessage}</p>}
      </div>

      {settings.analysisMode === 'duplicate_file' ? (
        <div className="duplicate-mode-note">
          <Info size={22} />
          <div>
            <strong>当前为“对比相同文件”模式</strong>
            <p>开始分析时会直接扫描视频目录，按文件内容指纹找出完全相同但路径不同的视频文件；不会抽帧，不会调用 Python 分析程序，也不会使用 GPU、阈值、窗口或分辨率参数。</p>
          </div>
        </div>
      ) : (
      <div className="settings-compact-grid two-column">
        <div className="param-slider-row compact">
          <ParameterHint label="跳帧阈值" tip={parameterHints.skipThreshold} />
          <TextInput value={settings.defaultSkipThreshold.toFixed(2)} readOnly />
          <Slider value={settings.defaultSkipThreshold} tone="pink" onChange={settings.setDefaultSkipThreshold} />
        </div>
        <div className="param-slider-row compact">
          <ParameterHint label="匹配阈值" tip={parameterHints.matchThreshold} />
          <TextInput value={settings.defaultMatchThreshold.toFixed(2)} readOnly />
          <Slider value={settings.defaultMatchThreshold} tone="purple" onChange={settings.setDefaultMatchThreshold} />
        </div>

        <NumberSetting label="时间窗口" tip={parameterHints.windowSize} value={settings.defaultWindowSize} onChange={settings.setDefaultWindowSize} suffix="秒" />
        <NumberSetting label="候选数(Top-K)" tip={parameterHints.topK} value={settings.defaultTopK} onChange={settings.setDefaultTopK} />
        <NumberSetting label="精确比较候选数" tip={parameterHints.candidateLimit} value={settings.defaultCandidateLimit} min={0} onChange={settings.setDefaultCandidateLimit} />
        <NumberSetting label="最大间隔" tip={parameterHints.maxGapSec} value={settings.defaultMaxGapSec} onChange={settings.setDefaultMaxGapSec} suffix="秒" />
        <NumberSetting label="扫描步长" tip={parameterHints.frameStep} value={settings.defaultFrameStep} min={1} onChange={settings.setDefaultFrameStep} />
        <NumberSetting label="最短片段" tip={parameterHints.minSegmentDuration} value={settings.defaultMinSegmentDuration} min={1} onChange={settings.setDefaultMinSegmentDuration} suffix="秒" />
        <NumberSetting label="最少匹配点" tip={parameterHints.minSegmentMatches} value={settings.defaultMinSegmentMatches} min={1} onChange={settings.setDefaultMinSegmentMatches} />
        <NumberSetting label="偏移容忍" tip={parameterHints.offsetTolerance} value={settings.defaultOffsetTolerance} min={1} onChange={settings.setDefaultOffsetTolerance} suffix="秒" />

        <label className="param-input-row">
          <ParameterHint label="运行设备" tip={parameterHints.device} />
          <SelectInput value={settings.defaultDevice} onChange={(event) => settings.setDefaultDevice(event.target.value as DeviceMode)}>
            <option value="auto">{withEnglish('自动', 'auto')}</option>
            <option value="cpu">{withEnglish('处理器', 'CPU')}</option>
            <option value="cuda">{withEnglish('显卡加速', 'CUDA')}</option>
          </SelectInput>
        </label>
        <label className="param-input-row">
          <ParameterHint label="缩放模式" tip={parameterHints.resizeMode} />
          <SelectInput value={settings.defaultResizeMode} onChange={(event) => settings.setDefaultResizeMode(event.target.value as ResizeMode)}>
            <option value="center_crop">{withEnglish('居中裁剪', 'center_crop')}</option>
            <option value="letterbox">{withEnglish('等比留边', 'letterbox')}</option>
          </SelectInput>
        </label>
        <NumberSetting label="匹配分辨率" tip={parameterHints.inputSize} value={settings.defaultInputSize} min={1} onChange={settings.setDefaultInputSize} />
        <label className="param-input-row">
          <ParameterHint label="竖屏旋转" tip={parameterHints.portraitRotation} />
          <SelectInput value={settings.defaultPortraitRotation} onChange={(event) => settings.setDefaultPortraitRotation(event.target.value as PortraitRotation)}>
            <option value="right_90">{withEnglish('右转 90 度', 'right_90')}</option>
            <option value="left_90">{withEnglish('左转 90 度', 'left_90')}</option>
          </SelectInput>
        </label>

        <label className="settings-toggle-row">
          <ParameterHint label="自动裁剪黑边" tip={parameterHints.cropBlackBorders} />
          <Toggle checked={settings.defaultCropBlackBorders} onChange={settings.setDefaultCropBlackBorders} />
        </label>
        <label className="settings-toggle-row">
          <ParameterHint label="强制重建缓存" tip={parameterHints.force} />
          <Toggle checked={settings.defaultForce} onChange={settings.setDefaultForce} />
        </label>
        <label className="settings-toggle-row">
          <ParameterHint label="启用早停加速" tip={parameterHints.earlyStop} />
          <Toggle checked={settings.defaultEarlyStop} onChange={settings.setDefaultEarlyStop} />
        </label>
      </div>
      )}
    </div>
    </Translated>
  )
}

function ErrorToleranceSettings({ onMessage }: { onMessage: (message: string) => void }) {
  const settings = useSettingsStore()
  const [templates, setTemplates] = useState<ConfigTemplateRecord<ErrorToleranceTemplateConfig>[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [templateMessage, setTemplateMessage] = useState('')

  const refreshTemplates = useCallback(async () => {
    try {
      const records = await listConfigTemplates<ErrorToleranceTemplateConfig>('error_tolerance', settings.projectRoot)
      setTemplates(records)
      setSelectedTemplate((current) => records.some((item) => item.id === current) ? current : (records[0]?.id ?? ''))
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }, [settings.projectRoot])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshTemplates(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshTemplates])

  function snapshot(): ErrorToleranceTemplateConfig {
    const current = useSettingsStore.getState()
    return {
      errorTolerancePreset: current.errorTolerancePreset,
      errorToleranceSevereLimit: current.errorToleranceSevereLimit,
      errorToleranceMissingPictureLimit: current.errorToleranceMissingPictureLimit,
      errorTolerancePreflightValidation: current.errorTolerancePreflightValidation,
    }
  }

  async function saveTemplate(template?: ConfigTemplateRecord<ErrorToleranceTemplateConfig>) {
    const name = template?.name ?? window.prompt('请输入错误容忍模板名称：')?.trim()
    if (!name) return
    try {
      const saved = await saveConfigTemplate(
        'error_tolerance',
        name,
        snapshot(),
        settings.projectRoot,
        template?.id,
      )
      await refreshTemplates()
      setSelectedTemplate(saved.id)
      setTemplateMessage(`已保存错误容忍模板“${saved.name}”`)
      onMessage(`已保存错误容忍模板“${saved.name}”`)
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }

  async function removeTemplate() {
    const template = templates.find((item) => item.id === selectedTemplate)
    if (!template || !window.confirm(`确认删除模板“${template.name}”吗？`)) return
    try {
      await deleteConfigTemplate('error_tolerance', template.id, settings.projectRoot)
      await refreshTemplates()
      setTemplateMessage(`已删除模板“${template.name}”`)
    } catch (error) {
      setTemplateMessage(normalizeBackendError(error))
    }
  }

  return (
    <Translated>
    <div className="settings-panel-grid error-tolerance-page">
      <div className="error-tolerance-heading">
        <div>
          <strong>错误容忍设置</strong>
          <p>控制码流异常达到什么程度时隔离视频。数值为 0 表示忽略该类可恢复告警；无法打开或没有有效画面仍会移出任务。</p>
        </div>
        <ParameterHint label="隔离策略" tip={parameterHints.errorTolerance} />
      </div>

      <div className="error-tolerance-options">
        {errorToleranceOptions.map((option) => (
          <button
            type="button"
            key={option.id}
            className={settings.errorTolerancePreset === option.id ? 'error-tolerance-card active' : 'error-tolerance-card'}
            aria-pressed={settings.errorTolerancePreset === option.id}
            title={`${option.description} ${option.effect}`}
            onClick={() => settings.setErrorTolerancePreset(option.id)}
          >
            <span>{option.name}</span>
            <strong>{option.description}</strong>
            <small>{option.effect}</small>
          </button>
        ))}
      </div>

      <div className="error-tolerance-parameter-grid">
        <NumberSetting
          label="严重码流错误上限"
          tip="Invalid NAL、NAL 单元拆分失败等严重错误累计达到该值后隔离；0 表示不按此类告警隔离。"
          value={settings.errorToleranceSevereLimit}
          min={0}
          onChange={settings.setErrorToleranceSevereLimit}
          suffix="条"
        />
        <NumberSetting
          label="缺失画面上限"
          tip="missing picture 告警累计达到该值后隔离；0 表示不按缺失画面告警隔离。"
          value={settings.errorToleranceMissingPictureLimit}
          min={0}
          onChange={settings.setErrorToleranceMissingPictureLimit}
          suffix="条"
        />
        <label className="settings-toggle-row">
          <ParameterHint label="分析前完整码流校验" tip="开启时先用 FFmpeg 完整读取视频码流，能更早发现损坏；关闭可加快启动，但错误可能在抽帧阶段才被发现。" />
          <Toggle checked={settings.errorTolerancePreflightValidation} onChange={settings.setErrorTolerancePreflightValidation} />
        </label>
        <div className="error-tolerance-live-summary">
          <span>当前模式</span>
          <strong>{settings.errorTolerancePreset === 'custom' ? '自定义' : errorToleranceOptions.find((item) => item.id === settings.errorTolerancePreset)?.name}</strong>
          <small>
            严重错误 {settings.errorToleranceSevereLimit || '忽略'} · 缺失画面 {settings.errorToleranceMissingPictureLimit || '忽略'} ·
            {settings.errorTolerancePreflightValidation ? ' 完整校验' : ' 跳过预检'}
          </small>
        </div>
      </div>

      <TemplateToolbar
        label="错误容忍模板"
        templates={templates}
        selectedId={selectedTemplate}
        onSelect={setSelectedTemplate}
        onSave={() => void saveTemplate()}
        onOverwrite={() => {
          const template = templates.find((item) => item.id === selectedTemplate)
          if (template && window.confirm(`使用当前错误容忍设置覆盖模板“${template.name}”吗？`)) {
            void saveTemplate(template)
          }
        }}
        onLoad={() => {
          const template = templates.find((item) => item.id === selectedTemplate)
          if (!template) return
          settings.setErrorTolerancePreset(template.config.errorTolerancePreset)
          const presetValues = useSettingsStore.getState()
          settings.applyErrorToleranceTemplate({
            errorTolerancePreset: template.config.errorTolerancePreset,
            errorToleranceSevereLimit: Number.isFinite(template.config.errorToleranceSevereLimit)
              ? template.config.errorToleranceSevereLimit
              : presetValues.errorToleranceSevereLimit,
            errorToleranceMissingPictureLimit: Number.isFinite(template.config.errorToleranceMissingPictureLimit)
              ? template.config.errorToleranceMissingPictureLimit
              : presetValues.errorToleranceMissingPictureLimit,
            errorTolerancePreflightValidation: typeof template.config.errorTolerancePreflightValidation === 'boolean'
              ? template.config.errorTolerancePreflightValidation
              : presetValues.errorTolerancePreflightValidation,
          })
          setTemplateMessage(`已读取错误容忍模板“${template.name}”`)
        }}
        onDelete={() => void removeTemplate()}
      />
      {templateMessage && <p className="settings-note template-message">{templateMessage}</p>}
    </div>
    </Translated>
  )
}

function VideoScanRangeSettings() {
  const settings = useSettingsStore()
  const filters = settings.videoScanFilters
  const enabled = new Set(filters.enabledKeys)

  function toggleFilter(key: VideoScanFilterKey, checked: boolean) {
    const next = new Set(filters.enabledKeys)
    if (checked) next.add(key)
    else next.delete(key)
    settings.setVideoScanFilterKeys(videoScanFilterOptions.map((option) => option.id).filter((id) => next.has(id)))
  }

  return (
    <Translated>
    <div className="settings-panel-grid video-scan-page">
      <div className="video-scan-heading">
        <div>
          <strong>视频扫描范围</strong>
          <p>未勾选条件时扫描全部视频；勾选后仅扫描并处理匹配条件的视频。</p>
        </div>
        <div className="video-scan-summary">
          <span>当前范围</span>
          <strong>{filters.enabledKeys.length ? `${filters.enabledKeys.length} 个条件` : '全部视频'}</strong>
          <small title={formatVideoScanFilterSummary(filters.enabledKeys)}>{formatVideoScanFilterSummary(filters.enabledKeys)}</small>
        </div>
      </div>

      <div className="video-scan-filter-options" aria-label="视频扫描条件">
        {videoScanFilterOptions.map((option) => (
          <label className={enabled.has(option.id) ? 'video-scan-filter-card active' : 'video-scan-filter-card'} key={option.id}>
            <input
              type="checkbox"
              checked={enabled.has(option.id)}
              onChange={(event) => toggleFilter(option.id, event.target.checked)}
            />
            <span>{option.name}</span>
            <small>{option.summary}</small>
          </label>
        ))}
      </div>

      <div className="video-scan-parameter-grid">
        <section className={enabled.has('size') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <div className="video-scan-card-title">
            <h4>文件大小</h4>
            <VideoScanUnitSelect
              ariaLabel="文件大小单位"
              disabled={!enabled.has('size')}
              options={videoScanSizeUnitOptions}
              value={filters.sizeUnit}
              onChange={(value) => settings.setVideoScanFilterValue('sizeUnit', value)}
            />
          </div>
          <div className="video-scan-range-row">
            <VideoScanNumberSetting
              label="最小"
              value={filters.minSizeGb}
              min={0}
              disabled={!enabled.has('size')}
              onChange={(value) => settings.setVideoScanFilterValue('minSizeGb', value)}
            />
            <VideoScanNumberSetting
              label="最大"
              value={filters.maxSizeGb}
              min={0}
              disabled={!enabled.has('size')}
              onChange={(value) => settings.setVideoScanFilterValue('maxSizeGb', value)}
            />
          </div>
        </section>

        <section className={enabled.has('name') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <h4>名称匹配</h4>
          <label className="param-input-row">
            <ParameterHint label="名称前缀" tip="多个前缀可用逗号、空格或换行分隔。" />
            <TextInput
              value={filters.namePrefixes}
              disabled={!enabled.has('name')}
              placeholder="movie_, sample_"
              onChange={(event) => settings.setVideoScanFilterValue('namePrefixes', event.target.value)}
            />
          </label>
          <label className="param-input-row">
            <ParameterHint label="名称包含" tip="多个关键词可用逗号、空格或换行分隔。" />
            <TextInput
              value={filters.nameIncludes}
              disabled={!enabled.has('name')}
              placeholder="1080p, 完整版"
              onChange={(event) => settings.setVideoScanFilterValue('nameIncludes', event.target.value)}
            />
          </label>
          <label className="param-input-row">
            <ParameterHint label="正则表达式" tip="使用正则表达式精确匹配文件名，如：.*movie.*" />
            <TextInput
              value={filters.nameRegex}
              disabled={!enabled.has('name')}
              placeholder="^video_[0-9]+\.mp4$"
              onChange={(event) => settings.setVideoScanFilterValue('nameRegex', event.target.value)}
            />
          </label>
          <label className="param-input-row">
            <ParameterHint label="排除名称" tip="多个排除词可用逗号、空格或换行分隔。名称中包含这些词的视频将被忽略。" />
            <TextInput
              value={filters.nameExclude}
              disabled={!enabled.has('name')}
              placeholder="temp, backup"
              onChange={(event) => settings.setVideoScanFilterValue('nameExclude', event.target.value)}
            />
          </label>
        </section>

        <section className={enabled.has('duration') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <div className="video-scan-card-title">
            <h4>时长</h4>
            <VideoScanUnitSelect
              ariaLabel="时长单位"
              disabled={!enabled.has('duration')}
              options={videoScanDurationUnitOptions}
              value={filters.durationUnit}
              onChange={(value) => settings.setVideoScanFilterValue('durationUnit', value)}
            />
          </div>
          <div className="video-scan-range-row">
            <VideoScanNumberSetting
              label="最短"
              value={filters.minDurationSec}
              min={0}
              disabled={!enabled.has('duration')}
              onChange={(value) => settings.setVideoScanFilterValue('minDurationSec', value)}
            />
            <VideoScanNumberSetting
              label="最长"
              value={filters.maxDurationSec}
              min={0}
              disabled={!enabled.has('duration')}
              onChange={(value) => settings.setVideoScanFilterValue('maxDurationSec', value)}
            />
          </div>
        </section>

        <section className={enabled.has('resolution') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <h4>
            <ParameterHint
              label="分辨率"
              tip="常用分辨率：480p = 854×480；720p = 1280×720；1080p = 1920×1080；1440p / 2K = 2560×1440；2160p / 4K = 3840×2160；竖屏 1080p = 1080×1920。"
            />
          </h4>
          <div className="video-scan-resolution-grid">
            <VideoScanNumberSetting label="最小宽" value={filters.minWidth} min={0} suffix="px" integer disabled={!enabled.has('resolution')} onChange={(value) => settings.setVideoScanFilterValue('minWidth', value)} />
            <VideoScanNumberSetting label="最小高" value={filters.minHeight} min={0} suffix="px" integer disabled={!enabled.has('resolution')} onChange={(value) => settings.setVideoScanFilterValue('minHeight', value)} />
            <VideoScanNumberSetting label="最大宽" value={filters.maxWidth} min={0} suffix="px" integer disabled={!enabled.has('resolution')} onChange={(value) => settings.setVideoScanFilterValue('maxWidth', value)} />
            <VideoScanNumberSetting label="最大高" value={filters.maxHeight} min={0} suffix="px" integer disabled={!enabled.has('resolution')} onChange={(value) => settings.setVideoScanFilterValue('maxHeight', value)} />
          </div>
        </section>

        <section className={enabled.has('fps') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <h4>
            <ParameterHint
              label="帧率"
              tip="常用帧率：23.976 / 24、25、29.97 / 30、50、59.94 / 60、119.88 / 120 fps。筛选小数帧率时，建议在目标值上下保留约 0.5 fps 容差。"
            />
          </h4>
          <div className="video-scan-range-row">
            <VideoScanNumberSetting
              label="最低"
              value={filters.minFps}
              min={0}
              suffix="fps"
              disabled={!enabled.has('fps')}
              onChange={(value) => settings.setVideoScanFilterValue('minFps', value)}
            />
            <VideoScanNumberSetting
              label="最高"
              value={filters.maxFps}
              min={0}
              suffix="fps"
              disabled={!enabled.has('fps')}
              onChange={(value) => settings.setVideoScanFilterValue('maxFps', value)}
            />
          </div>
        </section>

        <section className="video-scan-parameter-card">
          <h4>结果排序</h4>
          <div className="video-scan-sort-grid">
            <label className="param-input-row">
              <ParameterHint label="排序依据" tip="扫描完成后按所选参数排序；选择时长、帧率或分辨率时会读取视频元数据。" />
              <SelectInput
                value={filters.sortBy}
                onChange={(event) => settings.setVideoScanFilterValue('sortBy', event.target.value as VideoScanSortBy)}
              >
                {videoScanSortByOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </SelectInput>
            </label>
            <label className="param-input-row">
              <ParameterHint label="排序方式" tip="升序从小到大 / A 到 Z；降序反向排列。" />
              <SelectInput
                value={filters.sortDirection}
                onChange={(event) => settings.setVideoScanFilterValue('sortDirection', event.target.value as VideoScanSortDirection)}
              >
                {videoScanSortDirectionOptions.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </SelectInput>
            </label>
          </div>
        </section>

        <section className={enabled.has('extension') ? 'video-scan-parameter-card' : 'video-scan-parameter-card disabled'}>
          <h4>格式</h4>
          <label className="param-input-row">
            <ParameterHint label="扩展名" tip="多个扩展名可用逗号、空格或换行分隔；可写 mp4 或 .mp4。" />
            <TextInput
              value={filters.extensions}
              disabled={!enabled.has('extension')}
              placeholder="mp4, mkv, mov"
              onChange={(event) => settings.setVideoScanFilterValue('extensions', event.target.value)}
            />
          </label>
        </section>

        <section className="video-scan-parameter-card">
          <h4>性能设置</h4>
          <label className="param-input-row">
            <ParameterHint label="分批探测大小" tip="分批读取视频元数据以节省内存。遇到含有数千视频的文件夹时可避免一次性加载过慢或崩溃。" />
            <VideoScanNumberSetting
              label="每批个数"
              value={filters.metadataBatchSize ?? 50}
              min={1}
              integer
              onChange={(value) => settings.setVideoScanFilterValue('metadataBatchSize', Number(value) || 50)}
            />
          </label>
        </section>
      </div>
    </div>
    </Translated>
  )
}

function formatVideoScanFilterSummary(keys: VideoScanFilterKey[]) {
  if (keys.length === 0) return 'all'
  return videoScanFilterOptions
    .filter((option) => keys.includes(option.id))
    .map((option) => option.name)
    .join(' / ')
}

function TemplateToolbar<T>({
  label,
  templates,
  selectedId,
  onSelect,
  onSave,
  onOverwrite,
  onLoad,
  onDelete,
}: {
  label: string
  templates: ConfigTemplateRecord<T>[]
  selectedId: string
  onSelect: (id: string) => void
  onSave: () => void
  onOverwrite: () => void
  onLoad: () => void
  onDelete: () => void
}) {
  return (
    <Translated>
    <div className="config-template-toolbar">
      <span>
        <BookOpen size={16} />
        {label}
      </span>
      <SelectInput value={selectedId} onChange={(event) => onSelect(event.target.value)}>
        <option value="">{templates.length ? '选择模板' : '暂无自定义模板'}</option>
        {templates.map((template) => (
          <option value={template.id} key={template.id}>{template.name}</option>
        ))}
      </SelectInput>
      <NeonButton variant="outline" type="button" onClick={onSave}>
        <Save size={16} />
        存为模板
      </NeonButton>
      <NeonButton variant="ghost" type="button" disabled={!selectedId} onClick={onLoad}>
        读取
      </NeonButton>
      <NeonButton variant="ghost" type="button" disabled={!selectedId} onClick={onOverwrite}>
        覆盖
      </NeonButton>
      <button className="template-delete-button" type="button" disabled={!selectedId} onClick={onDelete} title="删除所选模板">
        <Trash2 size={16} />
      </button>
    </div>
    </Translated>
  )
}

function PathSetting({
  label,
  tip,
  value,
  onChange,
  onChoose,
}: {
  label: string
  tip: string
  value: string
  onChange: (value: string) => void
  onChoose: () => Promise<void>
}) {
  return (
    <Translated>
    <label className="settings-row">
      <ParameterHint label={label} tip={tip} />
      <TextInput value={value} onChange={(event) => onChange(event.target.value)} />
      <NeonButton variant="outline" type="button" onClick={() => void onChoose()}>
        <FolderOpen size={17} />
        选择目录
      </NeonButton>
    </label>
    </Translated>
  )
}

function ReadOnlyPathSetting({
  label,
  tip,
  value,
}: {
  label: string
  tip: string
  value: string
}) {
  return (
    <Translated>
    <label className="settings-row settings-row-readonly">
      <ParameterHint label={label} tip={tip} />
      <TextInput value={value || '未检测到项目目录'} readOnly title={value} />
      <span className="readonly-path-tag" title="项目目录由程序运行位置决定，不能手动编辑。">自动</span>
    </label>
    </Translated>
  )
}

function NumberSetting({
  label,
  tip,
  value,
  min,
  max,
  suffix,
  disabled,
  onChange,
}: {
  label: string
  tip: string
  value: number
  min?: number
  max?: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <Translated>
    <label className="param-input-row">
      <ParameterHint label={label} tip={tip} />
      <div className={suffix ? 'number-suffix' : undefined}>
        <TextInput
          type="number"
          min={min}
          max={max}
          value={draft ?? formatNumberSettingValue(value)}
          disabled={disabled}
          onFocus={() => setDraft(formatNumberSettingValue(value))}
          onChange={(event) => {
            const raw = event.target.value
            setDraft(raw)
            if (raw.trim() === '') return
            const numeric = Number(raw)
            if (Number.isFinite(numeric)) onChange(clampNumber(raw, min, max, value))
          }}
          onBlur={() => {
            const raw = draft ?? formatNumberSettingValue(value)
            setDraft(null)
            if (raw.trim() === '') return
            const numeric = Number(raw)
            if (!Number.isFinite(numeric)) return
            const next = clampNumber(raw, min, max, value)
            onChange(next)
          }}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </label>
    </Translated>
  )
}

function formatNumberSettingValue(value: number | undefined) {
  return Number.isFinite(value) ? String(value) : ''
}

function VideoScanUnitSelect<T extends string>({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string
  value: T
  options: Array<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <Translated>
    <label className="video-scan-unit-select" aria-label={ariaLabel} title={ariaLabel}>
      <SelectInput value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </SelectInput>
    </label>
    </Translated>
  )
}

function VideoScanNumberSetting({
  label,
  value,
  min,
  max,
  suffix,
  integer,
  disabled,
  onChange,
}: {
  label: string
  value: VideoScanNumericValue
  min?: number
  max?: number
  suffix?: string
  integer?: boolean
  disabled?: boolean
  onChange: (value: VideoScanNumericValue) => void
}) {
  return (
    <Translated>
    <label className="param-input-row">
      <ParameterHint label={label} tip="0 表示不限。" />
      <div className={suffix ? 'number-suffix' : undefined}>
        <TextInput
          type="number"
          min={min}
          max={max}
          step={integer ? 1 : 0.1}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(parseOptionalScanNumber(event.target.value, min, max, integer))}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </label>
    </Translated>
  )
}

function parseOptionalScanNumber(value: string, min: number | undefined, max: number | undefined, integer?: boolean): VideoScanNumericValue {
  if (value.trim() === '') return ''
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  const clamped = Math.max(min ?? Number.NEGATIVE_INFINITY, Math.min(max ?? Number.POSITIVE_INFINITY, numeric))
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100
}

function clampNumber(value: string, min: number | undefined, max: number | undefined, fallback: number) {
  const numeric = Math.round(Number(value))
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min ?? Number.NEGATIVE_INFINITY, Math.min(max ?? Number.POSITIVE_INFINITY, numeric))
}

function buildEnvironmentConfigKey(pythonPath: string, projectRoot: string, reportDir: string) {
  return [pythonPath, projectRoot, reportDir].join('|')
}

function formatPresetSummary(preset: AnalysisPresetConfig) {
  const candidate = preset.defaultCandidateLimit === 0 ? '全部比较' : `粗筛 ${preset.defaultCandidateLimit}`
  return `${candidate} / 步长 ${preset.defaultFrameStep} / Top-K ${preset.defaultTopK}`
}

function buildSettingsSignature(settings: SettingsSnapshot) {
  return JSON.stringify({
    pythonPath: settings.pythonPath,
    projectRoot: settings.projectRoot,
    videoDir: settings.videoDir,
    cacheDir: settings.cacheDir,
    reportDir: settings.reportDir,
    networkProxy: settings.networkProxy,
    defaultSkipThreshold: settings.defaultSkipThreshold,
    defaultMatchThreshold: settings.defaultMatchThreshold,
    defaultWindowSize: settings.defaultWindowSize,
    defaultTopK: settings.defaultTopK,
    defaultCandidateLimit: settings.defaultCandidateLimit,
    defaultMaxGapSec: settings.defaultMaxGapSec,
    defaultFrameStep: settings.defaultFrameStep,
    defaultMinSegmentDuration: settings.defaultMinSegmentDuration,
    defaultMinSegmentMatches: settings.defaultMinSegmentMatches,
    defaultOffsetTolerance: settings.defaultOffsetTolerance,
    defaultCropBlackBorders: settings.defaultCropBlackBorders,
    defaultResizeMode: settings.defaultResizeMode,
    defaultInputSize: settings.defaultInputSize,
    defaultPortraitRotation: settings.defaultPortraitRotation,
    defaultForce: settings.defaultForce,
    defaultEarlyStop: settings.defaultEarlyStop,
    defaultDevice: settings.defaultDevice,
    errorTolerancePreset: settings.errorTolerancePreset,
    errorToleranceSevereLimit: settings.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: settings.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: settings.errorTolerancePreflightValidation,
    checkEnvOnStartup: settings.checkEnvOnStartup,
    openMaximized: settings.openMaximized,
    closeBehavior: settings.closeBehavior,
    appLanguage: settings.appLanguage,
    defaultCompareWorkers: settings.defaultCompareWorkers,
    analysisMode: settings.analysisMode,
    selectedAnalysisPreset: settings.selectedAnalysisPreset,
    customAnalysisPresetSource: settings.customAnalysisPresetSource,
    customAnalysisPresets: settings.customAnalysisPresets,
    customErrorTolerance: settings.customErrorTolerance,
    videoScanFilters: settings.videoScanFilters,
  })
}
