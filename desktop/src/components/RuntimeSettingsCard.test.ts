import { describe, expect, it } from 'vitest'

import {
  runtimeStatusIsActive,
  runtimeStatusHasSettled,
  runtimeTaskCanCancel,
  runtimeTaskFromStatus,
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
})
