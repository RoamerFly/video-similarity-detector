import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSearch,
  FolderOpen,
  Info,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Save,
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
import {
  checkPythonEnv,
  checkForUpdates,
  clearCacheItems,
  deleteConfigTemplate,
  downloadAndInstallUpdate,
  formatBytes,
  getAppInfo,
  listConfigTemplates,
  listenUpdateDownloadProgress,
  normalizeBackendError,
  openReleasePage,
  scanCache,
  saveConfigTemplate,
  selectOutputDirectory,
  selectPythonExecutable,
  selectVideoDirectory,
  type AppInfo,
  type CacheScanResult,
  type ConfigTemplateRecord,
  type UpdateDownloadProgress,
  type UpdateInfo,
} from '@/services/backend'
import { useEnvironmentStore } from '@/stores/environmentStore'
import { analysisPresetFromSettings, settingsSnapshotFromState, useSettingsStore } from '@/stores/settingsStore'
import type { AnalysisPresetConfig, AnalysisPresetId, CloseBehavior, DeviceMode, ErrorTolerancePreset, PortraitRotation, ResizeMode, SettingsSnapshot } from '@/types/config'
import { parameterHints, withEnglish } from '@/utils/parameterHints'

type SettingsTab = 'base' | 'analysis' | 'error_tolerance'

interface ErrorToleranceTemplateConfig {
  errorTolerancePreset: ErrorTolerancePreset
  errorToleranceSevereLimit: number
  errorToleranceMissingPictureLimit: number
  errorTolerancePreflightValidation: boolean
}

const analysisPresetOptions: Array<{
  id: AnalysisPresetId
  name: string
  description: string
  summary: string
  tip: string
}> = [
  {
    id: 'ultra_fast',
    name: '极速',
    description: '极限压缩抽帧和匹配量，只做粗筛。',
    summary: '粗筛 6 / 步长 30 / Top-K 1',
    tip: '极速：每 30 帧看一次，画面相似就大量跳过，只适合从海量视频中快速找明显重复。',
  },
  {
    id: 'fast',
    name: '快速',
    description: '优先速度，适合大量视频初筛。',
    summary: '粗筛 10 / 步长 16 / Top-K 2',
    tip: '快速：比极速多保留一些变化画面，适合大批量视频的第一轮筛查。',
  },
  {
    id: 'normal',
    name: '普通',
    description: '速度和准确度均衡，适合日常分析。',
    summary: '粗筛 20 / 步长 6 / Top-K 5',
    tip: '普通：默认推荐配置，保留关键变化画面，同时避免长视频逐帧处理。',
  },
  {
    id: 'precise',
    name: '精确',
    description: '保留更多细节，适合最终确认。',
    summary: '粗筛 40 / 步长 3 / Top-K 10',
    tip: '精确：更密集地检查画面变化，并提高候选数量，适合对疑似重复视频复核。',
  },
  {
    id: 'perfect',
    name: '完美',
    description: '尽量追求准确，耗时最高。',
    summary: '全部比较 / 步长 1 / Top-K 24',
    tip: '完美：逐帧检查并使用最高候选量，适合少量关键视频的最终核验。',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '保存你临时调整后的参数。',
    summary: '用户自定义参数',
    tip: '自定义：选择任意预设后修改参数，都会先保存到这里；点击“保存到当前来源预设”才会覆盖对应预设。',
  },
  {
    id: 'duplicate_file',
    name: '对比相同文件',
    description: '只查文件内容是否完全一致。',
    summary: '不抽帧 / 不用 GPU / 不跑分析程序',
    tip: '对比相同文件：直接扫描相同大小的视频并计算文件指纹，只判断是不是完全同一个文件，不进行抽帧和相似度分析。',
  },
]

