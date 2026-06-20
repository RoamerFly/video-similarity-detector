import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CheckCircle2,
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
import {
  checkPythonEnv,
  clearCacheItems,
  formatBytes,
  getAppInfo,
  normalizeBackendError,
  scanCache,
  selectOutputDirectory,
  selectPythonExecutable,
  selectVideoDirectory,
  type AppInfo,
  type CacheScanResult,
} from '@/services/backend'
import { useEnvironmentStore } from '@/stores/environmentStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { AnalysisPresetConfig, AnalysisPresetId, CloseBehavior, DeviceMode, PortraitRotation, ResizeMode, SettingsSnapshot } from '@/types/config'
import { parameterHints, withEnglish } from '@/utils/parameterHints'

type SettingsTab = 'base' | 'analysis'

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
    id: 'duplicate_file',
    name: '对比相同文件',
    description: '只查文件内容是否完全一致。',
    summary: '不抽帧 / 不用 GPU / 不跑分析程序',
    tip: '对比相同文件：直接扫描相同大小的视频并计算文件指纹，只判断是不是完全同一个文件，不进行抽帧和相似度分析。',
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
  const [cacheScan, setCacheScan] = useState<CacheScanResult | null>(null)
  const [selectedCachePaths, setSelectedCachePaths] = useState<Set<string>>(() => new Set())
  const [savedMessage, setSavedMessage] = useState('')
  const [error, setError] = useState('')
  const saveMessageTimer = useRef<number | null>(null)
  const didMountSettings = useRef(false)
  const environmentConfigKey = buildEnvironmentConfigKey(settings.pythonPath, settings.projectRoot, settings.reportDir)
  const settingsSignature = buildSettingsSignature(settings)

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

  useEffect(() => {
    if (!didMountSettings.current) {
      didMountSettings.current = true
      return undefined
    }

    setSavedMessage('设置更新成功')
    if (saveMessageTimer.current) window.clearTimeout(saveMessageTimer.current)
    saveMessageTimer.current = window.setTimeout(() => setSavedMessage(''), 1600)

    return undefined
  }, [settingsSignature])

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
        setSavedMessage('Python 路径已更新')
        window.setTimeout(() => setSavedMessage(''), 1800)
      }
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  function useBundledPython() {
    settings.setPythonPath('python')
    setSavedMessage('已切换为内置 env 环境')
    window.setTimeout(() => setSavedMessage(''), 1800)
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

  function handleSave() {
    setSavedMessage('设置更新成功')
    window.setTimeout(() => setSavedMessage(''), 1800)
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
      setSavedMessage('已恢复默认分析配置')
      window.setTimeout(() => setSavedMessage(''), 1800)
      return
    }

    settings.resetBaseSettings({
      projectRoot: appInfo?.projectRoot || settings.projectRoot,
      videoDir: appInfo?.defaultVideoDir || settings.videoDir,
      cacheDir: appInfo?.defaultCacheDir || settings.cacheDir,
      reportDir: appInfo?.defaultOutputDir || settings.reportDir,
    })
    useEnvironmentStore.getState().resetEnvironment()
    setSavedMessage('已恢复默认基础设置')
    window.setTimeout(() => setSavedMessage(''), 1800)
  }

  return (
    <div className="route-fill settings-shell">
      <GlassPanel className="environment-status-panel">
        <div className="environment-status-head">
          <div>
            <h2 className="section-title">
              <ShieldCheck />
              环境状态
            </h2>
            <p className="section-subtitle">进入设置页后自动检测 Python、脚本、报告目录和 GPU 加速。</p>
          </div>
          <NeonButton variant="outline" type="button" onClick={() => void handleCheckEnvironment()} disabled={checking}>
            <RefreshCw size={20} className={checking ? 'spin-slow' : ''} />
            {checking ? '检测中' : '重新检测'}
          </NeonButton>
        </div>

        <div className="environment-summary-grid">
          {environmentRows.map((row) => (
            <div className={`environment-summary-item ${row.ok === false ? 'is-failed' : ''}`} key={row.label}>
              <span>{row.label}</span>
              <strong title={row.value}>
                {row.ok === false || row.ok == null ? <AlertCircle size={17} /> : <CheckCircle2 size={17} fill="currentColor" />}
                {row.value}
              </strong>
            </div>
          ))}
        </div>

        {(environment?.message || environmentError || error) && (
          <p className={environment?.ok && !environmentError && !error ? 'settings-note compact' : 'inline-error settings-note compact'}>
            {error || environmentError || environment?.message}
          </p>
        )}
        {environment?.resolvedPythonPath && (
          <p className="environment-path compact" title={environment.resolvedPythonPath}>
            实际路径：{environment.resolvedPythonPath}
          </p>
        )}
      </GlassPanel>

      <GlassPanel className="settings-tab-panel">
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
              onClearCache={handleClearCache}
              clearingCache={clearingCache}
            />
          ) : (
            <AnalysisSettings
              onPresetSaved={(presetName) => {
                setSavedMessage(`已保存“${presetName}”自定义预设`)
                window.setTimeout(() => setSavedMessage(''), 1800)
              }}
            />
          )}
        </div>

        <div className="settings-actions">
          <div>
            <p className="settings-note compact">
              设置会自动保存；正在运行的分析任务不会被中途改配置，下一次开始分析时生效。
            </p>
            {(savedMessage || error) && (
              <p className={error ? 'inline-error settings-note' : 'settings-note'}>
                {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
                {error || savedMessage}
              </p>
            )}
          </div>
          <NeonButton variant="outline" type="button" onClick={handleReset}>
            <RotateCcw size={20} />
            {activeTab === 'analysis' ? '恢复当前预设默认' : '恢复基础默认'}
          </NeonButton>
          <NeonButton type="button" onClick={handleSave}>
            <Save size={21} />
            保存设置
          </NeonButton>
        </div>
      </GlassPanel>
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
  onClearCache,
  clearingCache,
}: {
  appInfo: AppInfo | null
  onChoosePythonPath: () => Promise<void>
  onUseBundledPython: () => void
  onChooseVideoDir: () => Promise<void>
  onChooseCacheDir: () => Promise<void>
  onChooseReportDir: () => Promise<void>
  onClearCache: () => Promise<void>
  clearingCache: boolean
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
        <div className="settings-cache-clean-row">
          <ParameterHint label="缓存清理" tip={parameterHints.clearCache} />
          <p title="删除抽帧、特征和断点缓存，保留报告文件。">删除抽帧、特征和断点缓存，保留报告文件。</p>
          <NeonButton tone="red" variant="outline" type="button" onClick={() => void onClearCache()} disabled={clearingCache}>
            <Trash2 size={17} />
            {clearingCache ? '检查中' : '检查缓存'}
          </NeonButton>
        </div>
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
      </div>

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
  )
}

