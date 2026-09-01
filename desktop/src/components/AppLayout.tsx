import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { FolderOpen, GitBranch } from 'lucide-react'
import { NeonButton } from '@/components/DesignSystem'
import { RuntimeSetupDialog } from '@/components/RuntimeSetupDialog'
import { Sidebar } from '@/components/Sidebar'
import { WindowControls } from '@/components/WindowControls'
import { useI18n } from '@/i18n/useI18n'
import {
  closeWindow,
  checkForUpdates,
  checkPythonEnv,
  getAppInfo,
  hasTauriRuntime,
  getFileMoveStatus,
  listenAnalysisEvents,
  listenAppCloseRequested,
  listenAppExitRequested,
  listenMergeEvents,
  maximizeWindow,
  normalizeBackendError,
  revealInFolder,
  setCloseBehavior,
  type FileMoveStatus,
  type MergeProgressPayload,
  type AppInfo,
  type UpdateInfo,
} from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useMergeRuntimeStore } from '@/stores/mergeRuntimeStore'
import type { AnalysisLog } from '@/stores/analysisStore'
import { shouldAcceptMergeProgress } from '@/components/merge/mergeEventPolicy'
import { useSettingsStore } from '@/stores/settingsStore'
import { useEnvironmentStore } from '@/stores/environmentStore'
import type { CloseBehavior } from '@/types/config'
import appIcon from '../../icon.png'

