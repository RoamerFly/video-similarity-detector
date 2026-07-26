import { describe, expect, it } from 'vitest'

import type { MergeQueueItem } from '@/stores/mergeStore'
import {
  cropRectForDimensions,
  evenDimension,
  presetLayoutRects,
  previewExportVideoStyle,
  resizeCropRect,
  resolveDraggedLayout,
  rotatedDimensions,
  type CropGeometry,
} from './previewGeometry'

function clip(patch: Partial<MergeQueueItem> = {}): MergeQueueItem {
  return {
    id: 'clip-1',
    path: 'C:\\media\\clip.mp4',
    name: 'clip.mp4',
    trackId: 'video-1',
    startTime: 0,
    trimStart: 0,
    trimEnd: 10,
    muted: false,
    volume: 1,
    rotation: 0,
    cropEnabled: false,
    cropX: 0,
    cropY: 0,
    cropWidth: 1920,
    cropHeight: 1080,
    layoutCustom: false,
    layoutX: 0,
    layoutY: 0,
    layoutWidth: 1,
    layoutHeight: 1,
    ...patch,
  }
}

const cropGeometry: CropGeometry = {
  left: 0,
  top: 0,
  width: 960,
  height: 540,
  sourceWidth: 1920,
  sourceHeight: 1080,
}

describe('merge preview geometry', () => {
  it('normalizes crop rectangles into source bounds', () => {
    expect(cropRectForDimensions(
      clip({ cropX: 1919, cropY: -5, cropWidth: 100, cropHeight: 0 }),
      1920,
      1080,
    )).toEqual({ x: 1918, y: 0, width: 2, height: 1080 })
  })

  it('keeps crop resizing inside the source with a two-pixel minimum', () => {
    expect(resizeCropRect(
      { x: 100, y: 100, width: 400, height: 300 },
      { x: 100, y: 100 },
      { x: 700, y: 500 },
      'se',
      cropGeometry,
    )).toEqual({ x: 100, y: 100, width: 600, height: 400 })

    expect(resizeCropRect(
      { x: 100, y: 100, width: 400, height: 300 },
      { x: 100, y: 100 },
      { x: 2000, y: 2000 },
      'move',
      cropGeometry,
    )).toEqual({ x: 1520, y: 780, width: 400, height: 300 })
  })

  it('creates deterministic grid layouts', () => {
    expect(presetLayoutRects(3, 'grid')).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    ])
  })

  it('snaps to adjacent layouts and rejects overlap', () => {
    const other = { x: 0, y: 0, width: 0.5, height: 1 }

    expect(resolveDraggedLayout(
      { x: 0.48, y: 0, width: 0.5, height: 1 },
      [other],
      true,
      0.03,
    )).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 })

    expect(resolveDraggedLayout(
      { x: 0.4, y: 0, width: 0.5, height: 1 },
      [other],
      false,
      0.03,
    )).toBeNull()
  })

  it('handles rotation dimensions and keeps output dimensions even', () => {
    expect(rotatedDimensions(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 })
    expect(rotatedDimensions(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 })
    expect(evenDimension(1919)).toBe(1918)
    expect(evenDimension(1)).toBe(2)
  })

  it('builds a crop-aware preview transform', () => {
    const style = previewExportVideoStyle(
      clip({
        cropEnabled: true,
        cropX: 100,
        cropY: 50,
        cropWidth: 800,
        cropHeight: 400,
      }),
      1920,
      1080,
      { left: 10, top: 20, width: 800, height: 400 },
      'stretch',
      false,
    )

    expect(style.transform).toBe('matrix(1,0,0,1,-90,-30)')
    expect(style.transformOrigin).toBe('0 0')
  })
})
