import { describe, expect, it } from 'vitest'

import {
  mergeRuntimeProgressCanCancel,
  mergeRuntimeStatusHasSettled,
  mergeRuntimeUpdatePrompt,
} from './MergeRuntimeSettingsCard'

describe('video merge environment update flow', () => {
  it('distinguishes install, update, latest, and unknown comparisons', () => {
    expect(mergeRuntimeUpdatePrompt({
      installed: false,
      updateAvailable: false,
      comparisonAvailable: false,
      assetName: 'ffmpeg.zip',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('找到 GitHub 最新版')
    expect(mergeRuntimeUpdatePrompt({
      installed: true,
      updateAvailable: true,
      comparisonAvailable: true,
      assetName: 'ffmpeg.zip',
      installedVersion: '1.2.3',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('有可用更新')
    expect(mergeRuntimeUpdatePrompt({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: true,
      assetName: 'ffmpeg.zip',
      installedVersion: '1.3.0',
      remoteVersion: '1.3.0',
      message: '',
    })).toContain('已是最新版')
    expect(mergeRuntimeUpdatePrompt({
      installed: true,
      updateAvailable: false,
      comparisonAvailable: false,
      assetName: 'ffmpeg.zip',
      message: '',
    })).toContain('无法可靠比较')
  })

  it('waits for a stopped successful backend task before completion', () => {
    const status = {
      task: 'merge-runtime',
      running: true,
      cancelRequested: false,
      cancelled: false,
      progress: 100,
      downloadedBytes: 10,
      totalBytes: 10,
      stage: '视频合并环境已安装',
    }
    expect(mergeRuntimeStatusHasSettled(status, 'success')).toBe(false)
    expect(mergeRuntimeStatusHasSettled({ ...status, running: false }, 'success')).toBe(true)
  })

  it('disables cancellation during final extraction and commit', () => {
    expect(mergeRuntimeProgressCanCancel('正在下载视频合并环境')).toBe(true)
    expect(mergeRuntimeProgressCanCancel('正在取消下载')).toBe(false)
    expect(mergeRuntimeProgressCanCancel('正在解压视频合并环境')).toBe(false)
    expect(mergeRuntimeProgressCanCancel('正在切换视频合并环境')).toBe(false)
  })
})
