import { describe, expect, it } from 'vitest'

import {
  downloadProgressEventIsActive,
  downloadProgressIsTerminal,
  downloadStatusHasSettled,
  downloadStatusIsActive,
} from './SettingsPage'

describe('settings download task state', () => {
  it('keeps an update active at 100% while verification or installation is running', () => {
    expect(downloadProgressEventIsActive('update', {
      downloadedBytes: 10,
      totalBytes: 10,
      progress: 100,
      stage: '正在校验更新安装包',
    })).toBe(true)
    expect(downloadProgressEventIsActive('update', {
      downloadedBytes: 10,
      totalBytes: 10,
      progress: 100,
      stage: '更新包已验证，正在启动安装器',
    })).toBe(true)
  })

  it('only treats an explicit terminal stage as finished', () => {
    expect(downloadProgressIsTerminal('update', {
      downloadedBytes: 10,
      totalBytes: 10,
      progress: 100,
      stage: '更新已安装，等待应用重启',
    })).toBe(true)
    expect(downloadProgressEventIsActive('update', {
      downloadedBytes: 10,
      totalBytes: 10,
      progress: 100,
      stage: '正在取消更新下载',
    })).toBe(true)
    expect(downloadProgressIsTerminal('clip-model', {
      downloadedBytes: 10,
      totalBytes: 10,
      progress: 100,
      stage: '离线 CLIP 模型已安装',
    })).toBe(true)
  })

  it('uses backend running state instead of percentage to decide activity', () => {
    expect(downloadStatusIsActive({ running: true, cancelled: false, progress: 100 })).toBe(true)
    expect(downloadStatusIsActive({ running: false, cancelled: false, progress: 99 })).toBe(false)
  })

  it('keeps a 100% completion event busy until status changes to stopped', () => {
    const finalStage = {
      running: true,
      cancelled: false,
      progress: 100,
      stage: '离线 CLIP 模型已安装',
    }
    expect(downloadStatusHasSettled('clip-model', finalStage, 'success')).toBe(false)
    expect(downloadStatusHasSettled('clip-model', { ...finalStage, running: false }, 'success')).toBe(true)
  })
})
