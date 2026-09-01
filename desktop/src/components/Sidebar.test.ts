import { describe, expect, it } from 'vitest'
import { sidebarStatusCapsuleOrder } from './Sidebar'

describe('sidebar status capsule layout contract', () => {
  it('keeps both task capsules mounted before the centered version footer', () => {
    expect(sidebarStatusCapsuleOrder).toEqual(['analysis', 'merge', 'version'])
  })
})
