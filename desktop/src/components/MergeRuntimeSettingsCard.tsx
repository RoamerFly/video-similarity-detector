import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleStop, Download, Film, RefreshCw } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import {
  cancelMergeRuntimeInstall,
  formatBytes,
  getRuntimeDownloadStatus,
  getMergeRuntimeStatus,
  installMergeRuntime,
  listenMergeRuntimeInstallProgress,
  normalizeBackendError,
  type MergeRuntimeStatus,
  type DownloadTaskStatus,
  type UpdateDownloadProgress,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

interface MergeRuntimeDownloadSnapshot {
  active: boolean
  progress: UpdateDownloadProgress | null
  error: string
  generation: number
}

const mergeRuntimeDownloadSnapshot: MergeRuntimeDownloadSnapshot = {
  active: false,
  progress: null,
  error: '',
  generation: 0,
}

type MergeRuntimeTerminal = 'success' | 'cancelled' | 'failed'

// A 100% progress event can precede archive commit/configuration. Only the
// status endpoint can release the install action.
// eslint-disable-next-line react-refresh/only-export-components
export function mergeRuntimeStatusTerminal(status: DownloadTaskStatus): MergeRuntimeTerminal | null {
  const stage = status.stage.trim()
  if (status.task !== 'merge-runtime' || status.running || /正在取消/.test(stage)) return null
  if (status.cancelled || /已取消|取消完成/.test(stage)) return 'cancelled'
  if (/失败|错误/.test(stage)) return 'failed'
  if (/已安装|安装完成|已完成/.test(stage)) return 'success'
  return null
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeRuntimeStatusHasSettled(status: DownloadTaskStatus, expected?: MergeRuntimeTerminal) {
  const terminal = mergeRuntimeStatusTerminal(status)
  return terminal !== null && (expected === undefined || terminal === expected)
}

function progressFromMergeRuntimeStatus(status: DownloadTaskStatus): UpdateDownloadProgress {
  return {
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes,
    progress: status.progress,
    stage: status.stage,
  }
}

async function waitForMergeRuntimeDownloadSettlement(expected?: MergeRuntimeTerminal) {
  let status: DownloadTaskStatus | null = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    status = await getRuntimeDownloadStatus().catch(() => null)
    if (status && mergeRuntimeStatusHasSettled(status, expected)) return status
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
  }
  return status
}

function beginMergeRuntimeTask() {
  const generation = mergeRuntimeDownloadSnapshot.generation + 1
  mergeRuntimeDownloadSnapshot.generation = generation
  mergeRuntimeDownloadSnapshot.active = true
  return generation
}

export function MergeRuntimeSettingsCard() {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<MergeRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(mergeRuntimeDownloadSnapshot.active)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(mergeRuntimeDownloadSnapshot.progress)
  const [error, setError] = useState(mergeRuntimeDownloadSnapshot.error)
  const operationRef = useRef(0)
  const statusRequestRef = useRef(0)

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
    const sync = async () => {
      const request = statusRequestRef.current + 1
      statusRequestRef.current = request
      const next = await getRuntimeDownloadStatus().catch(() => null)
      if (!active || !next || request !== statusRequestRef.current || next.task !== 'merge-runtime') return
      const settled = mergeRuntimeStatusHasSettled(next)
      const isRunning = next.running || (mergeRuntimeDownloadSnapshot.active && !settled)
      mergeRuntimeDownloadSnapshot.active = isRunning
      const nextProgress = progressFromMergeRuntimeStatus(next)
      if (next.stage) mergeRuntimeDownloadSnapshot.progress = nextProgress
      setInstalling(isRunning)
      if (next.stage) setProgress(nextProgress)
    }
    void sync()
    const timer = window.setInterval(() => void sync(), 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let active = true
    let stop = () => undefined
    void listenMergeRuntimeInstallProgress((payload) => {
      if (!active) return
      const terminal = /已完成|失败|错误|已取消|取消完成/.test(payload.stage || '')
      const generation = mergeRuntimeDownloadSnapshot.generation
      // Do not use percentage as a terminal signal. Wait for status running=false.
      mergeRuntimeDownloadSnapshot.active = true
      mergeRuntimeDownloadSnapshot.progress = payload
      setProgress(payload)
      setInstalling(true)
      if (terminal) {
        const expected: MergeRuntimeTerminal = /取消/.test(payload.stage) ? 'cancelled' : /失败|错误/.test(payload.stage) ? 'failed' : 'success'
        void waitForMergeRuntimeDownloadSettlement(expected).then((finalStatus) => {
          if (!active || mergeRuntimeDownloadSnapshot.generation !== generation || !finalStatus) return
          if (!mergeRuntimeStatusHasSettled(finalStatus, expected)) return
          const settledProgress = progressFromMergeRuntimeStatus(finalStatus)
          mergeRuntimeDownloadSnapshot.active = false
          mergeRuntimeDownloadSnapshot.progress = settledProgress.stage ? settledProgress : payload
          setProgress(settledProgress.stage ? settledProgress : payload)
          setInstalling(false)
        })
      }
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
    if (installing) return
    const action = status?.ready ? '从最新 Release 重新下载并更新' : '下载'
    if (!window.confirm(action + '视频合并环境（FFmpeg / FFprobe）？')) return
    const operation = operationRef.current + 1
    operationRef.current = operation
    const generation = beginMergeRuntimeTask()
    statusRequestRef.current += 1
    setInstalling(true)
    mergeRuntimeDownloadSnapshot.active = true
    mergeRuntimeDownloadSnapshot.error = ''
    setError('')
    const initialProgress = {
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: '正在准备视频合并环境更新',
    }
    setProgress(initialProgress)
    mergeRuntimeDownloadSnapshot.progress = initialProgress
    try {
      const nextStatus = await installMergeRuntime(proxyUrl)
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      setStatus(nextStatus)
      const currentProgress = mergeRuntimeDownloadSnapshot.progress
      const completedProgress = {
        downloadedBytes: currentProgress?.downloadedBytes ?? 0,
        totalBytes: currentProgress?.totalBytes ?? 0,
        progress: 100,
        stage: '视频合并环境已更新',
      }
      setProgress(completedProgress)
      mergeRuntimeDownloadSnapshot.active = true
      mergeRuntimeDownloadSnapshot.progress = completedProgress
      const finalStatus = await waitForMergeRuntimeDownloadSettlement('success')
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && mergeRuntimeStatusHasSettled(finalStatus, 'success')) {
        mergeRuntimeDownloadSnapshot.active = false
        setInstalling(false)
      }
    } catch (reason) {
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      const message = normalizeBackendError(reason)
      setError(message)
      mergeRuntimeDownloadSnapshot.error = message
      const finalStatus = await waitForMergeRuntimeDownloadSettlement()
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && mergeRuntimeStatusHasSettled(finalStatus)) {
        mergeRuntimeDownloadSnapshot.active = false
        setInstalling(false)
      }
    }
  }

  async function handleCancel() {
    if (!installing) return
    operationRef.current += 1
    statusRequestRef.current += 1
    setError('')
    const pendingProgress = {
      ...(mergeRuntimeDownloadSnapshot.progress || { downloadedBytes: 0, totalBytes: 0, progress: 0 }),
      stage: '正在取消下载',
    }
    mergeRuntimeDownloadSnapshot.progress = pendingProgress
    setProgress(pendingProgress)
    try {
      await cancelMergeRuntimeInstall()
      const finalStatus = await waitForMergeRuntimeDownloadSettlement()
      if (!finalStatus || finalStatus.running || !mergeRuntimeStatusHasSettled(finalStatus)) {
        mergeRuntimeDownloadSnapshot.active = true
        setInstalling(true)
        return
      }
      const cancelledProgress = { ...pendingProgress, stage: '视频合并环境下载已取消' }
      mergeRuntimeDownloadSnapshot.active = false
      mergeRuntimeDownloadSnapshot.progress = cancelledProgress
      setInstalling(false)
      setProgress(cancelledProgress)
    } catch (reason) {
      const message = normalizeBackendError(reason)
      mergeRuntimeDownloadSnapshot.error = message
      setError(message)
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
          <NeonButton type="button" onClick={() => void handleCancel()}>
            <CircleStop size={17} />
            取消下载
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
