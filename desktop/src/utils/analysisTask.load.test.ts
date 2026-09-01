import { describe, expect, it } from 'vitest'

import type { AnalysisTaskRecord } from '@/services/backend'
import { selectAnalysisTask } from './analysisTask'

function task(id: string): AnalysisTaskRecord {
  return {
    version: 1,
    id,
    name: id,
    status: 'paused',
    createdAt: '',
    updatedAt: '',
    videoDir: 'D:/videos',
    videoCount: 2,
    totalPairs: 1,
    completedPairs: 0,
    failedPairs: 0,
    progress: 40,
    stage: '任务已暂停',
    matchKey: '',
    videos: [],
    config: {} as AnalysisTaskRecord['config'],
    reportJson: '',
    reportCsv: '',
    reportHtml: '',
    activeStage: '',
    stages: [],
    cacheArtifacts: [],
    reusedVideoCaches: 0,
    generatedVideoCaches: 0,
  }
}

describe('analysis task load selection', () => {
  it('keeps the requested task when it is present', () => {
    const tasks = [task('first'), task('second')]
    expect(selectAnalysisTask(tasks, 'second')?.id).toBe('second')
  })

  it('falls back to the first task when the previous selection disappeared', () => {
    const tasks = [task('first'), task('second')]
    expect(selectAnalysisTask(tasks, 'missing')?.id).toBe('first')
  })

  it('returns no selection for an empty task list', () => {
    expect(selectAnalysisTask([], '')).toBeNull()
  })
})
