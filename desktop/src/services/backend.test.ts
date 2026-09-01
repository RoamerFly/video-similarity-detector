import { describe, expect, it } from 'vitest'

import {
  isProjectPageUrl,
  shouldAcceptAnalysisEvent,
  PROJECT_ISSUES_URL,
  PROJECT_LICENSE_URL,
  PROJECT_REPOSITORY_URL,
} from './backend'

describe('project page URL allowlist', () => {
  it('accepts the repository, issue, and license pages exactly', () => {
    expect(isProjectPageUrl(PROJECT_REPOSITORY_URL)).toBe(true)
    expect(isProjectPageUrl(PROJECT_ISSUES_URL)).toBe(true)
    expect(isProjectPageUrl(PROJECT_LICENSE_URL)).toBe(true)
  })

  it('rejects URL variants outside the exact allowlist', () => {
    expect(isProjectPageUrl(`${PROJECT_REPOSITORY_URL}/`)).toBe(false)
    expect(isProjectPageUrl(`${PROJECT_ISSUES_URL}?redirect=https://example.com`)).toBe(false)
    expect(isProjectPageUrl('https://github.com/RoamerFly/video-similarity-detector.evil.example/issues')).toBe(false)
  })
})

describe('analysis event execution identity', () => {
  it('rejects late events from a previous analysis execution', () => {
    expect(shouldAcceptAnalysisEvent('current-run', 'previous-run')).toBe(false)
    expect(shouldAcceptAnalysisEvent('current-run', 'current-run')).toBe(true)
    expect(shouldAcceptAnalysisEvent(null, undefined)).toBe(true)
  })
})