// Keep the update UI out of the initial route bundle.  The dialog is shared
// with SettingsPage, but startup checks must be able to surface it from any
// route (including the analysis page).
const StartupUpdateDialog = lazy(() => import('@/pages/SettingsPage').then((module) => ({ default: module.UpdateDialog })))

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const appliedStartupWindowState = useRef(false)
  const startupChecksStarted = useRef(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const [startupAppInfo, setStartupAppInfo] = useState<AppInfo | null>(null)
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null)
  const [startupUpdateDialogOpen, setStartupUpdateDialogOpen] = useState(false)
  const reportDir = useSettingsStore((state) => state.reportDir)
  const closeBehavior = useSettingsStore((state) => state.closeBehavior)
  const { t, tm } = useI18n()
  const copy = getRouteCopy(location.pathname)

  useEffect(() => {
    // Tauri's WebView otherwise exposes the browser context menu (Back,
    // Reload, Save, Print, ...).  Install this at the document boundary so
    // custom timeline/text context-menu handlers still receive the event;
    // preventing the default menu does not stop propagation.
    const preventBrowserContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }
    const capture = true
    document.addEventListener('contextmenu', preventBrowserContextMenu, capture)
    return () => document.removeEventListener('contextmenu', preventBrowserContextMenu, capture)
  }, [])

  const performCloseAction = useCallback(async (action: Exclude<CloseBehavior, 'ask'>, remember = false) => {
    if (action === 'exit' && !(await confirmExitWhileMoving(tm))) return

    if (remember) {
      const settings = useSettingsStore.getState()
      settings.setCloseBehavior(action)
      settings.saveSettings()
      void setCloseBehavior(action).catch(() => undefined)
    }

    await closeWindow(action === 'tray')
  }, [tm])

  const handleExitRequest = useCallback(() => {
    const behavior = useSettingsStore.getState().closeBehavior
    if (behavior === 'ask') {
      setRememberCloseChoice(false)
      setCloseDialogOpen(true)
      return
    }
    void performCloseAction('exit').catch((error) => {
      useAnalysisStore.getState().setErrorMessage(normalizeBackendError(error))
    })
  }, [performCloseAction])

  const handleCloseRequest = useCallback(() => {
    const behavior = useSettingsStore.getState().closeBehavior
    if (behavior === 'ask') {
      setRememberCloseChoice(false)
      setCloseDialogOpen(true)
      return
    }

    void performCloseAction(behavior).catch(() => undefined)
  }, [performCloseAction])

  useEffect(() => {
    if (appliedStartupWindowState.current) return
    appliedStartupWindowState.current = true
    if (!useSettingsStore.getState().openMaximized) return

    void maximizeWindow().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (startupChecksStarted.current) return
    startupChecksStarted.current = true
    if (!hasTauriRuntime()) return

    // Application updates are checked in the background and remain silent
    // when the installed version is current or the release metadata is
    // unavailable.  Only a positive result opens the existing dialog.
    void checkForUpdates(useSettingsStore.getState().networkProxy)
      .then((update) => {
        if (!update.updateAvailable) return
        setStartupUpdate(update)
        setStartupUpdateDialogOpen(true)
      })
      .catch(() => undefined)

    void (async () => {
      // Resolve and hydrate the app defaults before probing.  Empty/default
      // paths are valid backend inputs, but using the resolved paths here
      // keeps the stored result aligned with what SettingsPage displays.
      try {
        const info = await getAppInfo()
        setStartupAppInfo(info)
        useSettingsStore.getState().hydrateAppDefaults({
          projectRoot: info.projectRoot,
          videoDir: info.defaultVideoDir,
          cacheDir: info.defaultCacheDir,
          reportDir: info.defaultOutputDir,
        })
      } catch {
        // The environment command can resolve its own project root when
        // app metadata is unavailable, so continue with persisted settings.
      }

      const settings = useSettingsStore.getState()
      const environmentConfigKey = buildEnvironmentConfigKey(settings.pythonPath, settings.projectRoot, settings.reportDir)
      const environmentStore = useEnvironmentStore.getState()
      environmentStore.setChecking(true)
      environmentStore.setError('')

      // Run the full probe once per application process.  In particular,
      // quickCheck must stay false here so the GPU/CUDA probe is not deferred
      // until the user happens to open Settings and press refresh.
      try {
        const status = await checkPythonEnv({
          pythonPath: settings.pythonPath,
          projectRoot: settings.projectRoot,
          reportDir: settings.reportDir,
          quickCheck: false,
        })
        useEnvironmentStore.getState().setStatus(status, environmentConfigKey)
      } catch (error) {
        const message = normalizeBackendError(error)
        useEnvironmentStore.getState().setStatus({
          ok: false,
          message,
          scriptsOk: false,
          reportDirOk: false,
          gpuAvailable: false,
          gpuMessage: '检测失败',
        }, environmentConfigKey)
        useEnvironmentStore.getState().setError(message)
      } finally {
        useEnvironmentStore.getState().setChecking(false)
      }
    })()
  }, [])

  useEffect(() => {
    void setCloseBehavior(closeBehavior).catch(() => undefined)
  }, [closeBehavior])

  useEffect(() => {
    let dispose = () => undefined
    let disposed = false

    listenAppCloseRequested(handleCloseRequest)
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch((error) => {
        useAnalysisStore.getState().setErrorMessage(normalizeBackendError(error))
      })

    return () => {
      disposed = true
      dispose()
    }
  }, [handleCloseRequest])

  useEffect(() => {
    let dispose = () => undefined
    let disposed = false

    listenAppExitRequested(handleExitRequest)
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch((error) => {
        useAnalysisStore.getState().setErrorMessage(normalizeBackendError(error))
      })

    return () => {
      disposed = true
      dispose()
    }
  }, [handleExitRequest])

  useEffect(() => {
    let dispose = () => undefined
    let disposed = false

    listenAnalysisEvents({
      onLog: (payload) => {
        const store = useAnalysisStore.getState()
        if (!store.activeTaskId) return
        store.appendLog(payload)
      },
      onProgress: (payload) => {
        if (!useAnalysisStore.getState().activeTaskId) return
        const subTask = payload.subProgress != null || payload.subStage
          ? { subProgress: payload.subProgress ?? null, subStage: payload.subStage ?? '' }
          : undefined
        useAnalysisStore.getState().setProgress(payload.progress, payload.stage, subTask)
      },
      onVideoQuarantined: (payload) => {
        const store = useAnalysisStore.getState()
        if (!store.activeTaskId) return
        store.quarantineScannedVideo(payload.originalPath, payload.destinationPath, payload.moved)
      },
      onFinished: (payload) => {
        const store = useAnalysisStore.getState()
        if (!store.activeTaskId) return
        store.setReportPaths(payload)
        store.setRunningStatus('success')
        store.setProgress(100, '分析完成', { subProgress: 100, subStage: '当前子任务完成' })
        store.setErrorMessage('')
        navigate('/results', { state: { autoLoadReport: true } })
      },
      onStageFinished: () => {
        const store = useAnalysisStore.getState()
        if (!store.activeTaskId) return
        store.setRunningStatus('paused')
        store.setProgress(store.progress, '当前阶段已完成，可继续下一阶段', {
          subProgress: 100,
          subStage: '阶段产物已保存',
        })
        store.setErrorMessage('')
      },
      onError: (payload) => {
        const friendlyMessage = normalizeBackendError(payload.message)
        const cancelled = friendlyMessage.includes('取消') || friendlyMessage.includes('cancel')
        const store = useAnalysisStore.getState()
        if (!store.activeTaskId) return
        store.setRunningStatus(cancelled ? 'paused' : 'error')
        store.setErrorMessage(cancelled ? '' : friendlyMessage)
        store.setProgress(cancelled ? store.progress : 100, cancelled ? '任务已暂停' : '分析失败')
      },
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch((error) => {
        useAnalysisStore.getState().setErrorMessage(normalizeBackendError(error))
      })

    return () => {
      disposed = true
      dispose()
    }
  }, [navigate])

  useEffect(() => {
    let dispose = () => undefined
    let disposed = false
    let progressTimer: number | null = null
    let logTimer: number | null = null
    let pendingProgress: MergeProgressPayload | null = null
    let pendingLogs: AnalysisLog[] = []
    let lastProgressAt = 0
    let terminal = false
    const cancelPendingProgress = () => {
      if (progressTimer !== null) window.clearTimeout(progressTimer)
      progressTimer = null
      pendingProgress = null
    }
    const markTerminal = () => {
      terminal = true
      cancelPendingProgress()
    }
    const flushProgress = () => {
      progressTimer = null
      if (!pendingProgress || disposed) return
      const payload = pendingProgress
      pendingProgress = null
      lastProgressAt = performance.now()
      const store = useMergeRuntimeStore.getState()
      if (payload.progress < 100 && !store.running) store.setRunning(true)
      store.setProgress(payload.progress, payload.stage)
    }
    const queueProgress = (payload: MergeProgressPayload) => {
      const running = useMergeRuntimeStore.getState().running
      if (!shouldAcceptMergeProgress(terminal, running)) return
      // `startMerge` sets running before invoking the backend. That transition
      // is the explicit boundary which permits a new task after a terminal
      // event; stale bridge events while idle remain ignored.
      if (terminal && running) terminal = false
      pendingProgress = payload
      const elapsed = performance.now() - lastProgressAt
      if (elapsed >= 80) {
        if (progressTimer !== null) window.clearTimeout(progressTimer)
        flushProgress()
      } else if (progressTimer === null) {
        progressTimer = window.setTimeout(flushProgress, Math.max(0, 80 - elapsed))
      }
    }
    const flushLogs = () => {
      logTimer = null
      if (disposed || pendingLogs.length === 0) return
      const logs = pendingLogs
      pendingLogs = []
      useMergeRuntimeStore.getState().appendLogs(logs)
    }
    const queueLog = (payload: AnalysisLog) => {
      pendingLogs.push(payload)
      // A bounded batch prevents one Zustand array copy per ffmpeg line while
      // retaining the latest 1000 lines in the store.
      if (pendingLogs.length >= 24) {
        if (logTimer !== null) window.clearTimeout(logTimer)
        flushLogs()
      } else if (logTimer === null) {
        logTimer = window.setTimeout(flushLogs, 100)
      }
    }
    const applyMergeError = (message: string) => {
      markTerminal()
      flushLogs()
      const store = useMergeRuntimeStore.getState()
      const safeProgress = Number.isFinite(store.progress)
        ? Math.min(99, Math.max(0, store.progress))
        : 0
      store.setRunning(false)
      // A failed finalization must never leave a stale successful output
      // actionable in the floating capsule.
      store.setOutputPaths([])
      store.setProgress(safeProgress, '导出失败')
      store.setError(normalizeBackendError(message))
    }

    listenMergeEvents({
      onLog: queueLog,
      onProgress: queueProgress,
      onFinished: (payload) => {
        const store = useMergeRuntimeStore.getState()
        if (terminal && !store.running) return
        if (!Array.isArray(payload.outputPaths) || payload.outputPaths.length === 0) {
          applyMergeError('合并完成事件没有包含有效输出文件。')
          return
        }
        markTerminal()
        flushLogs()
        store.setRunning(false)
        store.setOutputPaths(payload.outputPaths)
        store.setProgress(100, payload.message)
        store.setError('')
      },
      onError: (payload) => {
        const store = useMergeRuntimeStore.getState()
        if (terminal && !store.running) return
        applyMergeError(payload.message)
      },
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch((error) => applyMergeError(normalizeBackendError(error)))

    return () => {
      disposed = true
      if (progressTimer !== null) window.clearTimeout(progressTimer)
      if (logTimer !== null) window.clearTimeout(logTimer)
      progressTimer = null
      logTimer = null
      pendingProgress = null
      dispose()
    }
  }, [])

  return (
    <div className="app-frame compact-shell">
      <header className="brand-header" data-tauri-drag-region>
        <div className="brand-left" data-tauri-drag-region>
          <img className="brand-logo" src={appIcon} alt={t('视频相似度分析')} />
          <div data-tauri-drag-region>
            <h1 className="brand-title" title={t(copy.title)}>{t(copy.title)}</h1>
            {copy.subtitle && <p className="brand-subtitle" title={t(copy.subtitle)}>{t(copy.subtitle)}</p>}
          </div>
        </div>

        {location.pathname === '/results' && (
          <div className="header-actions">
            <NeonButton variant="outline" onClick={() => void revealInFolder(reportDir || 'data/reports').catch(() => undefined)}>
              <FolderOpen size={22} />
              {t('打开报告目录')}
            </NeonButton>
            <NeonButton onClick={() => navigate('/')}>
              <GitBranch size={22} />
              {t('重新分析')}
            </NeonButton>
          </div>
        )}
      </header>

      <WindowControls onRequestClose={handleCloseRequest} />
      <Sidebar />

      <main className="app-main">
        <Outlet />
      </main>

      <RuntimeSetupDialog />

      {startupUpdateDialogOpen && (
        <Suspense fallback={null}>
          <StartupUpdateDialog
            open
            appInfo={startupAppInfo}
            proxyUrl={useSettingsStore.getState().networkProxy}
            initialUpdate={startupUpdate}
            onClose={() => setStartupUpdateDialogOpen(false)}
          />
        </Suspense>
      )}

      {closeDialogOpen && createPortal(
        <CloseChoiceDialog
          remember={rememberCloseChoice}
          onRememberChange={setRememberCloseChoice}
          onCancel={() => setCloseDialogOpen(false)}
          onChoose={(action) => {
            setCloseDialogOpen(false)
            void performCloseAction(action, rememberCloseChoice).catch(() => undefined)
          }}
        />,
        document.body,
      )}
    </div>
  )
}

async function confirmExitWhileMoving(translate: (value: string) => string) {
  let status: FileMoveStatus
  try {
    status = await getFileMoveStatus()
  } catch {
    return true
  }

  if (!status.running) return true
  return window.confirm(formatMovingExitWarning(status, translate))
}

function formatMovingExitWarning(status: FileMoveStatus, translate: (value: string) => string = (value) => value) {
  const affected = status.pendingPaths
    .slice(0, 6)
    .map((path) => `- ${fileNameFromPath(path)}`)
    .join('\n')
  const more = status.pendingPaths.length > 6
    ? `\n- ${translate('以及另外')} ${status.pendingPaths.length - 6} ${translate('个文件')}`
    : ''
  const current = status.currentPath ? `\n${translate('当前文件：')}${fileNameFromPath(status.currentPath)}` : ''
  const target = status.targetDir ? `\n${translate('目标目录：')}${status.targetDir}` : ''
  return [
    translate('尚有文件在移动，是否确认退出？'),
    translate('退出程序会中断移动任务，正在复制的文件可能需要重新整理。'),
    current,
    target,
    affected ? `\n${translate('可能受影响的视频：')}\n${affected}${more}` : '',
  ].filter(Boolean).join('\n')
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function CloseChoiceDialog({
  remember,
  onRememberChange,
  onCancel,
  onChoose,
}: {
  remember: boolean
  onRememberChange: (value: boolean) => void
  onCancel: () => void
  onChoose: (action: Exclude<CloseBehavior, 'ask'>) => void
}) {
  const { t } = useI18n()
  return (
    <div className="close-dialog-backdrop" role="presentation">
      <section className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
        <div>
          <h2 id="close-dialog-title">{t('关闭程序')}</h2>
          <p>{t('请选择本次关闭方式。未勾选“记住此选项”时，下次关闭仍会再次询问。')}</p>
        </div>

        <label className="close-dialog-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => onRememberChange(event.target.checked)}
          />
          <span>{t('记住此选项')}</span>
        </label>

        <div className="close-dialog-actions">
          <NeonButton variant="outline" type="button" onClick={onCancel}>
            {t('取消')}
          </NeonButton>
          <NeonButton variant="outline" type="button" onClick={() => onChoose('tray')}>
            {t('最小化到托盘运行')}
          </NeonButton>
          <NeonButton tone="red" type="button" onClick={() => onChoose('exit')}>
            {t('退出程序')}
          </NeonButton>
        </div>
      </section>
    </div>
  )
}

function getRouteCopy(pathname: string) {
  if (pathname === '/results') {
    return { title: '结果总览', subtitle: '' }
  }

  if (pathname === '/compare') {
    return { title: '对比视图', subtitle: '' }
  }

  if (pathname === '/merge') {
    return { title: '合并视频', subtitle: '' }
  }

  if (pathname === '/settings') {
    return { title: '设置', subtitle: '' }
  }

  return { title: '视频相似度分析', subtitle: '' }
}

function buildEnvironmentConfigKey(pythonPath: string, projectRoot: string, reportDir: string) {
  return [pythonPath, projectRoot, reportDir].join('|')
}
