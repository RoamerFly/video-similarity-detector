import { describe, expect, it } from 'vitest'
import { sidebarStatusCapsuleOrder, toggleSidebarStatusCapsule } from './Sidebar'

describe('sidebar status capsule layout contract', () => {
  it('keeps both task capsules mounted before the centered version footer', () => {
    expect(sidebarStatusCapsuleOrder).toEqual(['analysis', 'merge', 'version'])
  })

  it('switches the shared expanded capsule instead of allowing two open overlays', () => {
    expect(toggleSidebarStatusCapsule(null, 'analysis')).toBe('analysis')
    expect(toggleSidebarStatusCapsule('analysis', 'merge')).toBe('merge')
    expect(toggleSidebarStatusCapsule('merge', 'analysis')).toBe('analysis')
    expect(toggleSidebarStatusCapsule('analysis', 'analysis')).toBeNull()
  })
})
