import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Film,
  Play,
  RefreshCw,
  Settings,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react'
import { GlassPanel, NeonButton, StatCard } from '@/components/DesignSystem'
import {
  buildRunBatchCompareConfig,
  cancelCurrentTask,
  formatBytes,
  getAppInfo,
  normalizeBackendError,
  runBatchCompare,
  runDuplicateFileCheck,
  scanVideos,
  selectOutputDirectory,
  selectVideoDirectory,
} from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { analysisConfigFromSettings } from '@/types/config'

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
    setAnalysisConfig,
    setRunningStatus,
    setProgress,
    setScannedVideos,
    setScanMessage,
    appendLog,
    clearLogs,
    setReportPaths,
    setErrorMessage,
    setReport,
    setResultSummary,
  } = useAnalysisStore()
  const [isPreparing, setIsPreparing] = useState(false)
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false)
  const [logView, setLogView] = useState<'stdout' | 'stderr'>('stdout')
  const [copyMessage, setCopyMessage] = useState('')
  const [clockNow, setClockNow] = useState(0)
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
  const progressValue = clampPercent(progress)
  const progressLabel = formatPercent(progressValue)
  const elapsedLabel = formatElapsed(runStartedAt, isRunning ? clockNow || runStartedAt : runFinishedAt)
  const stageDetail = useMemo(
    () => buildSubTaskDetail(subStage, subProgress) ?? parseStageDetail(stage),
    [stage, subProgress, subStage],
  )
  const statusTitle = stage || scanMessage

  useEffect(() => {
    if (!isRunning) return undefined
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isRunning])

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
    settings.analysisMode,
    setAnalysisConfig,
  ])

  const statusRows = useMemo(() => {
    const scanned = videos.length > 0
    return [
      {
        label: scanned ? `已扫描 ${videos.length} 个视频` : '等待扫描视频目录',
        time: scanned ? '完成' : '待处理',
        done: scanned,
      },
      {
        label: isDuplicateFileMode
          ? (isRunning ? '正在检查文件指纹' : '等待启动相同文件检查')
          : (isRunning ? '正在调用批量分析脚本' : '等待启动真实分析'),
        time: isRunning ? elapsedLabel : runningStatus === 'success' ? '完成' : '待处理',
        done: runningStatus === 'success',
      },
      {
        label: '分析任务运行时间',
        time: elapsedLabel,
        done: runningStatus === 'success',
      },
      {
        label: runningStatus === 'success' ? '报告已生成' : '等待生成报告文件',
        time: runningStatus === 'success' ? '完成' : '待处理',
        done: runningStatus === 'success',
      },
    ]
  }, [elapsedLabel, isDuplicateFileMode, isRunning, runningStatus, videos.length])

  async function handleScan(dir = settings.videoDir) {
    if (!dir.trim()) {
      setScanMessage('请先到设置页配置视频目录。')
      setErrorMessage('请先到设置页配置视频目录。')
      return []
    }

    setErrorMessage('')
    setScanMessage('正在扫描视频目录...')
    try {
      const found = await scanVideos(dir, true)
      setScannedVideos(found, dir)
      if (found.length === 0) {
        setScanMessage('该目录下未找到支持的视频文件。')
      } else {
        setScanMessage(isDuplicateFileMode
          ? `已扫描 ${found.length} 个视频，将直接检查完全相同文件。`
          : `已扫描 ${found.length} 个视频，预计比较 ${Math.max(0, pairCountFor(found.length))} 对。`)
      }
      return found
    } catch (error) {
      const message = normalizeBackendError(error)
      setScannedVideos([], '')
      setScanMessage(message)
      setErrorMessage(message)
      return []
    }
  }

  async function handleChooseVideoDirectory() {
    if (isBusy) return
    setErrorMessage('')
    try {
      const selected = await selectVideoDirectory()
      if (!selected) return
      useSettingsStore.getState().setVideoDir(selected)
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
      useSettingsStore.getState().setReportDir(selected)
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
      useSettingsStore.getState().setCacheDir(selected)
      setScanMessage('缓存目录已更新。')
      setAnalysisConfig(analysisConfigFromSettings(useSettingsStore.getState()))
    } catch (error) {
      const message = normalizeBackendError(error)
      setScanMessage(message)
      setErrorMessage(message)
    }
  }

  async function handleStartAnalysis() {
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
    setProgress(1, '正在准备分析任务', { subProgress: null, subStage: '' })
    setErrorMessage('')

    const found = scannedDir === config.videoDir && videos.length > 0
      ? videos
      : await handleScan(config.videoDir)
    setIsPreparing(false)
    if (found.length === 0) {
      setErrorMessage('该目录下未找到支持的视频文件。')
      return
    }
    if (found.length < 2) {
      setErrorMessage('至少需要 2 个视频才能进行批量分析。')
      return
    }

    clearLogs()
    setReport(null)
    setResultSummary(null)
    setReportPaths(null)
    setRunningStatus('running')
    setProgress(0, '启动分析任务', { subProgress: null, subStage: '' })
    setErrorMessage('')

    if (config.mode === 'duplicate_file') {
      try {
        appendLog({ stream: 'stdout', line: '相同文件检查已启动：不抽帧，不调用 Python 分析程序。', timestamp: Date.now() })
        const paths = await runDuplicateFileCheck({
          videoDir: config.videoDir,
          outputDir: config.outputDir || currentSettings.reportDir,
          projectRoot: currentSettings.projectRoot,
          recursive: true,
        })
        setReportPaths(paths)
        setRunningStatus('success')
        setProgress(100, '相同文件检查完成', { subProgress: 100, subStage: '已生成重复文件报告' })
        appendLog({ stream: 'stdout', line: '相同文件检查完成，已生成报告并进入结果页。', timestamp: Date.now() })
        navigate('/results')
      } catch (error) {
        setRunningStatus('error')
        setErrorMessage(normalizeBackendError(error))
        setProgress(100, '相同文件检查失败')
      }
      return
    }

    try {
      const paths = await runBatchCompare(buildRunBatchCompareConfig(currentSettings, config))
      setReportPaths(paths)
      setProgress(2, '分析已进入后台运行，等待实时进度')
      appendLog({ stream: 'stdout', line: '后台分析任务已启动，完成后会自动进入结果页。', timestamp: Date.now() })
    } catch (error) {
      const currentStatus = useAnalysisStore.getState().runningStatus
      if (currentStatus !== 'cancelled') {
        setRunningStatus('error')
        setErrorMessage(normalizeBackendError(error))
        setProgress(100, '分析失败')
      }
    }
  }

  async function handleCancel() {
    try {
      await cancelCurrentTask()
      appendLog({ stream: 'stderr', line: '已请求取消分析，正在等待任务安全停止。', timestamp: Date.now() })
      setRunningStatus('cancelled')
      setProgress(progress, '分析已取消')
      setErrorMessage('分析已取消。')
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    }
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

  return (
    <>
      <div className="route-fill analyze-simple-page">
        <GlassPanel className="analysis-launch-panel">
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
            <NeonButton variant="outline" onClick={() => void handleScan()} disabled={isBusy}>
              <RefreshCw size={20} />
              扫描视频
            </NeonButton>
            {isRunning ? (
              <NeonButton className="start-analysis-button compact" tone="red" onClick={() => void handleCancel()}>
                <Square size={21} fill="currentColor" />
                取消分析
              </NeonButton>
            ) : (
              <NeonButton className="start-analysis-button compact" onClick={() => void handleStartAnalysis()} disabled={isPreparing}>
                <Play size={22} fill="currentColor" />
                {isPreparing ? '准备中' : '开始分析'}
              </NeonButton>
            )}
            <NeonButton variant="ghost" onClick={() => navigate('/settings')}>
              <Settings size={20} />
              打开设置
            </NeonButton>
          </div>
        </GlassPanel>

        <GlassPanel className="run-status-panel analyze-status-panel">
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
              <div className="status-item" key={row.label} title={`${row.label}：${row.time}`}>
                <span className={row.done ? 'status-dot blue' : 'status-dot pink'} />
                <span>{row.label}</span>
                <time>{row.time}</time>
                {row.done ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              </div>
            ))}
          </div>

          {(errorMessage || runningStatus === 'cancelled') && (
            <p className="inline-error">{errorMessage || '分析已取消。'}</p>
          )}
        </GlassPanel>

        <GlassPanel className="analysis-overview-panel">
          <div className="preview-stats compact">
            <StatCard title="视频数量" value={videos.length} icon={<Film />} tone="blue" />
            <StatCard title={isDuplicateFileMode ? '检查方式' : '比较对数'} value={isDuplicateFileMode ? '指纹' : pairCount} icon={<BarChart3 />} tone="purple" />
            <StatCard title="运行时间" value={elapsedLabel} icon={<Activity />} tone="cyan" />
            <StatCard title="日志行数" value={totalLogCount} icon={<Activity />} tone="pink" />
          </div>

          {videos.length > 0 ? (
            <div className="video-list-strip compact">
              {videos.slice(0, 10).map((video) => (
                <span title={video.path} key={video.path}>
                  {video.name}
                  <small>{formatBytes(video.sizeBytes)}</small>
                </span>
              ))}
            </div>
          ) : (
            <p className="empty-state-text">{scanMessage}</p>
          )}

          <div className="log-peek-row">
            <div className="log-peek-copy">
              <Terminal size={17} />
              <span>{totalLogCount > 0 ? `${totalLogCount} 条日志` : '暂无日志'}</span>
              <small title={latestLog?.line}>{latestLog?.line ?? '分析运行时可从底部打开实时日志。'}</small>
            </div>
            <button type="button" onClick={() => setIsLogDrawerOpen(true)}>
              <ChevronUp size={16} />
              打开日志
            </button>
          </div>
        </GlassPanel>
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
    </>
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
  )
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

function formatLogStream(stream: 'stdout' | 'stderr') {
  return stream === 'stderr' ? '错误(stderr)' : '输出(stdout)'
}