const errorToleranceOptions: Array<{
  id: ErrorTolerancePreset
  name: string
  description: string
  effect: string
}> = [
  {
    id: 'strict',
    name: '严格',
    description: '连续 5 条严重码流错误或 20 条缺失画面即隔离。',
    effect: '结果最干净，但部分还能播放的视频可能被移出。',
  },
  {
    id: 'balanced',
    name: '标准',
    description: '连续 20 条严重错误或 100 条缺失画面才隔离。',
    effect: '推荐设置，在完整性和可用性之间保持平衡。',
  },
  {
    id: 'lenient',
    name: '宽松',
    description: '允许最多 200 条严重错误或 1000 条缺失画面。',
    effect: '尽量保留可播放视频，少量画面可能被跳过。',
  },
  {
    id: 'failure_only',
    name: '仅失败时',
    description: '忽略可恢复码流告警，只在无法打开或抽不出有效画面时隔离。',
    effect: '容忍度最高，适合视觉影响不明显的视频库。',
  },
  {
    id: 'custom',
    name: '自定义',
    description: '使用手动调整后的错误容忍数值。',
    effect: '选择任意容忍预设后修改数值，会先保存到这里。',
  },
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

  function showSettingsMessage(message: string, duration = 2200) {
    setSavedMessage(message)
    if (saveMessageTimer.current) window.clearTimeout(saveMessageTimer.current)
    saveMessageTimer.current = window.setTimeout(() => setSavedMessage(''), duration)
  }

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
      : '恢复基础默认'
  const toastMessage = error || savedMessage || (saveFeedback === 'saved' ? '设置保存成功' : '')

  return (
    <div className="route-fill settings-shell">
      <GlassPanel className="settings-tab-panel">
        <div className="settings-tab-toolbar">
          <div className="settings-tabs" role="tablist" aria-label="设置分类">
            <button
              type="button"
              className={activeTab === 'base' ? 'active' : ''}
              onClick={() => setActiveTab('base')}
            >
              <Settings size={18} />
              基础设置
            </button>
            <button
              type="button"
              className={activeTab === 'analysis' ? 'active' : ''}
              onClick={() => setActiveTab('analysis')}
            >
              <SlidersHorizontal size={18} />
              分析配置
            </button>
            <button
              type="button"
              className={activeTab === 'error_tolerance' ? 'active' : ''}
              onClick={() => setActiveTab('error_tolerance')}
            >
              <ShieldCheck size={18} />
              错误容忍设置
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
              <RotateCcw size={18} />
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
            />
          ) : activeTab === 'analysis' ? (
            <AnalysisSettings
              onPresetSaved={(presetName) => {
                handleSave(`已保存到“${presetName}”预设。`)
              }}
            />
          ) : (
            <ErrorToleranceSettings
              onMessage={(message) => {
                setSavedMessage(message)
                window.setTimeout(() => setSavedMessage(''), 1800)
              }}
            />
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
  )
}

