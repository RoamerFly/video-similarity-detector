import { describe, expect, it } from 'vitest'
import { statusCapsuleRoute } from './Sidebar'

describe('sidebar status capsule route contract', () => {
  it('mounts analysis status only on the analysis route', () => {
    expect(statusCapsuleRoute('/')).toBe('analysis')
    expect(statusCapsuleRoute('/results')).toBeNull()
    expect(statusCapsuleRoute('/compare')).toBeNull()
    expect(statusCapsuleRoute('/settings')).toBeNull()
  })

  it('keeps the merge status capsule on the merge route', () => {
    expect(statusCapsuleRoute('/merge')).toBe('merge')
  })
})
