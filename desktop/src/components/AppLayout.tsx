import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { FolderOpen, GitBranch } from 'lucide-react'
import { NeonButton } from '@/components/DesignSystem'
import { Sidebar } from '@/components/Sidebar'
import { WindowControls } from '@/components/WindowControls'
import { translateMultiline } from '@/i18n/messages'
import { useI18n } from '@/i18n/useI18n'
import {
  closeWindow,
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
} from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useMergeStore } from '@/stores/mergeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { CloseBehavior } from '@/types/config'
import appIcon from '../../icon.png'

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const appliedStartupWindowState = useRef(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const reportDir = useSettingsStore((state) => state.reportDir)
  const closeBehavior = useSettingsStore((state) => state.closeBehavior)
  const resultSummary = useAnalysisStore((state) => state.resultSummary)
  const { t } = useI18n()
  const copy = getRouteCopy(location.pathname, resultSummary)

  const performCloseAction = useCallback(async (action: Exclude<CloseBehavior, 'ask'>, remember = false) => {
    if (action === 'exit' && !(await confirmExitWhileMoving())) return

    if (remember) {
      const settings = useSettingsStore.getState()
      settings.setCloseBehavior(action)
      settings.saveSettings()
      void setCloseBehavior(action).catch(() => undefined)
    }

    await closeWindow(action === 'tray')
  }, [])

  const handleExitRequest = useCallback(() => {
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
        useAnalysisStore.getState().appendLog(payload)
      },
      onProgress: (payload) => {
        const subTask = payload.subProgress != null || payload.subStage
          ? { subProgress: payload.subProgress ?? null, subStage: payload.subStage ?? '' }
          : undefined
        useAnalysisStore.getState().setProgress(payload.progress, payload.stage, subTask)
      },
      onVideoQuarantined: (payload) => {
        useAnalysisStore.getState().quarantineScannedVideo(payload.originalPath, payload.destinationPath, payload.moved)
      },
      onFinished: (payload) => {
        const store = useAnalysisStore.getState()
        store.setReportPaths(payload)
        store.setRunningStatus('success')
        store.setProgress(100, '分析完成', { subProgress: 100, subStage: '当前子任务完成' })
        store.setErrorMessage('')
        navigate('/results')
      },
      onStageFinished: () => {
        const store = useAnalysisStore.getState()
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

    listenMergeEvents({
      onLog: (payload) => useMergeStore.getState().appendLog(payload),
      onProgress: (payload) => {
        const store = useMergeStore.getState()
        if (payload.progress < 100 && !store.running) store.setRunning(true)
        store.setProgress(payload.progress, payload.stage)
      },
      onFinished: (payload) => {
        const store = useMergeStore.getState()
        store.setRunning(false)
        store.setProgress(100, payload.message)
        store.setOutputPaths(payload.outputPaths)
        store.setError('')
      },
      onError: (payload) => {
        const store = useMergeStore.getState()
        store.setRunning(false)
        store.setError(normalizeBackendError(payload.message))
      },
    })
      .then((unlisten) => {
        if (disposed) unlisten()
        else dispose = unlisten
      })
      .catch((error) => useMergeStore.getState().setError(normalizeBackendError(error)))

    return () => {
      disposed = true
      dispose()
    }
  }, [])

  return (
    <div className="app-frame">
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
              打开报告目录
            </NeonButton>
            <NeonButton onClick={() => navigate('/')}>
              <GitBranch size={22} />
              重新分析
            </NeonButton>
          </div>
        )}
      </header>

      <WindowControls onRequestClose={handleCloseRequest} />
      <Sidebar />

      <main className="app-main">
        <Outlet />
      </main>

      {closeDialogOpen && (
        <CloseChoiceDialog
          remember={rememberCloseChoice}
          onRememberChange={setRememberCloseChoice}
          onCancel={() => setCloseDialogOpen(false)}
          onChoose={(action) => {
            setCloseDialogOpen(false)
            void performCloseAction(action, rememberCloseChoice).catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}

async function confirmExitWhileMoving() {
  let status: FileMoveStatus
  try {
    status = await getFileMoveStatus()
  } catch {
    return true
  }

  if (!status.running) return true
  const language = useSettingsStore.getState().appLanguage
  return window.confirm(translateMultiline(formatMovingExitWarning(status), language))
}

function formatMovingExitWarning(status: FileMoveStatus) {
  const affected = status.pendingPaths
    .slice(0, 6)
    .map((path) => `- ${fileNameFromPath(path)}`)
    .join('\n')
  const more = status.pendingPaths.length > 6 ? `\n- 以及另外 ${status.pendingPaths.length - 6} 个文件` : ''
  const current = status.currentPath ? `\n当前文件：${fileNameFromPath(status.currentPath)}` : ''
  const target = status.targetDir ? `\n目标目录：${status.targetDir}` : ''
  return [
    '尚有文件在移动，是否确认退出？',
    '退出程序会中断移动任务，正在复制的文件可能需要重新整理。',
    current,
    target,
    affected ? `\n可能受影响的视频：\n${affected}${more}` : '',
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
            取消
          </NeonButton>
          <NeonButton variant="outline" type="button" onClick={() => onChoose('tray')}>
            最小化到托盘运行
          </NeonButton>
          <NeonButton tone="red" type="button" onClick={() => onChoose('exit')}>
            退出程序
          </NeonButton>
        </div>
      </section>
    </div>
  )
}

function getRouteCopy(pathname: string, resultSummary: { videos: number; pairs: number } | null) {
  if (pathname === '/results') {
    return {
      title: '结果总览',
      subtitle: resultSummary
        ? `共分析 ${resultSummary.videos} 个视频，生成 ${resultSummary.pairs} 对比较结果`
        : '读取真实分析报告并展示比较结果',
    }
  }

  if (pathname === '/compare') {
    return {
      title: '对比视图',
      subtitle: '并排查看两个视频的匹配帧，人工确认相似关系',
    }
  }

  if (pathname === '/merge') {
    return {
      title: '合并视频',
      subtitle: '整理相似视频，统一画面规格并输出合并或分割文件',
    }
  }

  if (pathname === '/settings') {
    return {
      title: '设置',
      subtitle: '集中管理环境、路径和分析参数',
    }
  }

  return {
    title: '视频相似度分析',
    subtitle: '扫描视频、启动分析，并跟踪实时运行状态',
  }
}
