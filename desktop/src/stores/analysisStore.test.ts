import { afterEach, describe, expect, it } from 'vitest'

import { useAnalysisStore } from './analysisStore'

describe('analysis pause progress protection', () => {
  afterEach(() => useAnalysisStore.getState().resetRunState())

  it('keeps the clicked progress while cancellation events arrive', () => {
    const store = useAnalysisStore.getState()
    store.setRunningStatus('running')
    store.setProgress(47.25, '动态抽帧与特征提取')
    store.setPausePending(true, 47.25, '正在暂停分析任务')

    useAnalysisStore.getState().setProgress(1, '正在取消分析任务')

    const paused = useAnalysisStore.getState()
    expect(paused.pausePending).toBe(true)
    expect(paused.progress).toBe(47.25)
    expect(paused.stage).toBe('正在暂停分析任务')
  })
})
