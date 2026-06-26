import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertCircle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Clipboard,
  Database,
  Eye,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  History,
  Layers3,
  ListChecks,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { GlassPanel, NeonButton, StatCard } from '@/components/DesignSystem'
import { CacheCleanupDialog } from '@/components/CacheCleanupDialog'
import { Translated } from '@/i18n/useI18n'
import {
  buildRunBatchCompareConfig,
  buildAnalysisTaskMatchKey,
  cancelMoveFiles,
  cancelCurrentTask,
  clearCacheItems,
  createAnalysisTask,
  deleteAnalysisTask,
  deleteFiles,
  formatBytes,
  formatDateTime,
  getAppInfo,
  listAnalysisTasks,
  moveFiles,
  normalizeBackendError,
  probeVideoMetadata,
  revealInFolder,
  runBatchCompare,
  runDuplicateFileCheck,
  scanAnalysisTaskCache,
  scanVideos,
  selectOutputDirectory,
  selectVideoDirectory,
  updateAnalysisTask,
  type AnalysisTaskRecord,
  type AnalysisTaskStageId,
  type CacheScanResult,
  type RunBatchCompareConfig,
  type VideoFile,
  type VideoMetadata,
} from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { analysisConfigFromSettings } from '@/types/config'
import type { VideoScanFilters } from '@/types/config'
import {
  analysisTaskStages,
  analysisTaskStatusClass,
  analysisTaskStatusLabel,
  canStartAnalysisStage,
  formatStageElapsed,
} from '@/utils/analysisTask'

