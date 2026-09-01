import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleStop, Download, HardDrive, RefreshCw, Trash2 } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import {
  formatBytes,
  cancelRuntimeInstall,
  checkRuntimeUpdate,
  getRuntimeDownloadStatus,
  getRuntimeStatus,
  installRuntime,
  listenRuntimeInstallProgress,
  normalizeBackendError,
  removeLegacyRuntime,
  type RuntimeStatus,
  type DownloadTaskStatus,
  type UpdateDownloadProgress,
  type ResourceUpdateCheck,
} from '@/services/backend'
import { useSettingsStore } from '@/stores/settingsStore'

interface RuntimeDownloadSnapshot {
  active: boolean
  progress: UpdateDownloadProgress | null
  error: string
  task: RuntimeTask | ''
  generation: number
  terminal?: RuntimeTerminal
  notifyCompletion: boolean
}

export type RuntimeTask = 'runtime' | 'runtime-migration' | 'runtime-cleanup'

// The resource dialog unmounts this card when closed. Keep the task state
// outside the dialog so reopening it cannot re-enable "安装环境" while the
// backend download is still running.
const runtimeDownloadSnapshot: RuntimeDownloadSnapshot = {
  active: false,
  progress: null,
  error: '',
  task: '',
  generation: 0,
  notifyCompletion: false,
}

// eslint-disable-next-line react-refresh/only-export-components
export function runtimeTaskFromStatus(task: string): RuntimeTask | null {
  if (task === 'runtime' || task === 'runtime-migration' || task === 'runtime-cleanup') return task
  return null
}

// eslint-disable-next-line react-refresh/only-export-components
export function runtimeStatusIsActive(status: DownloadTaskStatus) {
  return status.running === true && runtimeTaskFromStatus(status.task) !== null
}

// eslint-disable-next-line react-refresh/only-export-components
export function runtimeTaskCanCancel(task: RuntimeTask | '', running: boolean, cancelRequested = false) {
  return runtimeTaskFromStatus(task) !== null && running && !cancelRequested
}

export type RuntimeTerminal = 'success' | 'cancelled' | 'failed'

// Runtime progress events are advisory. The status endpoint must report both
// stopped and a terminal stage before the action is unlocked.
// eslint-disable-next-line react-refresh/only-export-components
export function runtimeStatusTerminal(
  task: RuntimeTask,
  status: DownloadTaskStatus,
  allowEmptySuccess = false,
): RuntimeTerminal | null {
  const stage = status.stage.trim()
  if (status.running || /正在取消/.test(stage)) return null
  if (status.cancelled || /已取消|取消完成/.test(stage)) return 'cancelled'
  if (/失败|错误/.test(stage)) return 'failed'
  if (/已安装|安装完成|迁移完成|清理完成|已完成/.test(stage)) return 'success'
  // The native migration/cleanup command historically left the status stage
  // empty after finishing; only accept that response when its promise/event
  // already identified this task as a successful terminal operation.
  if (allowEmptySuccess && (task === 'runtime-migration' || task === 'runtime-cleanup') && !stage) return 'success'
  return null
}

// eslint-disable-next-line react-refresh/only-export-components
export function runtimeStatusHasSettled(
  task: RuntimeTask,
  status: DownloadTaskStatus,
  expected?: RuntimeTerminal,
  allowEmptySuccess = false,
) {
  const terminal = runtimeStatusTerminal(task, status, allowEmptySuccess)
  return terminal !== null && (expected === undefined || terminal === expected)
}

function runtimeProgressIsTerminal(progress: UpdateDownloadProgress) {
  return /失败|错误|已取消|取消完成|已安装|安装完成|迁移完成|清理完成|已完成/.test(progress.stage)
}

function progressFromRuntimeStatus(status: DownloadTaskStatus): UpdateDownloadProgress {
  return {
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes,
    progress: status.progress,
    stage: status.stage,
  }
}

