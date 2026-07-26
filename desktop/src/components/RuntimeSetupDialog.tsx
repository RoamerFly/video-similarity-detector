import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, HardDrive, RefreshCw, X } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import {
  cancelRuntimeInstall,
  getRuntimeStatus,
  installRuntime,
  listenRuntimeInstallProgress,
  normalizeBackendError,
  type RuntimeStatus,
  type UpdateDownloadProgress,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

export function RuntimeSetupDialog() {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)

  const refresh = useCallback(async () => {
    setChecking(true)
    setError('')
    try {
      setStatus(await getRuntimeStatus())
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setChecking(false)
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
    })
      .then((unlisten) => {
        if (!active) unlisten()
        else stop = unlisten
      })
      .catch((reason) => {
        if (active) setError(normalizeBackendError(reason))
      })
    return () => {
      active = false
      stop()
    }
  }, [])

  async function handleInstall() {
    setInstalling(true)
    setError('')
    setProgress({
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: '正在准备下载',
    })
    try {
      const nextStatus = await installRuntime(proxyUrl)
      setStatus(nextStatus)
      if (nextStatus.ready) setDismissed(true)
    } catch (reason) {
      setError(normalizeBackendError(reason))
    } finally {
      setInstalling(false)
    }
  }

  if (dismissed || checking || status?.ready) return null

  const percentage = Math.max(0, Math.min(100, progress?.progress ?? 0))
  return createPortal(
    <Translated>
      <div className="close-dialog-backdrop runtime-setup-backdrop" role="presentation">
        <section
          className="close-dialog runtime-setup-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="runtime-setup-title"
        >
          <div className="runtime-setup-heading">
            <span className="runtime-setup-icon"><HardDrive size={28} /></span>
            <div>
              <h2 id="runtime-setup-title">初始化 AI 运行环境</h2>
              <p>
                应用本体已与 Python/CUDA 环境分离。此运行环境只需下载一次，后续小版本更新不会重复下载。
              </p>
            </div>
          </div>

          <div className="runtime-setup-meta">
            <div>
              <span>运行环境</span>
              <strong>{status?.flavor === 'gpu' ? 'GPU / CUDA' : 'CPU'}</strong>
            </div>
            <div>
              <span>环境版本</span>
              <strong>v{status?.expectedVersion ?? '1'}</strong>
            </div>
          </div>

          <p className="runtime-setup-path" title={status?.runtimeDir}>
            安装位置：{status?.runtimeDir}
          </p>
          <p className={error ? 'inline-error runtime-setup-message' : 'runtime-setup-message'}>
            {error || status?.message}
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

          <div className="close-dialog-actions runtime-setup-actions">
            <NeonButton
              variant="ghost"
              type="button"
              onClick={() => setDismissed(true)}
              disabled={installing}
            >
              <X size={17} />
              稍后处理
            </NeonButton>
            <NeonButton
              variant="outline"
              type="button"
              onClick={() => void (installing ? cancelRuntimeInstall() : refresh())}
            >
              <RefreshCw size={17} />
              {installing ? '取消下载' : '重新检测'}
            </NeonButton>
            <NeonButton
              type="button"
              onClick={() => void handleInstall()}
              disabled={installing}
            >
              <Download size={17} />
              {installing ? '正在安装' : '下载并安装'}
            </NeonButton>
          </div>
        </section>
      </div>
    </Translated>,
    document.body,
  )
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