export function AnalyzePage() {
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const {
    runningStatus,
    progress,
    stage,
    subProgress,
    subStage,
    scannedVideos: videos,
    scannedDir,
    scanMessage,
    logs,
    totalLogCount,
    logsDropped,
    runStartedAt,
    runFinishedAt,
    errorMessage,
    activeTaskId,
    setAnalysisConfig,
    setRunningStatus,
    setProgress,
    setScannedVideos,
    setScanMessage,
    appendLog,
    clearLogs,
    setReportPaths,
    setErrorMessage,
    setActiveTaskId,
    setReport,
    setResultSummary,
  } = useAnalysisStore()
  const [isPreparing, setIsPreparing] = useState(false)
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false)
  const [logView, setLogView] = useState<'stdout' | 'stderr'>('stdout')
  const [copyMessage, setCopyMessage] = useState('')
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [historyTasks, setHistoryTasks] = useState<AnalysisTaskRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyReady, setHistoryReady] = useState(false)
  const [activeSubpage, setActiveSubpage] = useState<'analysis' | 'history'>('analysis')
  const [detailTask, setDetailTask] = useState<AnalysisTaskRecord | null>(null)
  const [stageTaskId, setStageTaskId] = useState('')
  const [cacheTaskId, setCacheTaskId] = useState('')
  const [deleteTask, setDeleteTask] = useState<AnalysisTaskRecord | null>(null)
  const [taskCacheScan, setTaskCacheScan] = useState<CacheScanResult | null>(null)
  const [selectedTaskCachePaths, setSelectedTaskCachePaths] = useState<Set<string>>(() => new Set())
  const [taskCacheBusy, setTaskCacheBusy] = useState(false)
  const [videoMultiSelect, setVideoMultiSelect] = useState(false)
  const [selectedVideoPaths, setSelectedVideoPaths] = useState<Set<string>>(() => new Set())
  const [videoContextMenu, setVideoContextMenu] = useState<VideoContextMenuState | null>(null)
  const [videoFileBusy, setVideoFileBusy] = useState(false)
  const [videoFileAction, setVideoFileAction] = useState('')
  const [isMovingFiles, setIsMovingFiles] = useState(false)
  const [movingVideoTargets, setMovingVideoTargets] = useState<VideoFile[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const pauseRequestedTaskId = useRef('')
  const historyRefreshInFlight = useRef(false)
  const scanInFlight = useRef(false)
  const isRunning = runningStatus === 'running'
  const isBusy = isRunning || isPreparing
  const latestLog = logs[logs.length - 1]
  const logSummary = useMemo(() => {
    const stdout = []
    const stderr = []
    for (const log of logs) {
      if (log.stream === 'stderr') stderr.push(log)
      else stdout.push(log)
    }
    return { stdout, stderr }
  }, [logs])
  const visibleLogs = logSummary[logView]
  const renderedLogs = visibleLogs.slice(-500)
  const stdoutCount = logSummary.stdout.length
  const stderrCount = logSummary.stderr.length
  const isDuplicateFileMode = settings.analysisMode === 'duplicate_file'
  const pairCount = !isDuplicateFileMode && videos.length > 1 ? (videos.length * (videos.length - 1)) / 2 : 0
  const activeHistoryTask = historyTasks.find((task) => task.id === activeTaskId) ?? null
  const displayedTask = activeHistoryTask ?? historyTasks[0] ?? null
  const displayedStages = useMemo(
    () => displayedTask ? analysisTaskStages(displayedTask) : [],
    [displayedTask],
  )
  const progressValue = clampPercent(displayedTask?.progress ?? progress)
  const progressLabel = formatPercent(progressValue)
  const elapsedLabel = displayedTask
    ? formatTaskStagesElapsed(displayedStages, clockNow)
    : formatElapsed(runStartedAt, isRunning ? clockNow : runFinishedAt)
  const stageDetail = useMemo(
    () => buildSubTaskDetail(subStage, subProgress) ?? parseStageDetail(stage),
    [stage, subProgress, subStage],
  )
  const statusTitle = displayedTask?.stage || stage || scanMessage
  const stageTask = historyTasks.find((task) => task.id === stageTaskId) ?? null

  useEffect(() => {
    if (!videoContextMenu) return undefined
    const close = () => setVideoContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', close)
    }
  }, [videoContextMenu])

  useEffect(() => {
    setSelectedVideoPaths((current) => {
      if (current.size === 0) return current
      const available = new Set(videos.map((video) => normalizeVideoPath(video.path)))
      const next = new Set(Array.from(current).filter((path) => available.has(path)))
      return setsEqual(current, next) ? current : next
    })
  }, [videos])

  const refreshHistoryTasks = useCallback(async (showLoading = false) => {
    if (!settings.cacheDir || historyRefreshInFlight.current) return
    historyRefreshInFlight.current = true
    if (showLoading && !historyReady) setHistoryLoading(true)
    try {
      const nextTasks = await listAnalysisTasks(settings.cacheDir, settings.projectRoot)
      setHistoryTasks((current) => taskListsEqual(current, nextTasks) ? current : nextTasks)
      setHistoryReady(true)
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      historyRefreshInFlight.current = false
      setHistoryLoading(false)
    }
  }, [historyReady, setErrorMessage, settings.cacheDir, settings.projectRoot])

  useEffect(() => {
    if (!isRunning && !historyTasks.some((task) => task.status === 'running')) return undefined
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [historyTasks, isRunning])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshHistoryTasks(!historyReady), 0)
    return () => window.clearTimeout(timer)
  }, [historyReady, refreshHistoryTasks, runningStatus])

  useEffect(() => {
    if (activeSubpage !== 'history' && !isBusy) return undefined
    const timer = window.setInterval(() => void refreshHistoryTasks(false), 2000)
    return () => window.clearInterval(timer)
  }, [activeSubpage, isBusy, refreshHistoryTasks])

  useEffect(() => {
    if (!detailTask) return
    const timer = window.setTimeout(() => {
      const latest = historyTasks.find((task) => task.id === detailTask.id)
      if (latest && latest !== detailTask) setDetailTask(latest)
      if (!latest && historyTasks.length > 0) setDetailTask(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [detailTask, historyTasks])

  useEffect(() => {
    let alive = true
    getAppInfo()
      .then((info) => {
        if (!alive) return
        const store = useSettingsStore.getState()
        store.hydrateAppDefaults({
          projectRoot: info.projectRoot,
          videoDir: info.defaultVideoDir,
          cacheDir: info.defaultCacheDir,
          reportDir: info.defaultOutputDir,
        })
        setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
      })
      .catch((error) => {
        const message = normalizeBackendError(error)
        const store = useAnalysisStore.getState()
        store.setProgress(store.progress, '实时进度通道不可用')
        store.appendLog({ stream: 'stderr', line: message, timestamp: Date.now() })
        setErrorMessage(message)
      })

    return () => {
      alive = false
    }
  }, [setAnalysisConfig, setErrorMessage])

  useEffect(() => {
    if (useAnalysisStore.getState().runningStatus === 'running') return
    setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
  }, [
    settings.videoDir,
    settings.reportDir,
    settings.defaultSkipThreshold,
    settings.defaultMatchThreshold,
    settings.defaultWindowSize,
    settings.defaultTopK,
    settings.defaultCandidateLimit,
    settings.defaultMaxGapSec,
    settings.defaultFrameStep,
    settings.defaultMinSegmentDuration,
    settings.defaultMinSegmentMatches,
    settings.defaultOffsetTolerance,
    settings.defaultCropBlackBorders,
    settings.defaultResizeMode,
    settings.defaultInputSize,
    settings.defaultPortraitRotation,
    settings.defaultForce,
    settings.errorTolerancePreset,
    settings.errorToleranceSevereLimit,
    settings.errorToleranceMissingPictureLimit,
    settings.errorTolerancePreflightValidation,
    settings.analysisMode,
    setAnalysisConfig,
  ])

  const statusRows = useMemo(() => {
    if (displayedTask) {
      return displayedStages.map((taskStage) => ({
        label: taskStage.label,
        time: formatStageElapsed(taskStage, clockNow),
        done: taskStage.status === 'completed',
        active: taskStage.status === 'running',
        progress: taskStage.progress,
        message: taskStage.message,
      }))
    }
    return analysisTaskStages({
      stages: [],
    } as AnalysisTaskRecord).map((taskStage) => ({
      label: taskStage.label,
      time: '待处理',
      done: false,
      active: false,
      progress: 0,
      message: taskStage.message,
    }))
  }, [clockNow, displayedStages, displayedTask])

  async function handleScan(dir = settings.videoDir) {
    if (scanInFlight.current) {
      setScanMessage('正在扫描视频目录，请稍候...')
      return videos
    }
    if (!dir.trim()) {
      setScanMessage('请先到设置页配置视频目录。')
      setErrorMessage('请先到设置页配置视频目录。')
      return []
    }

    scanInFlight.current = true
    setIsScanning(true)
    setErrorMessage('')
    setVideoContextMenu(null)
    setScanMessage('正在扫描视频目录...')
    try {
      const found = await scanVideos(dir, true)
      const filtered = await filterScannedVideos(found, useSettingsStore.getState().videoScanFilters, {
        projectRoot: settings.projectRoot,
        pythonPath: settings.pythonPath,
        onMetadataStart: () => setScanMessage(`已扫描 ${found.length} 个视频，正在读取视频参数...`),
      })
      setScannedVideos(filtered, dir)
      setSelectedVideoPaths(new Set())
      if (filtered.length === 0) {
        setScanMessage('该目录下未找到支持的视频文件。')
      } else {
        const filterSuffix = filtered.length === found.length ? '' : `，已按扫描范围保留 ${filtered.length}/${found.length} 个`
        setScanMessage(isDuplicateFileMode
          ? `已扫描 ${found.length} 个视频${filterSuffix}，将直接检查完全相同文件。`
          : `已扫描 ${found.length} 个视频${filterSuffix}，预计比较 ${Math.max(0, pairCountFor(filtered.length))} 对。`)
      }
      return filtered
    } catch (error) {
      const message = normalizeBackendError(error)
      setScannedVideos([], '')
      setSelectedVideoPaths(new Set())
      setScanMessage(message)
      setErrorMessage(message)
      return []
    } finally {
      scanInFlight.current = false
      setIsScanning(false)
    }
  }

  async function handleChooseVideoDirectory() {
    if (isBusy) return
    setErrorMessage('')
    try {
      const selected = await selectVideoDirectory()
      if (!selected) return
      const store = useSettingsStore.getState()
      store.setVideoDir(selected)
      store.saveSettings()
      setScannedVideos([], '')
      setScanMessage('视频目录已更新，请重新扫描。')
      setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
    } catch (error) {
      const message = normalizeBackendError(error)
      setScanMessage(message)
      setErrorMessage(message)
    }
  }

  async function handleChooseReportDirectory() {
    if (isBusy) return
    setErrorMessage('')
    try {
      const selected = await selectOutputDirectory()
      if (!selected) return
      const store = useSettingsStore.getState()
      store.setReportDir(selected)
      store.saveSettings()
      setScanMessage('报告目录已更新。')
      setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
    } catch (error) {
      const message = normalizeBackendError(error)
      setScanMessage(message)
      setErrorMessage(message)
    }
  }

  async function handleChooseCacheDirectory() {
    if (isBusy) return
    setErrorMessage('')
    try {
      const selected = await selectOutputDirectory()
      if (!selected) return
      const store = useSettingsStore.getState()
      store.setCacheDir(selected)
      store.saveSettings()
      setScanMessage('缓存目录已更新。')
      setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
    } catch (error) {
      const message = normalizeBackendError(error)
      setScanMessage(message)
      setErrorMessage(message)
    }
  }

  async function handleCreateTask() {
    const currentSettings = useSettingsStore.getState()
    const config = analysisConfigFromSettings(currentSettings)

    if (!config.videoDir.trim()) {
      setErrorMessage('请先到设置页配置视频目录。')
      setScanMessage('请先到设置页配置视频目录。')
      return
    }
    if (!config.outputDir.trim()) {
      setErrorMessage('请先到设置页配置报告目录。')
      return
    }

    setAnalysisConfig(config)
    setIsPreparing(true)
    setProgress(0, '正在新建分析任务', { subProgress: null, subStage: '' })
    setErrorMessage('')
    try {
      let selectedVideos = scannedDir === config.videoDir ? videos : []
      if (selectedVideos.length === 0) {
        selectedVideos = await handleScan(config.videoDir)
      }
      if (selectedVideos.length < 2) {
        setErrorMessage('当前扫描范围内至少需要 2 个视频才能新建任务。')
        setScanMessage('当前扫描范围内至少需要 2 个视频才能新建任务。')
        return
      }
      const videoPaths = selectedVideos.map((video) => video.path)
      const batchConfig = {
        ...buildRunBatchCompareConfig(currentSettings, config),
        videoPaths,
      }
      const taskMatchKey = buildAnalysisTaskMatchKey(batchConfig)
      const task = await createAnalysisTask(batchConfig, taskMatchKey)
      const seededTask = await updateAnalysisTask(task.id, batchConfig.cacheDir, batchConfig.projectRoot, {
        stage: `等待启动：已选择 ${selectedVideos.length} 个视频`,
        totalPairs: pairCountFor(selectedVideos.length),
        videos: selectedVideos,
      })
      setHistoryTasks((current) => [seededTask, ...current.filter((item) => item.id !== seededTask.id)])
      setProgress(0, '任务已新建，等待启动')
      setScanMessage(`已新建任务 ${task.id}。请在“历史任务”中启动。`)
      setActiveSubpage('history')
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setIsPreparing(false)
    }
  }

  async function handlePause() {
    if (!activeTaskId) return
    const activeTask = historyTasks.find((task) => task.id === activeTaskId)
    const cacheDir = activeTask?.config?.cacheDir || settings.cacheDir
    const projectRoot = activeTask?.config?.projectRoot || settings.projectRoot
    pauseRequestedTaskId.current = activeTaskId
    try {
      await cancelCurrentTask()
      await updateAnalysisTask(activeTaskId, cacheDir, projectRoot, {
        status: 'paused',
        stage: '任务已暂停，可从历史任务继续',
        progress,
      })
      appendLog({ stream: 'stderr', line: '已请求暂停分析，正在等待当前步骤安全停止。', timestamp: Date.now() })
      setRunningStatus('paused')
      setProgress(progress, '任务已暂停')
      setErrorMessage('')
      await refreshHistoryTasks()
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    }
  }

  async function handleRunTask(
    task: AnalysisTaskRecord,
    options: { executionStage?: AnalysisTaskStageId; redoStage?: boolean } = {},
  ) {
    if (isBusy) return
    const defaults = buildRunBatchCompareConfig(
      useSettingsStore.getState(),
      analysisConfigFromSettings(useSettingsStore.getState()),
    )
    const taskConfig: RunBatchCompareConfig = { ...defaults, ...task.config, taskId: task.id, compareWorkers: defaults.compareWorkers }
    if (!taskConfig?.videoDir || !taskConfig?.cacheDir) {
      setErrorMessage('该历史任务缺少运行配置，无法继续。')
      return
    }
    if (taskConfig.analysisMode === 'duplicate_file' && options.executionStage) {
      setErrorMessage('“对比相同文件”模式暂不拆分特征阶段，请直接启动完整任务。')
      return
    }

    pauseRequestedTaskId.current = ''
    setActiveTaskId(task.id)
    setIsPreparing(true)
    setErrorMessage('')
    setRunningStatus('running')
    const selectedStage = options.executionStage
      ? analysisTaskStages(task).find((item) => item.id === options.executionStage)
      : null
    const launchMessage = selectedStage
      ? `${options.redoStage ? '正在重做' : '正在启动'}阶段：${selectedStage.label}`
      : task.status === 'created'
        ? '正在准备新任务'
        : '正在检查历史任务断点和增量缓存'
    setProgress(task.progress, launchMessage, { subProgress: null, subStage: '' })
    try {
      await updateAnalysisTask(task.id, taskConfig.cacheDir, taskConfig.projectRoot, {
        status: 'preparing',
        stage: launchMessage,
        progress: task.progress,
      })

      const store = useSettingsStore.getState()
      store.setVideoDir(taskConfig.videoDir)
      store.setCacheDir(taskConfig.cacheDir)
      if (taskConfig.outputDir) store.setReportDir(taskConfig.outputDir)
      clearLogs()
      setReport(null)
      setResultSummary(null)
      if (!options.executionStage) setReportPaths(null)
      setRunningStatus('running')
      setProgress(task.progress, launchMessage, {
        subProgress: null,
        subStage: options.executionStage ? '正在核对前置阶段产物' : '正在读取阶段状态与比较断点',
      })
      appendLog({
        stream: 'stdout',
        line: options.executionStage
          ? `${options.redoStage ? '重做' : '执行'}阶段 ${selectedStage?.label || options.executionStage}，任务 ${task.id}。`
          : `启动任务 ${task.id}；将自动检查增量视频、特征缓存和已完成视频对。`,
        timestamp: Date.now(),
      })

      if (taskConfig.analysisMode === 'duplicate_file') {
        const found = taskConfig.videoPaths?.length
          ? videoFilesFromTask(task, taskConfig.videoPaths)
          : await scanVideos(taskConfig.videoDir, true)
        const estimatedPairs = pairCountFor(found.length)
        setScannedVideos(found, taskConfig.videoDir)
        const paths = await runDuplicateFileCheck({
          videoDir: taskConfig.videoDir,
          outputDir: taskConfig.outputDir,
          projectRoot: taskConfig.projectRoot,
          recursive: true,
          videoPaths: taskConfig.videoPaths,
        })
        setReportPaths(paths)
        await updateAnalysisTask(task.id, taskConfig.cacheDir, taskConfig.projectRoot, {
          status: 'completed',
          stage: '相同文件检查完成',
          progress: 100,
          totalPairs: estimatedPairs,
          completedPairs: estimatedPairs,
          reportJson: paths.reportJson,
          reportCsv: paths.reportCsv,
          reportHtml: paths.reportHtml,
        })
        setRunningStatus('success')
        setProgress(100, '相同文件检查完成')
        navigate('/results')
        return
      }

      const paths = await runBatchCompare({
        ...taskConfig,
        taskId: task.id,
        taskMatchKey: task.matchKey || buildAnalysisTaskMatchKey(taskConfig),
        executionStage: options.executionStage,
        redoStage: options.redoStage,
      })
      if (!options.executionStage) setReportPaths(paths)
    } catch (error) {
      const currentStatus = useAnalysisStore.getState().runningStatus
      if (currentStatus !== 'paused' && currentStatus !== 'cancelled') {
        setRunningStatus('error')
        setErrorMessage(normalizeBackendError(error))
        await updateAnalysisTask(task.id, taskConfig.cacheDir, taskConfig.projectRoot, {
          status: 'failed',
          stage: `任务异常中断：${normalizeBackendError(error)}`,
          progress: useAnalysisStore.getState().progress,
        }).catch(() => undefined)
      }
    } finally {
      setIsPreparing(false)
      await refreshHistoryTasks()
    }
  }

  async function handleDeleteTask(task: AnalysisTaskRecord, deleteGeneratedCache: boolean) {
    if (isBusy && task.id === activeTaskId) return
    setTaskCacheBusy(true)
    try {
      await deleteAnalysisTask(
        task.id,
        settings.cacheDir || task.config?.cacheDir || 'data',
        settings.projectRoot || task.config?.projectRoot,
        deleteGeneratedCache,
      )
      if (detailTask?.id === task.id) setDetailTask(null)
      if (stageTaskId === task.id) setStageTaskId('')
      setDeleteTask(null)
      await refreshHistoryTasks(false)
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setTaskCacheBusy(false)
    }
  }

  async function handleOpenTaskCache(task: AnalysisTaskRecord) {
    setTaskCacheBusy(true)
    setErrorMessage('')
    try {
      const scan = await scanAnalysisTaskCache(
        task.id,
        settings.cacheDir || task.config?.cacheDir || 'data',
        settings.projectRoot || task.config?.projectRoot,
      )
      setTaskCacheScan(scan)
      setSelectedTaskCachePaths(new Set(scan.items.map((item) => item.path)))
      setCacheTaskId(task.id)
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setTaskCacheBusy(false)
    }
  }

  async function handleClearTaskCache(paths: string[]) {
    const task = historyTasks.find((item) => item.id === cacheTaskId)
    if (!task || paths.length === 0) return
    if (!window.confirm(`确认清理选中的 ${paths.length} 个任务缓存项目吗？原始视频不会被删除。`)) return
    setTaskCacheBusy(true)
    try {
      await clearCacheItems(
        settings.cacheDir || task.config?.cacheDir || 'data',
        settings.projectRoot || task.config?.projectRoot || '',
        paths,
      )
      const nextScan = await scanAnalysisTaskCache(
        task.id,
        settings.cacheDir || task.config?.cacheDir || 'data',
        settings.projectRoot || task.config?.projectRoot,
      )
      setTaskCacheScan(nextScan)
      setSelectedTaskCachePaths(new Set(nextScan.items.map((item) => item.path)))
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setTaskCacheBusy(false)
    }
  }

  function handleOpenTaskDetail(task: AnalysisTaskRecord) {
    setErrorMessage('')
    setDetailTask(task)
  }

  async function handleCopyLogs() {
    try {
      const retainedNote = logsDropped > 0 ? [`已省略较早的 ${logsDropped} 行日志，仅复制最近 ${logs.length} 行。`] : []
      await navigator.clipboard.writeText([...retainedNote, ...visibleLogs.map((log) => `[${log.stream}] ${log.line}`)].join('\n'))
      setCopyMessage(`${logView === 'stderr' ? '错误' : '正常'}输出已复制`)
      window.setTimeout(() => setCopyMessage(''), 1500)
    } catch (error) {
      setErrorMessage(`复制日志失败：${normalizeBackendError(error)}`)
    }
  }

  function toggleVideoSelection(video: VideoFile) {
    const key = normalizeVideoPath(video.path)
    setSelectedVideoPaths((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAllVideos() {
    setSelectedVideoPaths(new Set(videos.map((video) => normalizeVideoPath(video.path))))
  }

  function clearVideoSelection() {
    setSelectedVideoPaths(new Set())
  }

  function openVideoContextMenu(event: MouseEvent, video: VideoFile) {
    event.preventDefault()
    setVideoContextMenu({
      x: event.clientX,
      y: event.clientY,
      video,
    })
  }

  function selectedVideosForAction(fallback?: VideoFile) {
    if (videoMultiSelect && selectedVideoPaths.size > 0) {
      if (fallback && !selectedVideoPaths.has(normalizeVideoPath(fallback.path))) return [fallback]
      const selected = videos.filter((video) => selectedVideoPaths.has(normalizeVideoPath(video.path)))
      if (selected.length > 0) return selected
    }
    return fallback ? [fallback] : []
  }

  async function revealVideo(video: VideoFile) {
    setVideoContextMenu(null)
    setErrorMessage('')
    try {
      await revealInFolder(video.path)
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    }
  }

  async function deleteVideoFiles(targets: VideoFile[]) {
    if (targets.length === 0 || videoFileBusy) return
    if (!window.confirm(`确认删除选中的 ${targets.length} 个视频文件吗？此操作不可撤销。`)) return
    setVideoContextMenu(null)
    setVideoFileBusy(true)
    setVideoFileAction(`正在删除 ${targets.length} 个视频...`)
    setErrorMessage('')
    try {
      const result = await deleteFiles(targets.map((video) => video.path))
      const deleted = new Set(result.deletedPaths.map(normalizeVideoPath))
      if (deleted.size > 0) {
        const nextVideos = videos.filter((video) => !deleted.has(normalizeVideoPath(video.path)))
        setScannedVideos(nextVideos, scannedDir)
        setSelectedVideoPaths((current) => {
          const next = new Set(current)
          deleted.forEach((path) => next.delete(path))
          return next
        })
        setScanMessage(`已删除 ${deleted.size} 个视频，当前剩余 ${nextVideos.length} 个。`)
      }
      if (result.failed.length > 0) {
        setErrorMessage(result.message)
      }
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setVideoFileBusy(false)
      setVideoFileAction('')
    }
  }

  async function moveVideoFiles(targets: VideoFile[]) {
    if (targets.length === 0 || videoFileBusy) return
    setVideoContextMenu(null)
    setErrorMessage('')
    try {
      const targetDir = await selectOutputDirectory()
      if (!targetDir) return
      setVideoFileBusy(true)
      setIsMovingFiles(true)
      setMovingVideoTargets(targets)
      setVideoFileAction(`正在移动 ${targets.length} 个视频...`)
      const result = await moveFiles(targets.map((video) => video.path), targetDir)
      const moved = new Set(result.movedPaths.map((item) => normalizeVideoPath(item.from)))
      if (moved.size > 0) {
        const nextVideos = videos.filter((video) => !moved.has(normalizeVideoPath(video.path)))
        setScannedVideos(nextVideos, scannedDir)
        setSelectedVideoPaths((current) => {
          const next = new Set(current)
          moved.forEach((path) => next.delete(path))
          return next
        })
        setScanMessage(`已移动 ${moved.size} 个视频到 ${targetDir}，当前剩余 ${nextVideos.length} 个。`)
      }
      if (result.failed.length > 0) {
        setErrorMessage(result.message)
      }
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    } finally {
      setVideoFileBusy(false)
      setIsMovingFiles(false)
      setMovingVideoTargets([])
      setVideoFileAction('')
    }
  }

  async function interruptVideoMove() {
    if (!isMovingFiles) return
    const affected = movingVideoTargets
      .slice(0, 8)
      .map((video) => `- ${video.name}`)
      .join('\n')
    const more = movingVideoTargets.length > 8 ? `\n- 以及另外 ${movingVideoTargets.length - 8} 个文件` : ''
    const confirmed = window.confirm(
      [
        '确认中断本次移动吗？',
        '此次中断可能影响以下视频文件：',
        affected ? `${affected}${more}` : '- 当前移动队列',
        '',
        '已完成移动的文件不会自动移回；正在复制的文件会尽量清理未完成的目标文件。',
      ].join('\n'),
    )
    if (!confirmed) return
    try {
      setVideoFileAction('正在中断移动...')
      await cancelMoveFiles()
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    }
  }

  return (
    <Translated>
    <div className="route-fill analyze-workspace">
      <div className="analysis-page-content">
        <div className="analysis-subpage-tabs" role="tablist" aria-label="分析任务页面">
          <button type="button" className={activeSubpage === 'analysis' ? 'active' : ''} onClick={() => setActiveSubpage('analysis')}>
            <Film size={17} />
            分析任务
          </button>
          <button type="button" className={activeSubpage === 'history' ? 'active' : ''} onClick={() => setActiveSubpage('history')}>
            <History size={17} />
            历史任务
          </button>
        </div>
        <div className={`analyze-simple-page ${activeSubpage === 'history' ? 'show-history' : 'show-analysis'}`}>
        <GlassPanel className="analysis-launch-panel analysis-task-subpage">
          <div className="analysis-launch-copy">
            <h2 className="section-title">
              <Film />
              分析任务
            </h2>
            <p>设置集中在设置页管理。这里仅负责扫描视频、启动分析和查看运行状态。</p>
          </div>

          <div className="analysis-path-summary">
            <PathSummary
              label="视频目录"
              value={settings.videoDir || '未配置'}
              hint="双击选择视频目录"
              onDoubleClick={() => void handleChooseVideoDirectory()}
            />
            <PathSummary
              label="报告目录"
              value={settings.reportDir || '未配置'}
              hint="双击选择报告目录"
              onDoubleClick={() => void handleChooseReportDirectory()}
            />
            <PathSummary
              label="缓存目录"
              value={settings.cacheDir || '未配置'}
              hint="双击选择缓存目录"
              onDoubleClick={() => void handleChooseCacheDirectory()}
            />
          </div>

          <div className="analysis-action-row">
            <NeonButton variant="outline" onClick={() => void handleScan()} disabled={isBusy || isScanning}>
              <RefreshCw size={20} className={isScanning ? 'spin-slow' : undefined} />
              {isScanning ? '扫描中' : '扫描视频'}
            </NeonButton>
            {isRunning && activeTaskId ? (
              <NeonButton className="start-analysis-button compact" tone="red" onClick={() => void handlePause()}>
                <Square size={21} fill="currentColor" />
                暂停任务
              </NeonButton>
            ) : (
              <NeonButton className="start-analysis-button compact" onClick={() => void handleCreateTask()} disabled={isPreparing || isScanning}>
                <Play size={22} fill="currentColor" />
                {isPreparing ? '新建中' : '新建任务'}
              </NeonButton>
            )}
            <NeonButton variant="ghost" onClick={() => navigate('/settings')}>
              <Settings size={20} />
              打开设置
            </NeonButton>
          </div>
        </GlassPanel>

        <GlassPanel className="run-status-panel analyze-status-panel analysis-task-subpage">
          <div className="panel-heading-row">
            <h2 className="section-title">
              <Activity />
              运行状态
            </h2>
            <strong className="progress-heading-percent">{progressLabel}</strong>
          </div>

          <div className="progress-head">
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressValue}
              aria-label="分析总进度"
            >
              <span style={{ width: `${progressValue}%` }} />
            </div>
          </div>

          <div className="status-message-block">
            <p className="status-message" title={statusTitle}>{statusTitle}</p>
            {stageDetail && (
              <div className="stage-detail-card">
                {(stageDetail.title || stageDetail.videoName) && (
                  <span className="stage-file-name" title={formatStageDetailTitle(stageDetail)}>
                    {stageDetail.title}
                    {stageDetail.videoName ? `：${stageDetail.videoName}` : ''}
                  </span>
                )}
                {stageDetail.total ? (
                  <div className="stage-frame-progress">
                    <div className="stage-frame-track">
                      <span style={{ width: `${clampPercent(stageDetail.percent ?? 0)}%` }} />
                    </div>
                    <strong>{stageDetail.detail}</strong>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="status-list">
            {statusRows.map((row) => (
              <div className={row.active ? 'status-item is-active' : 'status-item'} key={row.label} title={row.message}>
                <span className={row.done ? 'status-dot blue' : row.active ? 'status-dot cyan' : 'status-dot pink'} />
                <span className="status-stage-name">{row.label}</span>
                <div className="status-stage-progress">
                  <span style={{ width: `${clampPercent(row.progress)}%` }} />
                </div>
                <time>{row.time}</time>
                {row.done ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              </div>
            ))}
          </div>

          {(errorMessage || runningStatus === 'cancelled') && (
            <p className="inline-error">{errorMessage || '分析已取消。'}</p>
          )}
        </GlassPanel>

        <GlassPanel className="analysis-history-panel analysis-history-subpage">
          <div className="panel-heading-row">
            <h2 className="section-title">
              <History />
              历史任务
            </h2>
            <NeonButton variant="ghost" type="button" onClick={() => void refreshHistoryTasks(true)} disabled={historyLoading}>
              <RefreshCw size={17} className={historyLoading ? 'spin-slow' : ''} />
              刷新
            </NeonButton>
          </div>
          {historyTasks.length ? (
            <div className="analysis-history-list">
              {historyTasks.map((task) => {
                const isActive = task.id === activeTaskId && isRunning
                const isLiveTask = task.status === 'running' || task.status === 'preparing'
                const canRun = !isActive && task.status !== 'completed'
                return (
                  <article className={isActive ? 'analysis-history-item is-active' : 'analysis-history-item'} key={task.id}>
                    <div className="analysis-history-main">
                      <div>
                        <span className={`analysis-history-status ${analysisTaskStatusClass(task, isActive)}`}>
                          {analysisTaskStatusLabel(task)}
                        </span>
                        <strong title={task.videoDir}>{task.videoCount} 个视频</strong>
                      </div>
                      <span className="analysis-history-percent">{Math.round(task.progress)}%</span>
                    </div>
                    <div className="analysis-history-progress">
                      <span style={{ width: `${clampPercent(task.progress)}%` }} />
                    </div>
                    <div className="analysis-history-meta">
                      <small>{formatDateTime(task.updatedAt)}</small>
                      <small>{task.completedPairs}/{task.totalPairs} 对</small>
                      <small title={task.id}>{task.id}</small>
                    </div>
                    <p className="analysis-history-stage" title={task.stage || task.videoDir}>{task.stage || task.videoDir}</p>
                    <div className="analysis-history-actions">
                      <NeonButton variant="ghost" type="button" onClick={() => handleOpenTaskDetail(task)}>
                        <Eye size={16} />
                        详情
                      </NeonButton>
                      {isActive ? (
                        <NeonButton variant="outline" tone="red" type="button" onClick={() => void handlePause()}>
                          <Pause size={16} />
                          暂停
                        </NeonButton>
                      ) : canRun ? (
                        <NeonButton variant="outline" type="button" disabled={isBusy} onClick={() => void handleRunTask(task)}>
                          <Play size={16} />
                          {task.status === 'created' ? '启动' : isLiveTask ? '恢复' : '继续'}
                        </NeonButton>
                      ) : (
                        <NeonButton variant="outline" type="button" disabled>
                          <Play size={16} />
                          已完成
                        </NeonButton>
                      )}
                      <NeonButton
                        variant="ghost"
                        type="button"
                        disabled={task.config?.analysisMode === 'duplicate_file'}
                        title={task.config?.analysisMode === 'duplicate_file' ? '相同文件检查使用完整流程' : '按阶段执行任务'}
                        onClick={() => setStageTaskId(task.id)}
                      >
                        <Layers3 size={16} />
                        分阶段处理
                      </NeonButton>
                      <NeonButton variant="ghost" type="button" disabled={taskCacheBusy} onClick={() => void handleOpenTaskCache(task)}>
                        <HardDrive size={16} />
                        查看任务缓存
                      </NeonButton>
                      <button className="analysis-history-delete" type="button" disabled={isActive} onClick={() => setDeleteTask(task)}>
                        <Trash2 size={16} />
                        删除
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <p className="empty-state-text">
              {!historyReady ? '正在读取历史任务...' : '暂无任务。请先在“分析任务”页新建任务。'}
            </p>
          )}
        </GlassPanel>

        <GlassPanel className="analysis-overview-panel analysis-task-subpage">
          <div className="preview-stats compact">
            <StatCard title="视频数量" value={videos.length} icon={<Film />} tone="blue" />
            <StatCard title={isDuplicateFileMode ? '检查方式' : '比较对数'} value={isDuplicateFileMode ? '指纹' : pairCount} icon={<BarChart3 />} tone="purple" />
            <StatCard title="运行时间" value={elapsedLabel} icon={<Activity />} tone="cyan" />
            <StatCard title="日志行数" value={totalLogCount} icon={<Activity />} tone="pink" />
          </div>

          {videos.length > 0 ? (
            <div className={isScanning ? 'video-list-panel is-scanning' : 'video-list-panel'}>
              <div className="video-list-toolbar">
                <span>{videoFileAction || (isScanning ? scanMessage : selectedVideoPaths.size > 0 ? `已选 ${selectedVideoPaths.size}` : scanMessage)}</span>
                <div>
                  {videoMultiSelect ? (
                    <>
                      <button type="button" onClick={selectAllVideos} disabled={videoFileBusy}>
                        全选
                      </button>
                      <button type="button" onClick={clearVideoSelection} disabled={videoFileBusy || selectedVideoPaths.size === 0}>
                        清空
                      </button>
                      <button
                        type="button"
                        className={isMovingFiles ? 'danger' : ''}
                        onClick={() => {
                          if (isMovingFiles) void interruptVideoMove()
                          else void moveVideoFiles(selectedVideosForAction())
                        }}
                        disabled={!isMovingFiles && (videoFileBusy || selectedVideoPaths.size === 0)}
                      >
                        {isMovingFiles ? <Square size={15} /> : <FolderOpen size={15} />}
                        {isMovingFiles ? '中断' : '移动'}
                      </button>
                      <button type="button" className="danger" onClick={() => void deleteVideoFiles(selectedVideosForAction())} disabled={videoFileBusy || selectedVideoPaths.size === 0}>
                        <Trash2 size={15} />
                        删除
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className={videoMultiSelect ? 'active' : ''}
                    onClick={() => {
                      setVideoMultiSelect((current) => !current)
                      setSelectedVideoPaths(new Set())
                    }}
                    disabled={videoFileBusy}
                  >
                    <ListChecks size={15} />
                    多选
                  </button>
                </div>
              </div>
              <div className="video-scroll-list" role="list" aria-label="已扫描视频">
                {videos.map((video) => {
                  const selected = selectedVideoPaths.has(normalizeVideoPath(video.path))
                  return (
                    <button
                      type="button"
                      role="listitem"
                      className={selected ? 'video-list-row selected' : 'video-list-row'}
                      title={video.path}
                      key={video.path}
                      onClick={() => {
                        if (videoMultiSelect) toggleVideoSelection(video)
                      }}
                      onContextMenu={(event) => openVideoContextMenu(event, video)}
                    >
                      {videoMultiSelect ? (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleVideoSelection(video)}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`选择 ${video.name}`}
                        />
                      ) : null}
                      <span className="video-row-main">
                        <strong>{video.name}</strong>
                        <small>{video.path}</small>
                      </span>
                      <span className="video-row-meta">{formatBytes(video.sizeBytes)}</span>
                    </button>
                  )
                })}
              </div>
              {isScanning && (
                <div className="scan-progress-overlay" role="status" aria-live="polite">
                  <RefreshCw size={20} className="spin-slow" />
                  <span>{scanMessage || '正在扫描视频目录...'}</span>
                </div>
              )}
              {!isScanning && videoFileAction && (
                <div className="scan-progress-overlay" role="status" aria-live="polite">
                  <RefreshCw size={20} className="spin-slow" />
                  <span>{videoFileAction}</span>
                  {isMovingFiles && (
                    <button type="button" onClick={() => void interruptVideoMove()}>
                      <Square size={15} />
                      中断移动
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className={isScanning ? 'empty-state-text scan-empty-state is-scanning' : 'empty-state-text'}>
              {isScanning ? <RefreshCw size={22} className="spin-slow" /> : null}
              <span>{scanMessage}</span>
            </div>
          )}

        </GlassPanel>
      </div>
      </div>

      <section className={`analysis-log-drawer ${isLogDrawerOpen ? 'open' : 'collapsed'}`}>
        <button
          type="button"
          className="log-drawer-handle"
          onClick={() => setIsLogDrawerOpen((open) => !open)}
          aria-expanded={isLogDrawerOpen}
        >
          <span>
            <Terminal size={17} />
            实时日志
            <strong>{totalLogCount}</strong>
          </span>
          <small title={latestLog?.line}>{latestLog?.line ?? '点击展开日志栏'}</small>
          {isLogDrawerOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>

        {isLogDrawerOpen && (
          <div className="log-drawer-body">
            <div className="log-toolbar">
              <div className="log-toolbar-copy">
                <span>
                  Python 标准输出(stdout) / 错误输出(stderr)
                  {logsDropped > 0 ? ` · 已保留最近 ${logs.length} 行，省略 ${logsDropped} 行` : ''}
                </span>
                <div className="log-view-tabs" role="tablist" aria-label="日志输出类型">
                  <button
                    className={logView === 'stdout' ? 'active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={logView === 'stdout'}
                    onClick={() => setLogView('stdout')}
                  >
                    正常输出 <b>{stdoutCount}</b>
                  </button>
                  <button
                    className={logView === 'stderr' ? 'active error' : 'error'}
                    type="button"
                    role="tab"
                    aria-selected={logView === 'stderr'}
                    onClick={() => setLogView('stderr')}
                  >
                    错误输出 <b>{stderrCount}</b>
                  </button>
                </div>
              </div>
              <div>
                <button type="button" onClick={() => void handleCopyLogs()} disabled={visibleLogs.length === 0}>
                  <Clipboard size={16} />
                  复制
                </button>
                <button type="button" onClick={clearLogs} disabled={logs.length === 0}>
                  <Trash2 size={16} />
                  清空
                </button>
              </div>
            </div>
            {copyMessage && <span className="copy-message">{copyMessage}</span>}

            <div className="analysis-log-panel">
              {visibleLogs.length > renderedLogs.length && (
                <p className="empty-log-line">为保持界面流畅，仅渲染当前窗口最近 {renderedLogs.length} 行；复制仍包含全部保留日志。</p>
              )}
              {renderedLogs.length > 0 ? renderedLogs.map((log) => (
                <p className={log.stream === 'stderr' ? 'stderr' : ''} key={`${log.timestamp}-${log.stream}-${log.line}`}>
                  <span>[{formatLogStream(log.stream)}]</span>
                  {log.line}
                </p>
              )) : (
                <p className="empty-log-line">
                  {logView === 'stderr' ? '当前没有错误输出。' : '当前没有正常输出。'}
                </p>
              )}
            </div>
          </div>
        )}
      </section>
      <TaskDetailDialog task={detailTask} onClose={() => setDetailTask(null)} />
      <TaskStagesDialog
        task={stageTask}
        busy={isBusy}
        activeTaskId={activeTaskId}
        now={clockNow}
        onClose={() => setStageTaskId('')}
        onRun={(task, stageId, redoStage) => void handleRunTask(task, { executionStage: stageId, redoStage })}
        onPause={() => void handlePause()}
      />
      <TaskDeleteDialog
        task={deleteTask}
        busy={taskCacheBusy}
        onClose={() => setDeleteTask(null)}
        onViewCache={(task) => void handleOpenTaskCache(task)}
        onDeleteOnly={(task) => void handleDeleteTask(task, false)}
        onDeleteWithCache={(task) => void handleDeleteTask(task, true)}
      />
      <CacheCleanupDialog
        open={Boolean(cacheTaskId)}
        scan={taskCacheScan}
        selectedPaths={selectedTaskCachePaths}
        busy={taskCacheBusy}
        title="任务缓存"
        ariaLabel="任务缓存"
        emptyMessage="该任务没有独立生成的缓存；复用缓存不会重复归属到当前任务。"
        onTogglePath={(path, checked) => {
          setSelectedTaskCachePaths((current) => {
            const next = new Set(current)
            if (checked) next.add(path)
            else next.delete(path)
            return next
          })
        }}
        onSelectAll={() => setSelectedTaskCachePaths(new Set(taskCacheScan?.items.map((item) => item.path) ?? []))}
        onClearSelection={() => setSelectedTaskCachePaths(new Set())}
        onClose={() => setCacheTaskId('')}
        onConfirm={(paths) => void handleClearTaskCache(paths)}
      />
      {videoContextMenu && createPortal(
        <Translated>
        <div
          className="video-context-menu analysis-video-context-menu"
          style={{ left: videoContextMenu.x, top: videoContextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <strong title={videoContextMenu.video.path}>{videoContextMenu.video.name}</strong>
          <button type="button" role="menuitem" onClick={() => void revealVideo(videoContextMenu.video)}>
            <FolderOpen size={15} />
            文件位置
          </button>
          <button type="button" role="menuitem" onClick={() => void moveVideoFiles(selectedVideosForAction(videoContextMenu.video))} disabled={videoFileBusy}>
            <FolderOpen size={15} />
            移动到目录
          </button>
          <button type="button" role="menuitem" onClick={() => {
            if (!videoMultiSelect) setVideoMultiSelect(true)
            toggleVideoSelection(videoContextMenu.video)
            setVideoContextMenu(null)
          }}>
            <ListChecks size={15} />
            {selectedVideoPaths.has(normalizeVideoPath(videoContextMenu.video.path)) ? '取消选择' : '加入选择'}
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => void deleteVideoFiles(selectedVideosForAction(videoContextMenu.video))} disabled={videoFileBusy}>
            <Trash2 size={15} />
            删除
          </button>
        </div>
        </Translated>,
        document.body,
      )}
    </div>
    </Translated>
  )
}

function TaskStagesDialog({
  task,
  busy,
  activeTaskId,
  now,
  onClose,
  onRun,
  onPause,
}: {
  task: AnalysisTaskRecord | null
  busy: boolean
  activeTaskId: string
  now: number
  onClose: () => void
  onRun: (task: AnalysisTaskRecord, stageId: AnalysisTaskStageId, redoStage: boolean) => void
  onPause: () => void
}) {
  if (!task) return null
  const stages = analysisTaskStages(task)

  return createPortal(
    <Translated>
    <div className="task-detail-backdrop" role="presentation">
      <section className="task-stage-dialog" role="dialog" aria-modal="true" aria-label="分阶段处理">
        <div className="task-detail-head">
          <div>
            <h3>分阶段处理</h3>
            <p title={task.id}>{task.videoDir} · 总进度 {formatPercent(task.progress)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分阶段处理">
            <X size={18} />
          </button>
        </div>

        <div className="task-stage-overall">
          <div className="analysis-history-progress">
            <span style={{ width: `${clampPercent(task.progress)}%` }} />
          </div>
          <span>每次只启动一个阶段；后续阶段必须等待前置阶段完成。</span>
        </div>

        <div className="task-stage-list">
          {stages.map((taskStage, index) => {
            const active = task.id === activeTaskId && task.activeStage === taskStage.id && taskStage.status === 'running'
            const staleRunning = taskStage.status === 'running' && !active
            const prerequisiteReady = canStartAnalysisStage(task, taskStage.id)
            const stageBusy = busy && !active
            return (
              <article className={active ? 'task-stage-item is-active' : 'task-stage-item'} key={taskStage.id}>
                <div className="task-stage-index">{index + 1}</div>
                <div className="task-stage-copy">
                  <div>
                    <strong>{taskStage.label}</strong>
                    <span className={`task-stage-status is-${taskStage.status}`}>{formatTaskStageStatus(taskStage.status)}</span>
                  </div>
                  <p title={taskStage.message}>{taskStage.message || '等待执行'}</p>
                  <div className="task-stage-progress-row">
                    <div className="analysis-history-progress">
                      <span style={{ width: `${clampPercent(taskStage.progress)}%` }} />
                    </div>
                    <b>{Math.round(taskStage.progress)}%</b>
                    <time>
                      <Clock3 size={14} />
                      {formatStageElapsed(taskStage, now)}
                    </time>
                  </div>
                </div>
                <div className="task-stage-actions">
                  <NeonButton
                    variant="outline"
                    type="button"
                    disabled={stageBusy || active || staleRunning || !prerequisiteReady || taskStage.status === 'completed'}
                    onClick={() => onRun(task, taskStage.id, false)}
                  >
                    <Play size={15} />
                    启动
                  </NeonButton>
                  <NeonButton
                    variant="ghost"
                    tone={active ? 'red' : undefined}
                    type="button"
                    disabled={active ? false : stageBusy || (!staleRunning && taskStage.status !== 'paused') || !prerequisiteReady}
                    onClick={() => active ? onPause() : onRun(task, taskStage.id, false)}
                  >
                    {active ? <Pause size={15} /> : <Play size={15} />}
                    {active ? '暂停' : '继续'}
                  </NeonButton>
                  <NeonButton
                    variant="ghost"
                    type="button"
                    disabled={stageBusy || active || !prerequisiteReady}
                    onClick={() => {
                      if (window.confirm(`重做“${taskStage.label}”会重置该阶段及其后续阶段进度，是否继续？`)) {
                        onRun(task, taskStage.id, true)
                      }
                    }}
                  >
                    <RotateCcw size={15} />
                    重做
                  </NeonButton>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
    </Translated>,
    document.body,
  )
}

function TaskDeleteDialog({
  task,
  busy,
  onClose,
  onViewCache,
  onDeleteOnly,
  onDeleteWithCache,
}: {
  task: AnalysisTaskRecord | null
  busy: boolean
  onClose: () => void
  onViewCache: (task: AnalysisTaskRecord) => void
  onDeleteOnly: (task: AnalysisTaskRecord) => void
  onDeleteWithCache: (task: AnalysisTaskRecord) => void
}) {
  if (!task) return null
  return createPortal(
    <Translated>
    <div className="task-detail-backdrop" role="presentation">
      <section className="task-delete-dialog" role="dialog" aria-modal="true" aria-label="删除历史任务">
        <div className="task-detail-head">
          <div>
            <h3>删除历史任务</h3>
            <p title={task.videoDir}>{task.videoDir}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭删除任务提示" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="task-delete-copy">
          <Trash2 size={24} />
          <div>
            <strong>是否删除当前任务产生的缓存？</strong>
            <p>任务元数据和比较断点会始终删除。视频原文件不会被删除；特征缓存可能被其他同配置增量任务复用。</p>
          </div>
        </div>
        <div className="task-delete-actions">
          <NeonButton variant="ghost" type="button" disabled={busy} onClick={() => onViewCache(task)}>
            <Database size={16} />
            查看缓存
          </NeonButton>
          <NeonButton variant="outline" type="button" disabled={busy} onClick={() => onDeleteOnly(task)}>
            否，只删除任务
          </NeonButton>
          <NeonButton tone="red" type="button" disabled={busy} onClick={() => onDeleteWithCache(task)}>
            <Trash2 size={16} />
            删除任务和缓存
          </NeonButton>
        </div>
      </section>
    </div>
    </Translated>,
    document.body,
  )
}

function TaskDetailDialog({
  task,
  onClose,
}: {
  task: AnalysisTaskRecord | null
  onClose: () => void
}) {
  if (!task) return null

  const progress = clampPercent(task.progress)
  const videoRows = task.videos ?? []
  const completedPairs = Math.max(0, task.completedPairs)
  const totalPairs = Math.max(0, task.totalPairs)
  const videoProgressLabel = totalPairs > 0 ? `${completedPairs}/${totalPairs} 对` : '尚未开始'
  const reportRows = buildTaskReportRows(task)
  const configSections = buildTaskConfigSections(task.config)
  const taskCachePath = buildTaskCachePath(task)

  return createPortal(
    <Translated>
    <div
      className="modal-backdrop task-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="task-detail-dialog" role="dialog" aria-modal="true" aria-label="分析任务详情">
        <div className="task-detail-head">
          <div>
            <h3>分析任务详情</h3>
            <p title={task.id}>{task.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭任务详情">
            <X size={18} />
          </button>
        </div>

        <div className="task-detail-status-row">
          <span className={`analysis-history-status ${analysisTaskStatusClass(task)}`}>
            {analysisTaskStatusLabel(task)}
          </span>
          <strong>{formatPercent(progress)}</strong>
          <div className="analysis-history-progress" aria-label="任务总进度">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="task-detail-summary">
          <div>
            <CalendarClock size={17} />
            <span>任务创建时间</span>
            <strong>{formatDateTime(task.createdAt)}</strong>
          </div>
          <div>
            <Film size={17} />
            <span>视频个数</span>
            <strong>{task.videoCount}</strong>
          </div>
          <div>
            <ListChecks size={17} />
            <span>视频完成进度</span>
            <strong>{videoProgressLabel}</strong>
          </div>
          <div>
            <Activity size={17} />
            <span>当前状态</span>
            <strong>{analysisTaskStatusLabel(task)}</strong>
          </div>
        </div>

        <dl className="task-detail-grid">
          <div className="wide">
            <dt>视频路径</dt>
            <dd title={task.videoDir}>{task.videoDir || '-'}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatDateTime(task.updatedAt)}</dd>
          </div>
          <div>
            <dt>比较进度</dt>
            <dd>{videoProgressLabel}</dd>
          </div>
          <div className="wide">
            <dt>当前阶段</dt>
            <dd title={task.stage}>{task.stage || '-'}</dd>
          </div>
          <div className="wide">
            <dt>报告文件</dt>
            <dd className="task-detail-path-stack">
              {reportRows.map((row) => (
                <span title={row.value} key={row.label}>
                  <b>{row.label}</b>
                  {row.value}
                </span>
              ))}
            </dd>
          </div>
          <div className="wide">
            <dt>任务缓存</dt>
            <dd title={taskCachePath}>{taskCachePath}</dd>
          </div>
        </dl>

        <section className="task-detail-section-block">
          <h4>
            <FolderOpen size={17} />
            视频路径列表
          </h4>
          {videoRows.length > 0 ? (
            <div className="task-video-path-list">
              {videoRows.map((video, index) => (
                <div className="task-video-path-item" key={`${video.path}-${index}`}>
                  <strong title={video.path}>{video.path}</strong>
                  <span>{formatOptionalBytes(video.size)} · {formatVideoMtime(video.mtimeMs)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state-text">该任务尚未记录逐个视频路径，当前视频目录：{task.videoDir || '-'}</p>
          )}
        </section>

        <section className="task-detail-section-block">
          <h4>
            <FileText size={17} />
            任务配置
          </h4>
          <div className="task-detail-config-list">
            {configSections.map((section) => (
              <div className="task-detail-config-group" key={section.title}>
                <h5>{section.title}</h5>
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd title={row.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>

        <div className="task-detail-actions">
          <NeonButton variant="outline" type="button" onClick={onClose}>
            关闭
          </NeonButton>
        </div>
      </section>
    </div>
    </Translated>,
    document.body,
  )
}

function PathSummary({
  label,
  value,
  hint,
  onDoubleClick,
}: {
  label: string
  value: string
  hint?: string
  onDoubleClick?: () => void
}) {
  const title = hint ? `${hint}：${value}` : value
  return (
    <Translated>
    <div
      className={onDoubleClick ? 'path-summary-item interactive' : 'path-summary-item'}
      role={onDoubleClick ? 'button' : undefined}
      tabIndex={onDoubleClick ? 0 : undefined}
      title={title}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (!onDoubleClick) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onDoubleClick()
        }
      }}
    >
      <span>{label}{hint ? <em>{hint}</em> : null}</span>
      <strong title={value}>{value}</strong>
    </div>
    </Translated>
  )
}

interface TaskConfigSection {
  title: string
  rows: Array<{ label: string; value: string }>
}

interface VideoContextMenuState {
  x: number
  y: number
  video: VideoFile
}

async function filterScannedVideos(
  videos: VideoFile[],
  filters: VideoScanFilters,
  options: {
    projectRoot?: string
    pythonPath?: string
    onMetadataStart?: () => void
  } = {},
) {
  const enabled = new Set(filters.enabledKeys)
  if (enabled.size === 0) return videos

  const sizeMultiplier = videoScanSizeUnitBytes(filters.sizeUnit)
  const minBytes = positiveNumber(filters.minSizeGb) * sizeMultiplier
  const maxBytes = positiveNumber(filters.maxSizeGb) * sizeMultiplier
  const prefixes = splitFilterTokens(filters.namePrefixes).map((item) => item.toLocaleLowerCase())
  const includes = splitFilterTokens(filters.nameIncludes).map((item) => item.toLocaleLowerCase())
  const extensions = splitFilterTokens(filters.extensions).map((item) => item.replace(/^\./, '').toLocaleLowerCase())

  let next = videos.filter((video) => {
    if (enabled.has('size')) {
      if (minBytes > 0 && video.sizeBytes < minBytes) return false
      if (maxBytes > 0 && video.sizeBytes > maxBytes) return false
    }
    if (enabled.has('name')) {
      const name = video.name.toLocaleLowerCase()
      if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) return false
      if (includes.length > 0 && !includes.some((part) => name.includes(part))) return false
    }
    if (enabled.has('extension') && extensions.length > 0) {
      const extension = video.extension.replace(/^\./, '').toLocaleLowerCase()
      if (!extensions.includes(extension)) return false
    }
    return true
  })

  const needsMetadata = hasMetadataFilters(filters) || needsMetadataSort(filters)
  if (!needsMetadata || next.length === 0) return sortScannedVideos(next, filters)

  options.onMetadataStart?.()
  const metadataRows = await probeVideoMetadata(next.map((video) => video.path), options.projectRoot, options.pythonPath)
  const metadataByPath = new Map(metadataRows.map((metadata) => [normalizeVideoPath(metadata.path), metadata]))
  if (hasMetadataFilters(filters)) {
    next = next.filter((video) => metadataMatchesFilters(metadataByPath.get(normalizeVideoPath(video.path)), filters))
  }
  return sortScannedVideos(next, filters, metadataByPath)
}

function hasMetadataFilters(filters: VideoScanFilters) {
  const enabled = new Set(filters.enabledKeys)
  return (
    (enabled.has('duration') && (positiveNumber(filters.minDurationSec) > 0 || positiveNumber(filters.maxDurationSec) > 0))
    || (enabled.has('fps') && (positiveNumber(filters.minFps) > 0 || positiveNumber(filters.maxFps) > 0))
    || (enabled.has('resolution') && (
      positiveNumber(filters.minWidth) > 0
      || positiveNumber(filters.minHeight) > 0
      || positiveNumber(filters.maxWidth) > 0
      || positiveNumber(filters.maxHeight) > 0
    ))
  )
}

function metadataMatchesFilters(metadata: VideoMetadata | undefined, filters: VideoScanFilters) {
  if (!metadata?.readable) return false
  const enabled = new Set(filters.enabledKeys)
  if (enabled.has('duration')) {
    const durationMultiplier = videoScanDurationUnitSeconds(filters.durationUnit)
    const minDuration = positiveNumber(filters.minDurationSec) * durationMultiplier
    const maxDuration = positiveNumber(filters.maxDurationSec) * durationMultiplier
    if (minDuration > 0 && metadata.duration < minDuration) return false
    if (maxDuration > 0 && metadata.duration > maxDuration) return false
  }
  if (enabled.has('fps')) {
    const minFps = positiveNumber(filters.minFps)
    const maxFps = positiveNumber(filters.maxFps)
    if (minFps > 0 && metadata.fps < minFps) return false
    if (maxFps > 0 && metadata.fps > maxFps) return false
  }
  if (enabled.has('resolution')) {
    const minWidth = positiveNumber(filters.minWidth)
    const minHeight = positiveNumber(filters.minHeight)
    const maxWidth = positiveNumber(filters.maxWidth)
    const maxHeight = positiveNumber(filters.maxHeight)
    if (minWidth > 0 && metadata.width < minWidth) return false
    if (minHeight > 0 && metadata.height < minHeight) return false
    if (maxWidth > 0 && metadata.width > maxWidth) return false
    if (maxHeight > 0 && metadata.height > maxHeight) return false
  }
  return true
}

function needsMetadataSort(filters: VideoScanFilters) {
  return filters.sortBy === 'duration' || filters.sortBy === 'fps' || filters.sortBy === 'resolution'
}

function sortScannedVideos(
  videos: VideoFile[],
  filters: VideoScanFilters,
  metadataByPath = new Map<string, VideoMetadata>(),
) {
  const direction: 1 | -1 = filters.sortDirection === 'desc' ? -1 : 1
  return [...videos].sort((left, right) => {
    const leftMetadata = metadataByPath.get(normalizeVideoPath(left.path))
    const rightMetadata = metadataByPath.get(normalizeVideoPath(right.path))
    const compared = compareVideoByScanSort(left, right, leftMetadata, rightMetadata, filters.sortBy, direction)
    if (compared !== 0) return compared
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      || left.path.localeCompare(right.path, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

function compareVideoByScanSort(
  left: VideoFile,
  right: VideoFile,
  leftMetadata: VideoMetadata | undefined,
  rightMetadata: VideoMetadata | undefined,
  sortBy: VideoScanFilters['sortBy'],
  direction: 1 | -1,
) {
  if (sortBy === 'size') return compareNumbers(left.sizeBytes, right.sizeBytes) * direction
  if (sortBy === 'modified') return compareNumbers(left.modifiedAtMs, right.modifiedAtMs) * direction
  if (sortBy === 'duration') return compareMetadataNumbers(leftMetadata, rightMetadata, (metadata) => metadata.duration, direction)
  if (sortBy === 'fps') return compareMetadataNumbers(leftMetadata, rightMetadata, (metadata) => metadata.fps, direction)
  if (sortBy === 'resolution') {
    return compareMetadataNumbers(leftMetadata, rightMetadata, (metadata) => metadata.width * metadata.height, direction)
      || compareMetadataNumbers(leftMetadata, rightMetadata, (metadata) => metadata.width, direction)
      || compareMetadataNumbers(leftMetadata, rightMetadata, (metadata) => metadata.height, direction)
  }
  return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) * direction
}

function compareMetadataNumbers(
  left: VideoMetadata | undefined,
  right: VideoMetadata | undefined,
  pick: (metadata: VideoMetadata) => number,
  direction: 1 | -1,
) {
  const leftReady = Boolean(left?.readable)
  const rightReady = Boolean(right?.readable)
  if (leftReady !== rightReady) return leftReady ? -1 : 1
  if (!leftReady || !rightReady || !left || !right) return 0
  return compareNumbers(pick(left), pick(right)) * direction
}

function compareNumbers(left: number, right: number) {
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0
  if (!Number.isFinite(left)) return 1
  if (!Number.isFinite(right)) return -1
  return left - right
}

function videoFilesFromTask(task: AnalysisTaskRecord, paths: string[]): VideoFile[] {
  const taskVideos = new Map(task.videos.map((video) => [normalizeVideoPath(video.path), video]))
  return paths.map((path) => {
    const record = taskVideos.get(normalizeVideoPath(path))
    const name = videoNameFromPath(path)
    const extension = name.includes('.') ? name.split('.').pop() || '' : ''
    return {
      path,
      name,
      extension,
      sizeBytes: record?.size ?? 0,
      sizeMb: record?.size ? record.size / 1024 / 1024 : 0,
      modifiedAtMs: record?.mtimeMs ?? 0,
    }
  })
}

function splitFilterTokens(value: string) {
  return value
    .split(/[\s,;，；、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function positiveNumber(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

function videoScanSizeUnitBytes(unit: VideoScanFilters['sizeUnit']) {
  if (unit === 'B') return 1
  if (unit === 'KB') return 1024
  if (unit === 'MB') return 1024 * 1024
  if (unit === 'TB') return 1024 * 1024 * 1024 * 1024
  return 1024 * 1024 * 1024
}

function videoScanDurationUnitSeconds(unit: VideoScanFilters['durationUnit']) {
  if (unit === 'ms') return 0.001
  if (unit === 'min') return 60
  if (unit === 'hour') return 3600
  return 1
}

function videoNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function normalizeVideoPath(path: string) {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
}

function setsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function buildTaskReportRows(task: AnalysisTaskRecord) {
  const rows = [
    { label: 'JSON', value: task.reportJson },
    { label: 'CSV', value: task.reportCsv },
    { label: 'HTML', value: task.reportHtml },
  ].filter((row) => row.value?.trim())
  return rows.length ? rows : [{ label: '报告', value: '尚未生成' }]
}

function buildTaskCachePath(task: AnalysisTaskRecord) {
  const cacheDir = task.config?.cacheDir || 'data'
  return joinDisplayPath(cacheDir, 'cache', 'tasks', task.id || '-')
}

function buildTaskConfigSections(config: RunBatchCompareConfig): TaskConfigSection[] {
  const safeConfig = config || ({} as RunBatchCompareConfig)
  const candidateLimit = Number(safeConfig.candidateLimit)
  return [
    {
      title: '基础位置',
      rows: [
        { label: '分析模式', value: formatAnalysisMode(safeConfig.analysisMode) },
        { label: '视频目录', value: safeConfig.videoDir || '-' },
        { label: '报告目录', value: safeConfig.outputDir || '-' },
        { label: '缓存目录', value: safeConfig.cacheDir || '-' },
      ],
    },
    {
      title: '相似度参数',
      rows: [
        { label: '跳帧阈值', value: formatNumber(safeConfig.skipThreshold, '') },
        { label: '匹配阈值', value: formatNumber(safeConfig.matchThreshold, '') },
        { label: '时间窗口', value: formatNumber(safeConfig.windowSize, ' 秒') },
        { label: '候选数(Top-K)', value: formatNumber(safeConfig.topK, '') },
        {
          label: '精确比较候选数',
          value: Number.isFinite(candidateLimit) && candidateLimit === 0
            ? '全部比较'
            : formatNumber(safeConfig.candidateLimit, ''),
        },
        { label: '最大间隔', value: formatNumber(safeConfig.maxGapSec, ' 秒') },
        { label: '扫描步长', value: formatNumber(safeConfig.frameStep, ' 帧') },
      ],
    },
    {
      title: '片段与预处理',
      rows: [
        { label: '最短片段', value: formatNumber(safeConfig.minSegmentDuration, ' 秒') },
        { label: '最少匹配点', value: formatNumber(safeConfig.minSegmentMatches, '') },
        { label: '偏移容忍', value: formatNumber(safeConfig.offsetTolerance, ' 秒') },
        { label: '自动裁剪黑边', value: formatBoolean(safeConfig.cropBlackBorders) },
        { label: '缩放模式', value: formatResizeMode(safeConfig.resizeMode) },
        { label: '匹配分辨率', value: formatNumber(safeConfig.inputSize, ' px') },
        { label: '竖屏旋转', value: formatPortraitRotation(safeConfig.portraitRotation) },
      ],
    },
    {
      title: '运行与容错',
      rows: [
        { label: '运行设备', value: formatDevice(safeConfig.device) },
        { label: '强制重建缓存', value: formatBoolean(safeConfig.force) },
        { label: '错误容忍', value: formatErrorTolerancePreset(safeConfig.errorTolerancePreset) },
        { label: '严重码流错误上限', value: formatLimit(safeConfig.errorToleranceSevereLimit, ' 条') },
        { label: '缺失画面上限', value: formatLimit(safeConfig.errorToleranceMissingPictureLimit, ' 条') },
        { label: '分析前完整码流校验', value: formatBoolean(safeConfig.errorTolerancePreflightValidation) },
      ],
    },
  ]
}

function joinDisplayPath(base: string, ...parts: string[]) {
  const trimmedBase = (base || '').replace(/[\\/]+$/, '')
  const separator = trimmedBase.includes('\\') ? '\\' : '/'
  return [trimmedBase, ...parts]
    .filter(Boolean)
    .join(separator)
}

function formatNumber(value: unknown, suffix: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${numeric}${suffix}`
}

function formatLimit(value: unknown, suffix: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return numeric === 0 ? '忽略' : `${numeric}${suffix}`
}

function formatBoolean(value: unknown) {
  return value ? '开启' : '关闭'
}

function formatAnalysisMode(value?: string) {
  return value === 'duplicate_file' ? '对比相同文件' : '视频相似度分析'
}

function formatDevice(value?: string) {
  if (value === 'cpu') return '处理器(CPU)'
  if (value === 'cuda') return '显卡加速(CUDA)'
  return '自动(auto)'
}

function formatResizeMode(value?: string) {
  if (value === 'letterbox') return '等比留边(letterbox)'
  if (value === 'center_crop') return '居中裁剪(center_crop)'
  return value || '-'
}

function formatPortraitRotation(value?: string) {
  if (value === 'left_90') return '左转 90 度'
  if (value === 'right_90') return '右转 90 度'
  return value || '-'
}

function formatErrorTolerancePreset(value?: string) {
  if (value === 'strict') return '严格'
  if (value === 'balanced') return '标准'
  if (value === 'lenient') return '宽松'
  if (value === 'failure_only') return '仅失败时'
  if (value === 'custom') return '自定义'
  return value || '-'
}

function formatTaskStageStatus(status: string) {
  if (status === 'running') return '运行中'
  if (status === 'paused') return '已暂停'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '待处理'
}

function formatTaskStagesElapsed(stages: ReturnType<typeof analysisTaskStages>, now: number) {
  const elapsedMs = stages.reduce((sum, taskStage) => {
    let stageElapsed = Math.max(0, taskStage.elapsedMs || 0)
    if (taskStage.status === 'running' && taskStage.startedAt) {
      const startedAt = new Date(taskStage.startedAt).getTime()
      if (Number.isFinite(startedAt)) stageElapsed += Math.max(0, now - startedAt)
    }
    return sum + stageElapsed
  }, 0)
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function taskListsEqual(left: AnalysisTaskRecord[], right: AnalysisTaskRecord[]) {
  if (left.length !== right.length) return false
  return left.every((task, index) => {
    const next = right[index]
    return task.id === next?.id
      && task.updatedAt === next.updatedAt
      && task.status === next.status
      && task.progress === next.progress
      && task.stage === next.stage
  })
}

function pairCountFor(length: number) {
  return length > 1 ? (length * (length - 1)) / 2 : 0
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function formatPercent(value: number) {
  return `${clampPercent(value).toFixed(2)}%`
}

function formatStageDetailTitle(stageDetail: StageDetail) {
  return [stageDetail.title, stageDetail.videoName, stageDetail.detail].filter(Boolean).join('：')
}

function formatElapsed(startedAt: number | null, endedAt: number | null) {
  if (!startedAt) return '00:00:00'
  const end = endedAt ?? Date.now()
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

interface StageDetail {
  title: string
  videoName?: string
  total?: number
  percent?: number
  detail?: string
}

function buildSubTaskDetail(subStage: string, subProgress: number | null): StageDetail | null {
  if (!subStage && subProgress == null) return null
  const percent = clampPercent(subProgress ?? 0)
  return {
    title: subStage || '当前子任务',
    total: 100,
    percent,
    detail: formatPercent(percent),
  }
}

function parseStageDetail(raw?: string): StageDetail | null {
  const stage = raw?.trim()
  if (!stage) return null

  const frameMatch = stage.match(/^(动态抽帧|提取特征|动态抽帧\/提取特征)\s+(\d+)\/(\d+)[:：]\s+(.+?)\s+(\d+)\/(\d+)\s*帧?$/)
  if (frameMatch) {
    const [, phase, videoIndex, videoTotal, videoName, currentText, totalText] = frameMatch
    const current = Number(currentText)
    const total = Number(totalText)
    const percent = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0
    return {
      title: `${phase} ${videoIndex}/${videoTotal}`,
      videoName,
      total,
      percent,
      detail: `${current.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 帧 · ${formatPercent(percent)}`,
    }
  }

  const indexMatch = stage.match(/^(索引视频|索引完成|比较视频对|完成比较|跳过已完成视频对)\s+(\d+)\/(\d+)[:：]\s+(.+)$/)
  if (indexMatch) {
    const [, phase, current, total, videoName] = indexMatch
    const currentValue = Number(current)
    const totalValue = Number(total)
    const percent = totalValue > 0 ? Math.min(100, Math.max(0, (currentValue / totalValue) * 100)) : 0
    return {
      title: `${phase} ${current}/${total}`,
      videoName,
      total: totalValue,
      percent,
      detail: `${currentValue.toLocaleString('zh-CN')} / ${totalValue.toLocaleString('zh-CN')} 项 · ${formatPercent(percent)}`,
    }
  }

  return null
}

function formatOptionalBytes(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? formatBytes(value) : '大小未知'
}

function formatVideoMtime(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '修改时间未知'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatLogStream(stream: 'stdout' | 'stderr') {
  return stream === 'stderr' ? '错误(stderr)' : '输出(stdout)'
}