function AnalysisSettings({ onPresetSaved }: { onPresetSaved: (presetName: string) => void }) {
  const settings = useSettingsStore()
  const activePreset = settings.selectedAnalysisPreset
  const activePresetOption = analysisPresetOptions.find((preset) => preset.id === activePreset)

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
            五档相似度预设可自定义。修改下方参数后保存到当前预设；恢复默认只重置当前选中的一档。
          </p>
          <NeonButton
            variant="outline"
            type="button"
            disabled={activePreset === 'duplicate_file'}
            onClick={() => {
              settings.saveCurrentAnalysisPreset()
              onPresetSaved(activePresetOption?.name ?? '当前')
            }}
          >
            <Save size={17} />
            保存到“{activePresetOption?.name ?? '当前'}”
          </NeonButton>
        </div>
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
        <NumberSetting label="精确比较候选数" tip={parameterHints.candidateLimit} value={settings.defaultCandidateLimit} min={0} max={500} onChange={settings.setDefaultCandidateLimit} />
        <NumberSetting label="最大间隔" tip={parameterHints.maxGapSec} value={settings.defaultMaxGapSec} onChange={settings.setDefaultMaxGapSec} suffix="秒" />
        <NumberSetting label="扫描步长" tip={parameterHints.frameStep} value={settings.defaultFrameStep} min={1} max={30} onChange={settings.setDefaultFrameStep} />
        <NumberSetting label="最短片段" tip={parameterHints.minSegmentDuration} value={settings.defaultMinSegmentDuration} min={1} max={120} onChange={settings.setDefaultMinSegmentDuration} suffix="秒" />
        <NumberSetting label="最少匹配点" tip={parameterHints.minSegmentMatches} value={settings.defaultMinSegmentMatches} min={1} max={50} onChange={settings.setDefaultMinSegmentMatches} />
        <NumberSetting label="偏移容忍" tip={parameterHints.offsetTolerance} value={settings.defaultOffsetTolerance} min={1} max={60} onChange={settings.setDefaultOffsetTolerance} suffix="秒" />

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
        <NumberSetting label="匹配分辨率" tip={parameterHints.inputSize} value={settings.defaultInputSize} min={128} max={768} onChange={settings.setDefaultInputSize} />
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

function CacheCleanupDialog({
  open,
  scan,
  selectedPaths,
  busy,
  onTogglePath,
  onSelectAll,
  onClearSelection,
  onClose,
  onConfirm,
}: {
  open: boolean
  scan: CacheScanResult | null
  selectedPaths: Set<string>
  busy: boolean
  onTogglePath: (path: string, checked: boolean) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onClose: () => void
  onConfirm: (paths: string[]) => void
}) {
  if (!open) return null

  const items = scan?.items ?? []
  const selectedCount = items.filter((item) => selectedPaths.has(item.path)).length
  const selectedSize = items
    .filter((item) => selectedPaths.has(item.path))
    .reduce((sum, item) => sum + item.sizeBytes, 0)

  return createPortal(
    <div className="modal-backdrop cache-cleanup-backdrop" role="presentation">
      <section className="cache-cleanup-dialog" role="dialog" aria-modal="true" aria-label="缓存清理">
        <div className="cache-cleanup-head">
          <div>
            <h3>缓存清理</h3>
            <p title={scan?.cacheDir || ''}>{scan?.message || '正在检查缓存目录...'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭缓存清理" disabled={busy}>
            ×
          </button>
        </div>

        <div className="cache-cleanup-summary">
          <span title={scan?.cacheDir || '-'}>目录：{scan?.cacheDir || '-'}</span>
          <strong>总大小：{formatBytes(scan?.totalSizeBytes ?? 0)}</strong>
          <strong>已选：{selectedCount} 项 / {formatBytes(selectedSize)}</strong>
        </div>

        <div className="cache-cleanup-toolbar">
          <button type="button" onClick={onSelectAll} disabled={busy || items.length === 0}>全选</button>
          <button type="button" onClick={onClearSelection} disabled={busy || selectedCount === 0}>取消选择</button>
        </div>

        <div className="cache-cleanup-list">
          {items.length > 0 ? items.map((item) => (
            <label className="cache-cleanup-item" key={item.id} title={item.path}>
              <input
                type="checkbox"
                checked={selectedPaths.has(item.path)}
                onChange={(event) => onTogglePath(item.path, event.target.checked)}
                disabled={busy}
              />
              <div>
                <strong>{item.category}</strong>
                <span>{item.name}</span>
                <small title={item.description}>{item.description}</small>
                <em title={item.path}>{item.path}</em>
              </div>
              <b>{formatBytes(item.sizeBytes)}</b>
              <i>{item.entryCount} 项</i>
            </label>
          )) : (
            <div className="cache-cleanup-empty">
              <CheckCircle2 size={22} />
              <span>没有发现可清理的缓存项目。</span>
            </div>
          )}
        </div>

        <div className="cache-cleanup-actions">
          <NeonButton variant="outline" type="button" onClick={onClose} disabled={busy}>
            取消
          </NeonButton>
          <NeonButton tone="red" type="button" disabled={busy || selectedCount === 0} onClick={() => onConfirm(Array.from(selectedPaths))}>
            <Trash2 size={18} />
            {busy ? '清理中' : `清理选中(${selectedCount})`}
          </NeonButton>
        </div>
      </section>
    </div>,
    document.body,
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
    checkEnvOnStartup: settings.checkEnvOnStartup,
    openMaximized: settings.openMaximized,
    closeBehavior: settings.closeBehavior,
    analysisMode: settings.analysisMode,
    selectedAnalysisPreset: settings.selectedAnalysisPreset,
    customAnalysisPresets: settings.customAnalysisPresets,
  })
}
