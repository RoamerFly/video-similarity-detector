import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, Film, RefreshCw } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import {
  cancelMergeRuntimeInstall,
  formatBytes,
  getMergeRuntimeStatus,
  installMergeRuntime,
  listenMergeRuntimeInstallProgress,
  normalizeBackendError,
  type MergeRuntimeStatus,
  type UpdateDownloadProgress,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

export function MergeRuntimeSettingsCard() {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<MergeRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await getMergeRuntimeStatus())
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    let active = true
    let stop = () => undefined
    void listenMergeRuntimeInstallProgress((payload) => {
      if (active) setProgress(payload)
    }).then((unlisten) => {
      if (!active) unlisten()
      else stop = unlisten
    }).catch((reason) => {
      if (active) setError(normalizeBackendError(reason))
    })
    return () => {
      active = false
      stop()
    }
  }, [])

  async function handleInstall() {
    const action = status?.ready ? '从最新 Release 重新下载并更新' : '下载'
    if (!window.confirm(action + '视频合并环境（FFmpeg / FFprobe）？')) return
    setInstalling(true)
    setError('')
    setProgress({
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: '正在准备视频合并环境更新',
    })
    try {
      setStatus(await installMergeRuntime(proxyUrl))
      setProgress((current) => ({
        downloadedBytes: current?.downloadedBytes ?? 0,
        totalBytes: current?.totalBytes ?? 0,
        progress: 100,
        stage: '视频合并环境已更新',
      }))
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setInstalling(false)
    }
  }

  const progressValue = Math.max(0, Math.min(100, progress?.progress ?? 0))
  return (
    <div className="settings-about-card">
      <div className="about-title">
        {status?.ready ? <CheckCircle2 size={24} /> : <Film size={24} />}
        <h3>视频合并环境</h3>
      </div>
      <div className="about-grid compact">
        <div>
          <span>状态</span>
          <strong>{loading ? '检测中' : status?.ready ? '可用' : '未安装'}</strong>
        </div>
        <div>
          <span>平台</span>
          <strong>{status?.platform || '检测中'}</strong>
        </div>
        <div>
          <span>包版本</span>
          <strong>v{status?.installedVersion ?? status?.expectedVersion ?? '1'}</strong>
        </div>
        <div>
          <span>组件</span>
          <strong>FFmpeg / FFprobe</strong>
        </div>
      </div>
      {status?.runtimeDir ? (
        <p className="update-install-path" title={status.runtimeDir}>
          环境目录：{status.runtimeDir}
        </p>
      ) : null}
      <p className={error ? 'inline-error update-status-copy' : 'update-status-copy'}>
        {error || status?.message || '正在检测视频合并环境。'}
      </p>
      {status?.ffmpegPath ? (
        <p className="update-install-path" title={status.ffmpegPath}>
          FFmpeg：{status.ffmpegPath}
        </p>
      ) : null}
      {progress && (
        <div className="update-progress-block">
          <div>
            <span>{progress.stage}</span>
            <strong>{progressValue.toFixed(0)}%</strong>
          </div>
          <div className="update-progress-track">
            <span style={{ width: String(progressValue) + '%' }} />
          </div>
          <small>
            {formatBytes(progress.downloadedBytes)}
            {progress.totalBytes ? ' / ' + formatBytes(progress.totalBytes) : ''}
          </small>
        </div>
      )}
      <div className="settings-path-actions">
        <NeonButton
          variant="outline"
          type="button"
          onClick={() => void refresh()}
          disabled={loading || installing}
        >
          <RefreshCw size={17} className={loading ? 'spin-slow' : ''} />
          刷新
        </NeonButton>
        {installing ? (
          <NeonButton type="button" onClick={() => void cancelMergeRuntimeInstall()}>
            取消更新
          </NeonButton>
        ) : (
          <NeonButton type="button" onClick={() => void handleInstall()}>
            <Download size={17} />
            {status?.ready ? '更新到最新环境' : '安装环境'}
          </NeonButton>
        )}
      </div>
    </div>
  )
}
