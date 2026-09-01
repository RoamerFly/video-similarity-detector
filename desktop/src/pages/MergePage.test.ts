import { describe, expect, it } from 'vitest'
import { basicOutputNameError, canConfirmExport, outputNameStem } from './MergePage'

const valid = {
  valid: true,
  nameTooLong: false,
  nameConflict: false,
  suggestedName: 'merged_video.mp4',
  targetDir: 'D:/exports',
}

describe('merge export form validation', () => {
  it('keeps the configured container extension outside the editable stem', () => {
    expect(outputNameStem('clip.mkv')).toBe('clip')
    expect(outputNameStem('clip')).toBe('clip')
  })

  it('rejects names that the operating system cannot represent', () => {
    expect(basicOutputNameError('bad:name')).toContain('不能包含')
    expect(basicOutputNameError('CON')).toContain('保留名称')
    expect(basicOutputNameError('video.')).toContain('句点')
  })

  it('allows an existing name to continue with the backend timestamp policy', () => {
    expect(canConfirmExport('D:/exports', 'merged_video', false, {
      ...valid,
      valid: true,
      nameConflict: true,
      suggestedName: 'merged_video_1730000000.mp4',
    })).toBe(true)
  })

  it('blocks a backend-reported overlong name and pending validation', () => {
    expect(canConfirmExport('D:/exports', 'merged_video', false, {
      ...valid,
      valid: false,
      nameTooLong: true,
    })).toBe(false)
    expect(canConfirmExport('D:/exports', 'merged_video', true, valid)).toBe(false)
  })
})
