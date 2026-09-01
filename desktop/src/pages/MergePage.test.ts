import { describe, expect, it } from 'vitest'
import {
  basicOutputNameError,
  canConfirmExport,
  directoryFromPath,
  outputNameStem,
  resolveExportDirectory,
  sourceDirectoriesFromPaths,
} from './MergePage'

const valid = {
  valid: true,
  nameTooLong: false,
  nameConflict: false,
  suggestedName: 'merged_video.mp4',
  targetDir: 'D:/exports',
}

describe('merge export form validation', () => {
  it('derives a de-duplicated source folder list in clip order', () => {
    expect(sourceDirectoriesFromPaths([
      'D:/footage/first.mp4',
      'd:\\FOOTAGE\\second.mov',
      'D:/other/third.mp4',
      'single-file.mp4',
    ])).toEqual(['D:/footage', 'D:/other'])
    expect(directoryFromPath('\\\\server\\share\\video.mp4')).toBe('\\\\server\\share')
  })

  it('resolves the path from the active source or browse choice', () => {
    expect(resolveExportDirectory('source', 'D:/source', 'D:/stale-browse')).toBe('D:/source')
    expect(resolveExportDirectory('browse', 'D:/stale-source', 'D:/picked')).toBe('D:/picked')
  })

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
