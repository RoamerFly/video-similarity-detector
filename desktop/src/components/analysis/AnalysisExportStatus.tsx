import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, Clipboard, FolderOpen, Gauge, Pause, Play, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { GlassPanel } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { useI18n } from '@/i18n/useI18n'
import { normalizeBackendError, revealInFolder } from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import type { ReportPaths, RunningStatus } from '@/stores/analysisStore'

type AnalysisStatusTab = 'progress' | 'logs'

/**
 * Text shown in the collapsed analysis capsule. Keep this formatter pure so
 * the terminal state cannot be confused with a stale 100% progress update.
 */
// eslint-disable-next-line react-refresh/only-export-components -- exported pure formatter is covered by its focused unit test.
export function analysisExportCompactText(
  progress: number,
  runningStatus: RunningStatus,
  errorMessage: string,
) {
  if (errorMessage.trim() || runningStatus === 'error') return '分析失败'
  if (runningStatus === 'cancelled') return '已取消'
  if (runningStatus === 'success') return '已完成'
  if (runningStatus === 'paused') return '已暂停'
  if (runningStatus === 'running' && progress > 0 && progress < 100) return `${progress.toFixed(0)}%`
  if (runningStatus === 'running') return '分析中'
  return progress >= 100 ? '已完成' : '分析'
}

function formatAnalysisLogStream(stream: 'stdout' | 'stderr') {
  return stream === 'stderr' ? '错误(stderr)' : '输出(stdout)'
}

function isPercentageStatus(value: string) {
  return /^\d+(?:\.\d+)?%$/.test(value)
}

interface AnalysisReportEntry {
  label: string
  path: string
}

interface AnalysisExportStatusProps {
  /**
   * Sidebar owns this state so the analysis and merge capsules cannot both
   * occupy the expanded overlay at the same time.
   */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

function analysisReportEntries(reportPaths: ReportPaths | null): AnalysisReportEntry[] {
  if (!reportPaths) return []
  return [
    { label: 'JSON', path: reportPaths.reportJson },
    { label: 'CSV', path: reportPaths.reportCsv },
    { label: 'HTML', path: reportPaths.reportHtml },
  ].filter((entry): entry is AnalysisReportEntry => Boolean(entry.path.trim()))
}

export function AnalysisExportStatus({
  expanded: controlledExpanded,
  onExpandedChange,
}: AnalysisExportStatusProps = {}) {
  const { t, tm } = useI18n()
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = controlledExpanded ?? internalExpanded
  const setExpanded = onExpandedChange ?? setInternalExpanded
  const [activeTab, setActiveTab] = useState<AnalysisStatusTab>('progress')
  const [logView, setLogView] = useState<'stdout' | 'stderr'>('stdout')
  const [copyMessage, setCopyMessage] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const logsViewportRef = useRef<HTMLDivElement>(null)
  const {
    runningStatus,
    progress,
    stage,
    subProgress,
    subStage,
    logs,
    totalLogCount,
    logsDropped,
    reportPaths,
    errorMessage,
    clearLogs,
    setErrorMessage,
  } = useAnalysisStore(useShallow((state) => ({
    runningStatus: state.runningStatus,
    progress: state.progress,
    stage: state.stage,
    subProgress: state.subProgress,
    subStage: state.subStage,
    logs: state.logs,
    totalLogCount: state.totalLogCount,
    logsDropped: state.logsDropped,
    reportPaths: state.reportPaths,
    errorMessage: state.errorMessage,
    clearLogs: state.clearLogs,
    setErrorMessage: state.setErrorMessage,
  })))

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
  const reportEntries = analysisReportEntries(reportPaths)
  const compactText = analysisExportCompactText(progress, runningStatus, errorMessage)
  const compactLabel = isPercentageStatus(compactText)
    ? `${t('分析')} ${compactText}`
    : t(compactText)
  const statusLabel = errorMessage.trim()
    ? errorMessage
    : runningStatus === 'success'
      ? t('分析完成')
      : runningStatus === 'cancelled'
        ? t('分析已取消。')
        : runningStatus === 'paused'
          ? t('任务已暂停，可从任务列表继续')
          : stage || t('尚未运行分析')

  const revealReportFolder = async () => {
    const reportPath = reportEntries[0]?.path
    if (!reportPath || runningStatus === 'running' || errorMessage) return
    try {
      await revealInFolder(reportPath)
    } catch (error) {
      setErrorMessage(normalizeBackendError(error))
    }
  }

  useEffect(() => {
    if (!expanded) return
    const collapseOutside = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setExpanded(false)
    }
    const collapseOnBlur = () => setExpanded(false)
    document.addEventListener('pointerdown', collapseOutside)
    window.addEventListener('blur', collapseOnBlur)
    return () => {
      document.removeEventListener('pointerdown', collapseOutside)
      window.removeEventListener('blur', collapseOnBlur)
    }
  }, [expanded, setExpanded])

