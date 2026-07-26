import { useState } from 'react'
import { CheckCircle2, Clock3, Gauge } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { GlassPanel } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { revealInFolder } from '@/services/backend'
import { useMergeStore } from '@/stores/mergeStore'

export function MergeExportStatus() {
  const [logsExpanded, setLogsExpanded] = useState(false)
  const {
    stage,
    progress,
    error,
    outputPaths,
    logs,
  } = useMergeStore(useShallow((state) => ({
    stage: state.stage,
    progress: state.progress,
    error: state.error,
    outputPaths: state.outputPaths,
    logs: state.logs,
  })))

  return (
    <Translated>
    <GlassPanel className="editor-export-status">
      <div className="merge-run-head">
        <div><Gauge /><span>导出状态</span><strong title={stage}>{stage}</strong></div>
        <b>{progress.toFixed(2)}%</b>
      </div>
      <div className="merge-progress-track"><span style={{ width: `${progress}%` }} /></div>
      {error && <p className="merge-message error">{error}</p>}
      {outputPaths.length > 0 && (
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
      )}
      <button
        type="button"
        className="merge-log-toggle"
        onClick={() => setLogsExpanded((value) => !value)}
      >
        <Clock3 />{`日志 ${logs.length} 行`}
      </button>
      {logsExpanded && (
        <div className="merge-log-view">
          {logs.length > 0
            ? logs.map((log, index) => (
                <div className={log.stream} key={`${log.timestamp}-${index}`}>
                  [{log.stream}] {log.line}
                </div>
              ))
            : <span>暂无日志</span>}
        </div>
      )}
    </GlassPanel>
    </Translated>
  )
}
