import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleStop, Download, Film, RefreshCw } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import {
  cancelMergeRuntimeInstall,
  checkMergeRuntimeUpdate,
  formatBytes,
  getRuntimeDownloadStatus,
  getMergeRuntimeStatus,
  installMergeRuntime,
  listenMergeRuntimeInstallProgress,
  normalizeBackendError,
  type MergeRuntimeStatus,
  type DownloadTaskStatus,
  type UpdateDownloadProgress,
  type ResourceUpdateCheck,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

interface MergeRuntimeDownloadSnapshot {
  active: boolean
  progress: UpdateDownloadProgress | null
  error: string
  generation: number
  terminal?: MergeRuntimeTerminal
  notifyCompletion: boolean
}

const mergeRuntimeDownloadSnapshot: MergeRuntimeDownloadSnapshot = {
  active: false,
  progress: null,
  error: '',
  generation: 0,
  notifyCompletion: false,
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

function beginMergeRuntimeTask(notifyCompletion = false) {
  const generation = mergeRuntimeDownloadSnapshot.generation + 1
  mergeRuntimeDownloadSnapshot.generation = generation
  mergeRuntimeDownloadSnapshot.active = true
  mergeRuntimeDownloadSnapshot.terminal = undefined
  mergeRuntimeDownloadSnapshot.notifyCompletion = notifyCompletion
  return generation
}

function formatResourceCheckDetails(check: ResourceUpdateCheck) {
  const versions = check.installedVersion && check.remoteVersion
    ? `（本地 v${check.installedVersion}，GitHub v${check.remoteVersion}）`
    : check.remoteVersion
      ? `（GitHub v${check.remoteVersion}）`
      : ''
  const hashes = check.localSha256 && check.remoteSha256
    ? `（本地 SHA-256 ${check.localSha256.slice(0, 12)}…，远端 ${check.remoteSha256.slice(0, 12)}…）`
    : ''
  return `${versions}${hashes}`
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeRuntimeUpdatePrompt(check: ResourceUpdateCheck) {
  const details = formatResourceCheckDetails(check)
  if (!check.installed) return `已找到 GitHub 最新版视频合并环境${details}，是否安装？`
  if (check.comparisonAvailable && check.updateAvailable) return `检测到视频合并环境有可用更新${details}，是否更新？`
  if (check.comparisonAvailable) return `当前视频合并环境已是最新版${details}。是否仍要强制重装？`
  return '无法可靠比较视频合并环境的本地版本与 GitHub 最新版。是否强制重装？'
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeRuntimeProgressCanCancel(stage: string) {
  return !/正在取消|解压|校验|验证|提交|切换|正在安装|收尾|已完成/.test(stage)
}

export function MergeRuntimeSettingsCard({ onCompleted }: { onCompleted?: () => void }) {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<MergeRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(mergeRuntimeDownloadSnapshot.active)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(mergeRuntimeDownloadSnapshot.progress)
  const [error, setError] = useState(mergeRuntimeDownloadSnapshot.error)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
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
      // Ignore a delayed running response after the terminal success state has
      // already released the action for this generation.
      if (mergeRuntimeDownloadSnapshot.terminal === 'success' && next.running === true) return
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
          const shouldNotify = expected === 'success' && mergeRuntimeDownloadSnapshot.notifyCompletion
          mergeRuntimeDownloadSnapshot.active = false
          mergeRuntimeDownloadSnapshot.terminal = expected
          mergeRuntimeDownloadSnapshot.notifyCompletion = false
          mergeRuntimeDownloadSnapshot.progress = settledProgress.stage ? settledProgress : payload
          setProgress(settledProgress.stage ? settledProgress : payload)
          setInstalling(false)
          if (shouldNotify) onCompleted?.()
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
  }, [onCompleted])

  async function handleInstall() {
    if (installing || checkingUpdate) return
    setCheckingUpdate(true)
    setError('')
    let updateCheck: ResourceUpdateCheck
    try {
      updateCheck = await checkMergeRuntimeUpdate(proxyUrl)
    } catch (reason) {
      setError(normalizeBackendError(reason))
      setCheckingUpdate(false)
      return
    }
    setCheckingUpdate(false)
    if (!window.confirm(mergeRuntimeUpdatePrompt(updateCheck))) return
    const operation = operationRef.current + 1
    operationRef.current = operation
    const generation = beginMergeRuntimeTask(true)
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
        const shouldNotify = mergeRuntimeDownloadSnapshot.notifyCompletion
        mergeRuntimeDownloadSnapshot.active = false
        mergeRuntimeDownloadSnapshot.terminal = 'success'
        mergeRuntimeDownloadSnapshot.notifyCompletion = false
        setInstalling(false)
        if (shouldNotify) onCompleted?.()
      }
    } catch (reason) {
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      const message = normalizeBackendError(reason)
      setError(message)
      mergeRuntimeDownloadSnapshot.error = message
      mergeRuntimeDownloadSnapshot.notifyCompletion = false
      const finalStatus = await waitForMergeRuntimeDownloadSettlement()
      if (operation !== operationRef.current || mergeRuntimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && mergeRuntimeStatusHasSettled(finalStatus)) {
        mergeRuntimeDownloadSnapshot.active = false
        mergeRuntimeDownloadSnapshot.terminal = mergeRuntimeStatusTerminal(finalStatus) || 'failed'
        setInstalling(false)
      }
    }
  }

  async function handleCancel() {
    if (!installing || !mergeRuntimeProgressCanCancel(progress?.stage || '')) return
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
      mergeRuntimeDownloadSnapshot.terminal = 'cancelled'
      mergeRuntimeDownloadSnapshot.notifyCompletion = false
      mergeRuntimeDownloadSnapshot.progress = cancelledProgress
      setInstalling(false)
      setProgress(cancelledProgress)
    } catch (reason) {
      const message = normalizeBackendError(reason)
      mergeRuntimeDownloadSnapshot.notifyCompletion = false
      mergeRuntimeDownloadSnapshot.error = message
      setError(message)
    }
  }

  const progressValue = Math.max(0, Math.min(100, progress?.progress ?? 0))
  const canCancel = installing && mergeRuntimeProgressCanCancel(progress?.stage || '')
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
        {error || (checkingUpdate ? '正在检查更新' : status?.message || '正在检测视频合并环境。')}
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
          disabled={loading || installing || checkingUpdate}
        >
          <RefreshCw size={17} className={loading ? 'spin-slow' : ''} />
          刷新
        </NeonButton>
        {checkingUpdate ? (
          <NeonButton variant="outline" type="button" disabled>
            <RefreshCw size={17} className="spin-slow" />
            正在检查更新
          </NeonButton>
        ) : installing ? canCancel ? (
          <NeonButton type="button" onClick={() => void handleCancel()}>
            <CircleStop size={17} />
            取消下载
          </NeonButton>
        ) : (
          <NeonButton variant="outline" type="button" disabled>
            <RefreshCw size={17} className="spin-slow" />
            正在安装环境
          </NeonButton>
        ) : (
          <NeonButton type="button" onClick={() => void handleInstall()} disabled={checkingUpdate}>
            <Download size={17} />
            重装/更新环境
          </NeonButton>
        )}
      </div>
    </div>
  )
}
