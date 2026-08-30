import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, ChevronDown, Gauge, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { GlassPanel } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { revealInFolder } from '@/services/backend'
import { useMergeStore } from '@/stores/mergeStore'

type ExportStatusTab = 'progress' | 'logs'

export function MergeExportStatus() {
  const [expanded, setExpanded] = useState(false)
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
  } = useMergeStore(useShallow((state) => ({
    stage: state.stage,
    progress: state.progress,
    error: state.error,
    outputPaths: state.outputPaths,
    logs: state.logs,
    clearLogs: state.clearLogs,
  })))

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
  }, [expanded])

  useEffect(() => {
    if (!expanded || activeTab !== 'logs') return
    const viewport = logsViewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [activeTab, expanded, logs.length])

  const visibleLogs = logs.slice(-300)
  const hiddenLogCount = Math.max(0, logs.length - visibleLogs.length)
  const compactText = progress > 0 && progress < 100
    ? `${progress.toFixed(0)}%`
    : progress >= 100
      ? '已完成'
      : '导出'

  return (
    <Translated>
    <GlassPanel ref={panelRef} className={`editor-export-status ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <button
        type="button"
        className="merge-export-pill-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls="merge-export-status-body"
        title={expanded ? '收起导出状态和日志' : '展开导出状态和日志'}
      >
        <Gauge />
        <span>{expanded ? '导出状态与日志' : compactText}</span>
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
                  {outputPaths.map((path) => (
                    <button
                      type="button"
                      key={path}
                      title={path}
                      onClick={() => void revealInFolder(path)}
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
