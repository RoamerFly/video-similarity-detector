import { describe, expect, it } from 'vitest'

import {
  runtimeStatusIsActive,
  runtimeStatusHasSettled,
  runtimeTaskCanCancel,
  runtimeTaskFromStatus,
  runtimeProgressCanCancel,
  runtimeUpdatePrompt,
  resourceInstallChoiceState,
} from './RuntimeSettingsCard'

describe('runtime environment task state', () => {
  const status = (task: string, running: boolean) => ({
    task,
    running,
    cancelRequested: false,
    cancelled: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    stage: '',
  })

  it('restores migration and cleanup tasks when a dialog is reopened', () => {
    expect(runtimeTaskFromStatus('runtime-migration')).toBe('runtime-migration')
    expect(runtimeTaskFromStatus('runtime-cleanup')).toBe('runtime-cleanup')
    expect(runtimeStatusIsActive(status('runtime-cleanup', true))).toBe(true)
  })

  it('allows cancellation for all interruptible runtime task phases', () => {
    expect(runtimeTaskCanCancel('runtime', true)).toBe(true)
    expect(runtimeTaskCanCancel('runtime', true, true)).toBe(false)
    expect(runtimeTaskCanCancel('runtime-migration', true)).toBe(true)
    expect(runtimeTaskCanCancel('runtime-cleanup', true)).toBe(true)
  })

  it('does not consider unknown backend tasks active', () => {
    expect(runtimeTaskFromStatus('')).toBeNull()
    expect(runtimeStatusIsActive(status('unknown', true))).toBe(false)
  })

  it('waits for stopped status after a 100% runtime event', () => {
    const completed = status('runtime', true)
    completed.progress = 100
    completed.stage = 'AI 运行环境已安装'
    expect(runtimeStatusHasSettled('runtime', completed, 'success')).toBe(false)
    expect(runtimeStatusHasSettled('runtime', { ...completed, running: false }, 'success')).toBe(true)
  })

  it('asks before installing, updating, or forcing a reinstall', () => {
    expect(runtimeUpdatePrompt({
      installed: false,
      updateAvailable: false,
      comparisonAvailable: false,
      assetName: 'runtime.zip',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('找到 GitHub 最新版')
    expect(runtimeUpdatePrompt({
      installed: true,
      updateAvailable: true,
      comparisonAvailable: true,
      assetName: 'runtime.zip',
      installedVersion: '1.2.3',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('有可用更新')
    expect(runtimeUpdatePrompt({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: true,
      assetName: 'runtime.zip',
      installedVersion: '1.3.0',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('已是最新版')
    expect(runtimeUpdatePrompt({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: false,
      assetName: 'runtime.zip',
      message: '',
    })).toContain('无法可靠比较')
  })

  it('disables cancellation while the installer is extracting or committing', () => {
    expect(runtimeProgressCanCancel('正在下载运行环境')).toBe(true)
    expect(runtimeProgressCanCancel('正在取消下载')).toBe(false)
    expect(runtimeProgressCanCancel('正在解压运行环境')).toBe(false)
    expect(runtimeProgressCanCancel('正在切换运行环境')).toBe(false)
  })

  it('only enables update after a positive resource comparison', () => {
    expect(resourceInstallChoiceState({
      installed: false,
      updateAvailable: false,
      comparisonAvailable: false,
      assetName: 'runtime.zip',
      message: '',
    })).toEqual({ canUpdate: false, primaryChoice: 'install', reinstallLabel: '安装环境' })
    expect(resourceInstallChoiceState({
      installed: true,
      updateAvailable: true,
      comparisonAvailable: true,
      assetName: 'runtime.zip',
      message: '',
    })).toEqual({ canUpdate: true, primaryChoice: 'update', reinstallLabel: '强制重装' })
    expect(resourceInstallChoiceState({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: true,
      assetName: 'runtime.zip',
      message: '',
    })).toEqual({ canUpdate: false, primaryChoice: 'reinstall', reinstallLabel: '强制重装' })
    expect(resourceInstallChoiceState({
      installed: true,
      updateAvailable: true,
      comparisonAvailable: false,
      assetName: 'runtime.zip',
      message: '',
    })).toEqual({ canUpdate: false, primaryChoice: 'reinstall', reinstallLabel: '强制重装' })
  })
})