async function waitForRuntimeDownloadSettlement(task: RuntimeTask, expected?: RuntimeTerminal, allowEmptySuccess = false) {
  let status: DownloadTaskStatus | null = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    status = await getRuntimeDownloadStatus().catch(() => null)
    if (status && status.task === task && runtimeStatusHasSettled(task, status, expected, allowEmptySuccess)) return status
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
  }
  return status
}

function beginRuntimeTask(task: RuntimeTask, notifyCompletion = false) {
  const generation = runtimeDownloadSnapshot.generation + 1
  runtimeDownloadSnapshot.generation = generation
  runtimeDownloadSnapshot.task = task
  runtimeDownloadSnapshot.active = true
  runtimeDownloadSnapshot.terminal = undefined
  runtimeDownloadSnapshot.notifyCompletion = notifyCompletion
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
export function runtimeUpdatePrompt(check: ResourceUpdateCheck) {
  const details = formatResourceCheckDetails(check)
  if (!check.installed) return `已找到 GitHub 最新版 AI 运行环境${details}，是否安装？`
  if (check.comparisonAvailable && check.updateAvailable) return `检测到 AI 运行环境有可用更新${details}，是否更新？`
  if (check.comparisonAvailable) return `当前 AI 运行环境已是最新版${details}。是否仍要强制重装？`
  return `无法可靠比较 AI 运行环境的本地版本与 GitHub 最新版。是否强制重装？`
}

// eslint-disable-next-line react-refresh/only-export-components
export function runtimeProgressCanCancel(stage: string) {
  return !/正在取消|解压|校验|验证|提交|切换|正在安装|收尾|已完成/.test(stage)
}

export function RuntimeSettingsCard({ onCompleted }: { onCompleted?: () => void }) {
  const proxyUrl = useSettingsStore((state) => state.networkProxy)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(runtimeDownloadSnapshot.active)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(runtimeDownloadSnapshot.progress)
  const [error, setError] = useState(runtimeDownloadSnapshot.error)
  const [task, setTask] = useState<RuntimeTask | ''>(runtimeDownloadSnapshot.task)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const operationRef = useRef(0)

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
    const sync = async () => {
      const next = await getRuntimeDownloadStatus().catch(() => null)
      const nextTask = next && runtimeTaskFromStatus(next.task)
      if (!active || !next || !nextTask) return
      // A status response can race with the terminal event/promise that has
      // already settled this generation. Do not reopen a completed task from
      // that stale running snapshot.
      if (runtimeDownloadSnapshot.terminal === 'success' && next.running === true) return
      const settled = runtimeStatusHasSettled(nextTask, next)
      const isRunning = next.running || (runtimeDownloadSnapshot.active && !settled)
      const nextProgress = progressFromRuntimeStatus(next)
      runtimeDownloadSnapshot.active = isRunning
      if (next.stage) runtimeDownloadSnapshot.progress = nextProgress
      runtimeDownloadSnapshot.task = nextTask
      setInstalling(isRunning)
      if (next.stage) setProgress(nextProgress)
      setTask(nextTask)
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
    void listenRuntimeInstallProgress((payload) => {
      if (!active) return
      const nextTask = runtimeDownloadSnapshot.task || 'runtime'
      const terminal = runtimeProgressIsTerminal(payload)
      const generation = runtimeDownloadSnapshot.generation
      // A 100% event is not terminal until get_runtime_download_status says
      // running=false with the matching final state.
      runtimeDownloadSnapshot.active = true
      runtimeDownloadSnapshot.progress = payload
      runtimeDownloadSnapshot.task = nextTask
      setProgress(payload)
      setInstalling(true)
      setTask(nextTask)
      if (terminal) {
        const expected: RuntimeTerminal = /取消/.test(payload.stage) ? 'cancelled' : /失败|错误/.test(payload.stage) ? 'failed' : 'success'
        void waitForRuntimeDownloadSettlement(nextTask, expected, nextTask !== 'runtime').then((finalStatus) => {
          if (!active || runtimeDownloadSnapshot.generation !== generation || !finalStatus) return
          if (!runtimeStatusHasSettled(nextTask, finalStatus, expected, nextTask !== 'runtime')) return
          const settledProgress = progressFromRuntimeStatus(finalStatus)
          const shouldNotify = expected === 'success' && runtimeDownloadSnapshot.notifyCompletion
          runtimeDownloadSnapshot.active = false
          runtimeDownloadSnapshot.terminal = expected
          runtimeDownloadSnapshot.notifyCompletion = false
          runtimeDownloadSnapshot.progress = settledProgress.stage ? settledProgress : payload
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
      updateCheck = await checkRuntimeUpdate(proxyUrl)
    } catch (reason) {
      setError(normalizeBackendError(reason))
      setCheckingUpdate(false)
      return
    }
    setCheckingUpdate(false)
    if (!window.confirm(runtimeUpdatePrompt(updateCheck))) return
    const operation = operationRef.current + 1
    operationRef.current = operation
    const nextTask: RuntimeTask = 'runtime'
    const generation = beginRuntimeTask(nextTask, true)
    setInstalling(true)
    runtimeDownloadSnapshot.active = true
    runtimeDownloadSnapshot.task = nextTask
    runtimeDownloadSnapshot.error = ''
    setError('')
    const initialProgress = {
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      stage: '正在准备运行环境安装',
    }
    setProgress(initialProgress)
    runtimeDownloadSnapshot.progress = initialProgress
    setTask(nextTask)
    try {
      const nextStatus = await installRuntime(proxyUrl)
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      setStatus(nextStatus)
      const finalProgress = {
        ...(runtimeDownloadSnapshot.progress || initialProgress),
        progress: 100,
        stage: 'AI 运行环境已安装',
      }
      runtimeDownloadSnapshot.active = true
      runtimeDownloadSnapshot.progress = finalProgress
      setProgress(finalProgress)
      const finalStatus = await waitForRuntimeDownloadSettlement(nextTask, 'success')
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && runtimeStatusHasSettled(nextTask, finalStatus, 'success')) {
        const shouldNotify = runtimeDownloadSnapshot.notifyCompletion
        runtimeDownloadSnapshot.active = false
        runtimeDownloadSnapshot.terminal = 'success'
        runtimeDownloadSnapshot.notifyCompletion = false
        setInstalling(false)
        if (shouldNotify) onCompleted?.()
      }
    } catch (reason) {
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      const message = normalizeBackendError(reason)
      setError(message)
      runtimeDownloadSnapshot.error = message
      const finalStatus = await waitForRuntimeDownloadSettlement(nextTask)
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && runtimeStatusHasSettled(nextTask, finalStatus)) {
        runtimeDownloadSnapshot.active = false
        runtimeDownloadSnapshot.terminal = runtimeStatusTerminal(nextTask, finalStatus, false) || 'failed'
        runtimeDownloadSnapshot.notifyCompletion = false
        setInstalling(false)
      }
    }
  }

  async function handleCancel() {
    if (!installing || !runtimeTaskCanCancel(task, true) || !runtimeProgressCanCancel(progress?.stage || '')) return
    const currentTask = runtimeTaskFromStatus(task)
    if (!currentTask) return
    operationRef.current += 1
    setError('')
    const pendingProgress = {
      ...(runtimeDownloadSnapshot.progress || { downloadedBytes: 0, totalBytes: 0, progress: 0 }),
      stage: '正在取消下载',
    }
    runtimeDownloadSnapshot.progress = pendingProgress
    setProgress(pendingProgress)
    try {
      await cancelRuntimeInstall()
      const finalStatus = await waitForRuntimeDownloadSettlement(currentTask, 'cancelled')
      if (!finalStatus || finalStatus.running || !runtimeStatusHasSettled(currentTask, finalStatus, 'cancelled')) {
        // Keep the cancel button visible until the backend confirms that the
        // child process and download have fully stopped.
        runtimeDownloadSnapshot.active = true
        setInstalling(true)
        return
      }
      const cancelledProgress = {
        ...pendingProgress,
        stage: finalStatus?.stage && /已取消/.test(finalStatus.stage)
          ? finalStatus.stage
          : task === 'runtime-migration'
            ? '运行环境迁移已取消'
            : task === 'runtime-cleanup'
              ? '旧版运行环境清理已取消'
              : '运行环境下载已取消',
      }
      runtimeDownloadSnapshot.active = false
      runtimeDownloadSnapshot.terminal = 'cancelled'
      runtimeDownloadSnapshot.notifyCompletion = false
      runtimeDownloadSnapshot.progress = cancelledProgress
      runtimeDownloadSnapshot.task = 'runtime'
      setInstalling(false)
      setProgress(cancelledProgress)
      setTask('runtime')
    } catch (reason) {
      const message = normalizeBackendError(reason)
      runtimeDownloadSnapshot.notifyCompletion = false
      runtimeDownloadSnapshot.error = message
      setError(message)
    }
  }

  async function handleCleanup() {
    if (installing) return
    const legacyPath = status?.legacyRuntimeDir || '旧版内置目录'
    if (!window.confirm(`确认删除旧版运行环境？\n${legacyPath}\n\n当前托管环境不会受影响。`)) return
    const operation = operationRef.current + 1
    operationRef.current = operation
    const generation = beginRuntimeTask('runtime-cleanup')
    setInstalling(true)
    setTask('runtime-cleanup')
    runtimeDownloadSnapshot.active = true
    runtimeDownloadSnapshot.task = 'runtime-cleanup'
    const cleanupProgress = { downloadedBytes: 0, totalBytes: 0, progress: 0, stage: '正在清理旧版运行环境' }
    setProgress(cleanupProgress)
    runtimeDownloadSnapshot.progress = cleanupProgress
    setError('')
    try {
      const nextStatus = await removeLegacyRuntime()
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      setStatus(nextStatus)
      const finalStatus = await waitForRuntimeDownloadSettlement('runtime-cleanup', 'success', true)
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && runtimeStatusHasSettled('runtime-cleanup', finalStatus, 'success', true)) {
        setProgress(null)
        runtimeDownloadSnapshot.progress = null
        runtimeDownloadSnapshot.active = false
        runtimeDownloadSnapshot.task = 'runtime-cleanup'
        setTask('runtime-cleanup')
        setInstalling(false)
      }
    } catch (reason) {
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      setError(normalizeBackendError(reason))
      const finalStatus = await waitForRuntimeDownloadSettlement('runtime-cleanup', undefined, true)
      if (operation !== operationRef.current || runtimeDownloadSnapshot.generation !== generation) return
      if (finalStatus && runtimeStatusHasSettled('runtime-cleanup', finalStatus, undefined, true)) {
        runtimeDownloadSnapshot.active = false
        runtimeDownloadSnapshot.task = 'runtime-cleanup'
        setInstalling(false)
      }
    }
    // Success is committed above only after the status endpoint confirms the
    // task has stopped; do not clear the busy state prematurely.
  }

  const percentage = Math.max(0, Math.min(100, progress?.progress ?? 0))
  const canCancel = runtimeTaskCanCancel(task, installing, progress?.stage === '正在取消下载') && runtimeProgressCanCancel(progress?.stage || '')
  const cancelLabel = task === 'runtime-migration'
    ? '取消迁移'
    : task === 'runtime-cleanup'
      ? '取消清理'
      : '取消下载'
  const busyLabel = task === 'runtime-migration'
    ? '正在迁移运行环境'
    : task === 'runtime-cleanup'
      ? '正在清理旧环境'
    : '正在安装环境'
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
        {error || (checkingUpdate ? '正在检查更新' : status?.message || '正在检测运行环境。')}
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
          disabled={loading || installing || checkingUpdate}
        >
          <RefreshCw size={17} />
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
            {cancelLabel}
          </NeonButton>
        ) : (
          <NeonButton variant="outline" type="button" disabled>
            <RefreshCw size={17} className="spin-slow" />
            {busyLabel}
          </NeonButton>
        ) : (
          <NeonButton type="button" onClick={() => void handleInstall()} disabled={checkingUpdate}>
            <Download size={17} />
            重装/更新环境
          </NeonButton>
        )}
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