  useEffect(() => {
    if (!expanded || activeTab !== 'logs') return
    const viewport = logsViewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [activeTab, expanded, logs.length])

  async function handleCopyLogs() {
    try {
      const retainedNote = logsDropped > 0
        ? [tm(`已省略较早的 ${logsDropped} 行日志，仅复制最近 ${logs.length} 行。`)]
        : []
      await navigator.clipboard.writeText([
        ...retainedNote,
        ...visibleLogs.map((log) => `[${log.stream}] ${log.line}`),
      ].join('\n'))
      setCopyMessage(`${t(logView === 'stderr' ? '错误' : '正常')}${t('输出已复制')}`)
      window.setTimeout(() => setCopyMessage(''), 1500)
    } catch (error) {
      setErrorMessage(`复制日志失败：${normalizeBackendError(error)}`)
    }
  }

  return (
    <Translated>
      <GlassPanel ref={panelRef} className={`editor-export-status analysis-export-status ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
        <div
          className="merge-export-pill-head"
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setExpanded(!expanded)
            }
          }}
          aria-expanded={expanded}
          aria-controls="analysis-export-status-body"
          title={expanded ? '收起导出状态和日志' : '展开导出状态和日志'}
        >
          <Gauge />
          <span>{expanded ? '分析状态与日志' : compactLabel}</span>
          {expanded && <strong title={stage}>{stage}</strong>}
          {expanded && <b>{progress.toFixed(2)}%</b>}
          {(runningStatus === 'running' || runningStatus === 'paused') && (
            <button
              type="button"
              className="analysis-capsule-action"
              title={runningStatus === 'running' ? '暂停' : '继续'}
              aria-label={runningStatus === 'running' ? '暂停' : '继续'}
              onClick={(event) => {
                event.stopPropagation()
                window.dispatchEvent(new CustomEvent('analysis-task-action', {
                  detail: { action: runningStatus === 'running' ? 'pause' : 'resume' },
                }))
              }}
            >
              {runningStatus === 'running' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </button>
          )}
          <ChevronDown className="merge-export-pill-chevron" aria-hidden="true" />
        </div>

        <div className="merge-export-pill-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>

        {expanded && (
          <div id="analysis-export-status-body" className="merge-export-pill-body">
            <div className="merge-export-pill-tabs" role="tablist" aria-label="导出信息">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'progress'}
                className={activeTab === 'progress' ? 'active' : ''}
                onClick={() => setActiveTab('progress')}
              >
                进度
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'logs'}
                className={activeTab === 'logs' ? 'active' : ''}
                onClick={() => setActiveTab('logs')}
              >
                日志 <span>{totalLogCount}</span>
              </button>
            </div>

            {activeTab === 'progress' ? (
              <div className="merge-export-progress-tab" role="tabpanel">
                <div className="merge-export-progress-summary">
                  <div>
                    <span>当前阶段</span>
                    <strong title={statusLabel}>{statusLabel}</strong>
                  </div>
                  <b>{progress.toFixed(2)}%</b>
                </div>
                <div className="merge-progress-track"><span style={{ width: `${progress}%` }} /></div>
                {(subStage || subProgress !== null) && (
                  <div className="analysis-export-substage">
                    <span>子阶段</span>
                    <strong title={subStage || undefined}>{subStage || t('进行中')}</strong>
                    {subProgress !== null && <b>{subProgress.toFixed(2)}%</b>}
                    {subProgress !== null && <div className="merge-progress-track"><span style={{ width: `${subProgress}%` }} /></div>}
                  </div>
                )}
                {errorMessage && <p className="merge-message error">{errorMessage}</p>}
                {reportEntries.length > 0 ? (
                  <div className="merge-output-list">
                    <p><CheckCircle2 />{t(`分析报告已生成（${reportEntries.length} 个文件）`)}</p>
                    {!errorMessage && runningStatus !== 'running' && (
                      <button type="button" className="merge-output-folder-button" onClick={() => void revealReportFolder()}>
                        <FolderOpen />前往报告文件夹
                      </button>
                    )}
                    {reportEntries.map((entry) => (
                      <button
                        type="button"
                        key={entry.path}
                        disabled={runningStatus === 'running' || Boolean(errorMessage)}
                        title={entry.path}
                        onClick={() => void revealInFolder(entry.path).catch((error) => setErrorMessage(normalizeBackendError(error)))}
                      >
                        {entry.label}：{entry.path}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="merge-export-pill-empty">暂无分析报告</div>
                )}
              </div>
            ) : (
              <div className="merge-export-logs-tab" role="tabpanel">
                <div className="log-toolbar">
                  <div className="log-view-tabs" role="tablist" aria-label="日志输出类型">
                    <button
                      className={logView === 'stdout' ? 'active' : ''}
                      type="button"
                      role="tab"
                      aria-selected={logView === 'stdout'}
                      onClick={() => setLogView('stdout')}
                    >
                      正常输出 <b>{logSummary.stdout.length}</b>
                    </button>
                    <button
                      className={logView === 'stderr' ? 'active error' : 'error'}
                      type="button"
                      role="tab"
                      aria-selected={logView === 'stderr'}
                      onClick={() => setLogView('stderr')}
                    >
                      错误输出 <b>{logSummary.stderr.length}</b>
                    </button>
                  </div>
                  <div className="merge-export-log-tools">
                    <button type="button" onClick={() => void handleCopyLogs()} disabled={visibleLogs.length === 0} title="复制日志" aria-label="复制日志">
                      <Clipboard />
                    </button>
                    <button type="button" onClick={clearLogs} disabled={logs.length === 0} title="清空日志" aria-label="清空日志">
                      <Trash2 />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const viewport = logsViewportRef.current
                        if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
                      }}
                      title="滚动到底部"
                      aria-label="滚动到底部"
                    >
                      <ArrowDown />
                    </button>
                  </div>
                </div>
                <div className="analysis-log-toolbar-copy">
                  <span>
                    Python 标准输出(stdout) / 错误输出(stderr)
                    {logsDropped > 0 ? ` · 已保留最近 ${logs.length} 行，省略 ${logsDropped} 行` : ''}
                  </span>
                </div>
                {copyMessage && <span className="copy-message">{copyMessage}</span>}
                <div ref={logsViewportRef} className="merge-log-view analysis-export-log-view">
                  {visibleLogs.length > renderedLogs.length && (
                    <div className="merge-export-log-more">为保持界面流畅，仅渲染当前窗口最近 {renderedLogs.length} 行；复制仍包含全部保留日志。</div>
                  )}
                  {renderedLogs.length > 0
                    ? renderedLogs.map((log, index) => (
                      <div className={log.stream} key={`${log.timestamp}-${index}`}>
                        <time>[{new Date(log.timestamp).toLocaleTimeString()}]</time>
                        [{formatAnalysisLogStream(log.stream)}] {log.line}
                      </div>
                    ))
                    : <div className="merge-export-pill-empty">{logView === 'stderr' ? '当前没有错误输出。' : '当前没有正常输出。'}</div>}
                </div>
              </div>
            )}
          </div>
        )}
      </GlassPanel>
    </Translated>
  )
}
