import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, HardDrive, RefreshCw, Trash2 } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import {
  formatBytes,
  getRuntimeStatus,
  installRuntime,
  listenRuntimeInstallProgress,
  migrateLegacyRuntime,
  normalizeBackendError,
  removeLegacyRuntime,
  type RuntimeStatus,
  type UpdateDownloadProgress,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

export function RuntimeSettingsCard() {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await getRuntimeStatus())
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
    void listenRuntimeInstallProgress((payload) => {
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
    const canMigrate = status?.legacyFallback && status.legacyMigrationAvailable
    const action = status?.managed ? '从最新 Release 重新下载并更新' : canMigrate ? '就地登记现有环境' : '下载'
    if (!window.confirm(`${action} ${status?.flavor === 'gpu' ? 'GPU / CUDA' : 'CPU'} 运行环境？`)) return
    setInstalling(true)
    setError('')
    setProgress({
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: canMigrate ? '正在准备本地迁移（无需下载）' : '正在准备运行环境安装',
    })
    try {
      setStatus(canMigrate ? await migrateLegacyRuntime() : await installRuntime(proxyUrl))
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setInstalling(false)
    }
  }

  async function handleCleanup() {
    const legacyPath = status?.legacyRuntimeDir || '旧版内置目录'
    if (!window.confirm(`确认删除旧版运行环境？\n${legacyPath}\n\n当前托管环境不会受影响。`)) return
    setInstalling(true)
    setError('')
    try {
      setStatus(await removeLegacyRuntime())
      setProgress(null)
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setInstalling(false)
    }
  }

  const percentage = Math.max(0, Math.min(100, progress?.progress ?? 0))
  return (
    <div className="settings-about-card">
      <div className="about-title">
        {status?.ready ? <CheckCircle2 size={24} /> : <HardDrive size={24} />}
        <h3>AI 运行环境</h3>
      </div>
      <div className="about-grid compact">
        <div>
          <span>状态</span>
          <strong>{loading ? '检测中' : status?.ready ? '可用' : '未安装'}</strong>
        </div>
        <div>
          <span>环境</span>
          <strong>{status?.flavor === 'gpu' ? 'GPU / CUDA' : 'CPU'}</strong>
        </div>
        <div>
          <span>版本</span>
          <strong>v{status?.installedVersion ?? status?.expectedVersion ?? '1'}</strong>
        </div>
        <div>
          <span>存储方式</span>
          <strong>{status?.managed ? '安装目录 env' : status?.legacyFallback ? '现有 env' : '待安装'}</strong>
        </div>
      </div>
      {status?.runtimeDir && (
        <p className="update-install-path" title={status.runtimeDir}>
          运行环境目录：{status.runtimeDir}
        </p>
      )}
      <p className={error ? 'inline-error update-status-copy' : 'update-status-copy'}>
        {error || status?.message || '正在检测运行环境。'}
      </p>
      {progress && (
        <div className="update-progress-block">
          <div>
            <span>{progress.stage}</span>
            <strong>{percentage.toFixed(0)}%</strong>
          </div>
          <div className="update-progress-track">
            <span style={{ width: `${percentage}%` }} />
          </div>
          <small>
            {formatBytes(progress.downloadedBytes)}
            {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
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
          <RefreshCw size={17} />
          刷新
        </NeonButton>
        <NeonButton
          type="button"
          onClick={() => void handleInstall()}
          disabled={installing}
        >
          <Download size={17} />
          {installing
            ? '处理中'
            : status?.managed
              ? '更新/重装最新环境'
              : status?.legacyFallback && status.legacyMigrationAvailable
                ? '就地登记'
                : status?.legacyFallback
                  ? '重新安装环境'
                  : '安装环境'}
        </NeonButton>
        {status?.legacyCleanupAvailable && (
          <NeonButton
            variant="outline"
            type="button"
            onClick={() => void handleCleanup()}
            disabled={installing}
          >
            <Trash2 size={17} />
            清理旧环境
          </NeonButton>
        )}
      </div>
    </div>
  )
}