function BaseSettings({
  appInfo,
  onChoosePythonPath,
  onUseBundledPython,
  onChooseVideoDir,
  onChooseCacheDir,
  onChooseReportDir,
}: {
  appInfo: AppInfo | null
  onChoosePythonPath: () => Promise<void>
  onUseBundledPython: () => void
  onChooseVideoDir: () => Promise<void>
  onChooseCacheDir: () => Promise<void>
  onChooseReportDir: () => Promise<void>
}) {
  const settings = useSettingsStore()

  return (
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
      </div>

      <div className="settings-side-stack">
        <div className="settings-about-card">
          <div className="about-title">
            <Info size={24} />
            <h3>关于与版本</h3>
          </div>
          <div className="about-grid compact">
            <div>
              <span>应用版本</span>
              <strong title={`v${appInfo?.version ?? '0.1.0'}`}>v{appInfo?.version ?? '0.1.0'}</strong>
            </div>
            <div>
              <span>运行版本</span>
              <strong>{appInfo?.buildFlavor === 'gpu' ? 'GPU / CUDA' : 'CPU'}</strong>
            </div>
            <div>
              <span>安装方式</span>
              <strong>{appInfo?.installType === 'installed' ? '安装版' : '便携版'}</strong>
            </div>
            <div>
              <span>界面框架</span>
              <strong title="桌面界面(Tauri + React)">桌面界面(Tauri + React)</strong>
            </div>
            <div>
              <span>核心引擎</span>
              <strong title="Python 视频相似度引擎(Python Video Similarity Engine)">Python 视频相似度引擎(Python Video Similarity Engine)</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function UpdateDialog({
  open,
  appInfo,
  onClose,
}: {
  open: boolean
  appInfo: AppInfo | null
  onClose: () => void
}) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)
  const [error, setError] = useState('')

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true)
    setError('')
    setUpdate(null)
    setProgress(null)
    try {
      setUpdate(await checkForUpdates())
    } catch (err) {
      setError(normalizeBackendError(err))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    let stop = () => undefined
    void listenUpdateDownloadProgress((payload) => {
      if (!active) return
      setProgress(payload)
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
    const timer = window.setTimeout(() => void handleCheckUpdate(), 0)
    return () => window.clearTimeout(timer)
  }, [handleCheckUpdate, open])

  async function handleInstallUpdate() {
    if (!update?.canAutoInstall) return
    const confirmed = window.confirm(
      `将下载 ${formatBytes(update.assetSize)} 的 ${update.buildFlavor.toUpperCase()} 安装包，完成后自动退出并覆盖安装到：\n${update.installRoot}\n\n数据、报告、缓存和设置不会被删除。是否继续？`,
    )
    if (!confirmed) return
    setInstalling(true)
    setError('')
    setProgress({
      downloadedBytes: 0,
      totalBytes: update.assetSize,
      progress: 0,
      stage: '正在连接 GitHub Releases',
    })
    try {
      await downloadAndInstallUpdate(update)
    } catch (err) {
      setInstalling(false)
      setError(normalizeBackendError(err))
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
    <div className="modal-backdrop cache-cleanup-backdrop settings-update-backdrop" role="presentation">
      <section className="cache-cleanup-dialog settings-update-dialog" role="dialog" aria-modal="true" aria-label="检查更新">
        <div className="cache-cleanup-head settings-update-dialog-head">
          <div className="about-title">
            <Download size={24} />
            <h3>检查更新</h3>
          </div>
          <button type="button" onClick={onClose} disabled={installing} aria-label="关闭检查更新">
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
        {update?.canAutoInstall ? (
          <NeonButton type="button" onClick={() => void handleInstallUpdate()} disabled={installing}>
            <Download size={17} />
            {installing ? '下载中' : '立即更新'}
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
    </div>,
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
      </div>
      )}
    </div>
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
  )
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
    <label className="settings-row">
      <ParameterHint label={label} tip={tip} />
      <TextInput value={value} onChange={(event) => onChange(event.target.value)} />
      <NeonButton variant="outline" type="button" onClick={() => void onChoose()}>
        <FolderOpen size={17} />
        选择目录
      </NeonButton>
    </label>
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
    <label className="settings-row settings-row-readonly">
      <ParameterHint label={label} tip={tip} />
      <TextInput value={value || '未检测到项目目录'} readOnly title={value} />
      <span className="readonly-path-tag" title="项目目录由程序运行位置决定，不能手动编辑。">自动</span>
    </label>
  )
}

function NumberSetting({
  label,
  tip,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string
  tip: string
  value: number
  min?: number
  max?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="param-input-row">
      <ParameterHint label={label} tip={tip} />
      <div className={suffix ? 'number-suffix' : undefined}>
        <TextInput
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(clampNumber(event.target.value, min, max, value))}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </label>
  )
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
    defaultDevice: settings.defaultDevice,
    errorTolerancePreset: settings.errorTolerancePreset,
    errorToleranceSevereLimit: settings.errorToleranceSevereLimit,
    errorToleranceMissingPictureLimit: settings.errorToleranceMissingPictureLimit,
    errorTolerancePreflightValidation: settings.errorTolerancePreflightValidation,
    checkEnvOnStartup: settings.checkEnvOnStartup,
    openMaximized: settings.openMaximized,
    closeBehavior: settings.closeBehavior,
    defaultCompareWorkers: settings.defaultCompareWorkers,
    analysisMode: settings.analysisMode,
    selectedAnalysisPreset: settings.selectedAnalysisPreset,
    customAnalysisPresetSource: settings.customAnalysisPresetSource,
    customAnalysisPresets: settings.customAnalysisPresets,
    customErrorTolerance: settings.customErrorTolerance,
  })
}
