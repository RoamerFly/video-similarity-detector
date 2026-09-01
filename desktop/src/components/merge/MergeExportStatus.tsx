import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, FolderOpen, Gauge, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { GlassPanel } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { useI18n } from '@/i18n/useI18n'
import { normalizeBackendError, revealInFolder } from '@/services/backend'
import { useMergeRuntimeStore } from '@/stores/mergeRuntimeStore'

type ExportStatusTab = 'progress' | 'logs'

interface MergeExportStatusProps {
  /**
   * Sidebar owns this state so the merge and analysis capsules cannot both
   * occupy the expanded overlay at the same time.
   */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

// eslint-disable-next-line react-refresh/only-export-components -- exported pure formatter is covered by its focused unit test.
export function mergeExportCompactText(progress: number, error: string) {
  if (error.trim()) return '导出失败'
  if (progress > 0 && progress < 100) return `${progress.toFixed(0)}%`
  if (progress >= 100) return '已完成'
  return '导出'
}

export function MergeExportStatus({
  expanded: controlledExpanded,
  onExpandedChange,
}: MergeExportStatusProps = {}) {
  const { t } = useI18n()
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = controlledExpanded ?? internalExpanded
  const setExpanded = onExpandedChange ?? setInternalExpanded
  const [activeTab, setActiveTab] = useState<ExportStatusTab>('progress')
  const panelRef = useRef<HTMLElement>(null)
  const logsViewportRef = useRef<HTMLDivElement>(null)
  const {
    stage,
    progress,
    error,
    outputPaths,
    logs,
    clearLogs,
    running,
    setError,
  } = useMergeRuntimeStore(useShallow((state) => ({
    stage: state.stage,
    progress: state.progress,
    error: state.error,
    outputPaths: state.outputPaths,
    logs: state.logs,
    clearLogs: state.clearLogs,
    running: state.running,
    setError: state.setError,
  })))

  const revealOutputFolder = async () => {
    const outputPath = outputPaths[0]
    if (!outputPath || running || error) return
    try {
      await revealInFolder(outputPath)
    } catch (revealError) {
      setError(normalizeBackendError(revealError))
    }
  }

  useEffect(() => {
    if (!expanded) return

    const collapseOutside = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
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

  const visibleLogs = logs.slice(-300)
  const hiddenLogCount = Math.max(0, logs.length - visibleLogs.length)
  const compactText = mergeExportCompactText(progress, error)
  const compactLabel = /^\d+(?:\.\d+)?%$/.test(compactText)
    ? `${t('导出')} ${compactText}`
    : t(compactText)

  return (
    <Translated>
    <GlassPanel ref={panelRef} className={`editor-export-status ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <button
        type="button"
        className="merge-export-pill-head"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="merge-export-status-body"
        title={expanded ? '收起导出状态和日志' : '展开导出状态和日志'}
      >
        <Gauge />
        <span>{expanded ? '导出状态与日志' : compactLabel}</span>
        {expanded && <strong title={stage}>{stage}</strong>}
        {expanded && <b>{progress.toFixed(2)}%</b>}
        <ChevronDown className="merge-export-pill-chevron" aria-hidden="true" />
      </button>

      <div className="merge-export-pill-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>

      {expanded && (
        <div id="merge-export-status-body" className="merge-export-pill-body">
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
              日志 <span>{logs.length}</span>
            </button>
          </div>

          {activeTab === 'progress' ? (
            <div className="merge-export-progress-tab" role="tabpanel">
              <div className="merge-export-progress-summary">
                <div>
                  <span>当前阶段</span>
                  <strong title={stage}>{stage}</strong>
                </div>
                <b>{progress.toFixed(2)}%</b>
              </div>
              <div className="merge-progress-track"><span style={{ width: `${progress}%` }} /></div>
              {error && <p className="merge-message error">{error}</p>}
              {outputPaths.length > 0 ? (
                <div className="merge-output-list">
                  <p><CheckCircle2 />{`${outputPaths.length} 个输出文件已生成`}</p>
                  {!running && !error && (
                    <button type="button" className="merge-output-folder-button" onClick={() => void revealOutputFolder()}>
                      <FolderOpen />前往输出文件夹
                    </button>
                  )}
                  {outputPaths.map((path) => (
                    <button
                      type="button"
                      key={path}
                      disabled={running || Boolean(error)}
                      title={path}
                      onClick={() => void revealInFolder(path).catch((revealError) => setError(normalizeBackendError(revealError)))}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="merge-export-pill-empty">暂无输出文件</div>
              )}
            </div>
          ) : (
            <div className="merge-export-logs-tab" role="tabpanel">
              <div className="merge-export-log-tools">
                <button type="button" onClick={clearLogs} title="清空日志" aria-label="清空日志">
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
              <div ref={logsViewportRef} className="merge-log-view">
                {hiddenLogCount > 0 && <div className="merge-export-log-more">已折叠较早的 {hiddenLogCount} 条日志</div>}
                {visibleLogs.length > 0
                  ? visibleLogs.map((log, index) => (
                      <div className={log.stream} key={`${log.timestamp}-${index}`}>
                        <time>[{new Date(log.timestamp).toLocaleTimeString()}]</time>
                        [{log.stream}] {log.line}
                      </div>
                    ))
                  : <div className="merge-export-pill-empty">等待导出日志</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </GlassPanel>
    </Translated>
  )
}
