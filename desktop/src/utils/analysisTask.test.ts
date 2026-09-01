import { describe, expect, it } from 'vitest'

import { shouldWaitForAnalysisTaskShutdown } from './analysisTask'

describe('analysis task resume safety', () => {
  it('waits when the persisted task is paused', () => {
    expect(shouldWaitForAnalysisTaskShutdown('paused', 'idle')).toBe(true)
  })

  it('waits when the live task was just paused', () => {
    expect(shouldWaitForAnalysisTaskShutdown('running', 'paused')).toBe(true)
  })

  it('does not delay a newly created task', () => {
    expect(shouldWaitForAnalysisTaskShutdown('created', 'idle')).toBe(false)
  })
})
