import type { CSSProperties } from 'react'

import type {
  MergeFitMode,
  MergeQueueItem,
  MergeRotation,
} from '@/stores/mergeStore'
import { clamp } from './mergeFormat'

export interface CropGeometry {
  left: number
  top: number
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}

export interface PreviewCanvasGeometry {
  left: number
  top: number
  width: number
  height: number
}

export interface NormalizedLayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RectBounds {
  left: number
  top: number
  width: number
  height: number
}

export type CropHandle = 'draw' | 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export function cropRectFromClip(
  clip: Pick<MergeQueueItem, 'cropX' | 'cropY' | 'cropWidth' | 'cropHeight'>,
  geometry: CropGeometry,
): CropRect {
  return cropRectForDimensions(clip, geometry.sourceWidth, geometry.sourceHeight)
}

export function cropRectForDimensions(
  clip: Pick<MergeQueueItem, 'cropX' | 'cropY' | 'cropWidth' | 'cropHeight'>,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const x = clamp(Math.round(clip.cropX), 0, Math.max(0, sourceWidth - 2))
  const y = clamp(Math.round(clip.cropY), 0, Math.max(0, sourceHeight - 2))
  return {
    x,
    y,
    width: clamp(Math.round(clip.cropWidth || sourceWidth), 2, sourceWidth - x),
    height: clamp(Math.round(clip.cropHeight || sourceHeight), 2, sourceHeight - y),
  }
}

export function previewExportVideoStyle(
  clip: MergeQueueItem,
  rawWidth: number,
  rawHeight: number,
  target: PreviewCanvasGeometry | undefined,
  fitMode: MergeFitMode,
  cropEditing: boolean,
): CSSProperties {
  if (!target || rawWidth <= 0 || rawHeight <= 0) return { opacity: 0 }
  const source = rotatedDimensions(rawWidth, rawHeight, clip.rotation)
  const crop = cropEditing
    ? { x: 0, y: 0, width: source.width, height: source.height }
    : clip.cropEnabled
      ? cropRectForDimensions(clip, source.width, source.height)
      : { x: 0, y: 0, width: source.width, height: source.height }
  const effectiveFitMode: MergeFitMode = cropEditing ? 'contain' : fitMode
  const canvasWidth = target.width
  const canvasHeight = target.height
  let scaleX = canvasWidth / crop.width
  let scaleY = canvasHeight / crop.height
  if (effectiveFitMode !== 'stretch') {
    const scale = effectiveFitMode === 'cover'
      ? Math.max(scaleX, scaleY)
      : Math.min(scaleX, scaleY)
    scaleX = scale
    scaleY = scale
  }
  const offsetX = target.left + (canvasWidth - crop.width * scaleX) / 2
  const offsetY = target.top + (canvasHeight - crop.height * scaleY) / 2
  const rotation = rotationMatrix(clip.rotation, rawWidth, rawHeight)
  const matrix = [
    scaleX * rotation.a,
    scaleY * rotation.b,
    scaleX * rotation.c,
    scaleY * rotation.d,
    scaleX * rotation.e + offsetX - crop.x * scaleX,
    scaleY * rotation.f + offsetY - crop.y * scaleY,
  ]
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: rawWidth,
    height: rawHeight,
    maxWidth: 'none',
    maxHeight: 'none',
    objectFit: 'fill',
    transform: `matrix(${matrix.join(',')})`,
    transformOrigin: '0 0',
  }
}

export function rotationMatrix(rotation: MergeRotation, rawWidth: number, rawHeight: number) {
  if (rotation === 90) return { a: 0, b: 1, c: -1, d: 0, e: rawHeight, f: 0 }
  if (rotation === 180) return { a: -1, b: 0, c: 0, d: -1, e: rawWidth, f: rawHeight }
  if (rotation === 270) return { a: 0, b: -1, c: 1, d: 0, e: 0, f: rawWidth }
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

export function rotatedDimensions(width: number, height: number, rotation: MergeRotation) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height }
}

export function evenDimension(value: number) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export function cropSelectionStyle(rect: CropRect, geometry: CropGeometry): CSSProperties {
  return {
    left: `${rect.x / geometry.sourceWidth * 100}%`,
    top: `${rect.y / geometry.sourceHeight * 100}%`,
    width: `${rect.width / geometry.sourceWidth * 100}%`,
    height: `${rect.height / geometry.sourceHeight * 100}%`,
  }
}

export function cropPointFromClient(
  clientX: number,
  clientY: number,
  screenRect: RectBounds,
  geometry: CropGeometry,
) {
  return {
    x: clamp(
      Math.round((clientX - screenRect.left - geometry.left) / geometry.width * geometry.sourceWidth),
      0,
      geometry.sourceWidth,
    ),
    y: clamp(
      Math.round((clientY - screenRect.top - geometry.top) / geometry.height * geometry.sourceHeight),
      0,
      geometry.sourceHeight,
    ),
  }
}

export function resizeCropRect(
  start: CropRect,
  origin: { x: number; y: number },
  point: { x: number; y: number },
  handle: CropHandle,
  geometry: CropGeometry,
): CropRect {
  if (handle === 'draw') {
    const x = Math.min(origin.x, point.x)
    const y = Math.min(origin.y, point.y)
    return {
      x: clamp(x, 0, geometry.sourceWidth - 2),
      y: clamp(y, 0, geometry.sourceHeight - 2),
      width: clamp(Math.abs(point.x - origin.x), 2, geometry.sourceWidth - x),
      height: clamp(Math.abs(point.y - origin.y), 2, geometry.sourceHeight - y),
    }
  }
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + point.x - origin.x, 0, geometry.sourceWidth - start.width),
      y: clamp(start.y + point.y - origin.y, 0, geometry.sourceHeight - start.height),
    }
  }

  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('w')) left = clamp(point.x, 0, right - 2)
  if (handle.includes('e')) right = clamp(point.x, left + 2, geometry.sourceWidth)
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - 2)
  if (handle.includes('s')) bottom = clamp(point.y, top + 2, geometry.sourceHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function previewLayoutRects(items: MergeQueueItem[]): NormalizedLayoutRect[] {
  if (items.length === 0) return []
  if (items.length === 1) return [{ x: 0, y: 0, width: 1, height: 1 }]
  if (items.every((item) => item.layoutCustom)) {
    return items.map((item) => normalizeLayoutRect({
      x: item.layoutX,
      y: item.layoutY,
      width: item.layoutWidth,
      height: item.layoutHeight,
    }))
  }
  return presetLayoutRects(items.length, 'grid')
}

export function boundingLayoutRect(rects: NormalizedLayoutRect[]): NormalizedLayoutRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return normalizeLayoutRect({ x: left, y: top, width: right - left, height: bottom - top })
}

export function normalizedPoint(clientX: number, clientY: number, rect: RectBounds) {
  return {
    x: clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1),
  }
}

export function resizeNormalizedRect(
  start: NormalizedLayoutRect,
  origin: { x: number; y: number },
  point: { x: number; y: number },
  handle: CropHandle,
) {
  if (handle === 'move') {
    return normalizeLayoutRect({
      ...start,
      x: start.x + point.x - origin.x,
      y: start.y + point.y - origin.y,
    })
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('w')) left = clamp(point.x, 0, right - 0.08)
  if (handle.includes('e')) right = clamp(point.x, left + 0.08, 1)
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - 0.08)
  if (handle.includes('s')) bottom = clamp(point.y, top + 0.08, 1)
  return normalizeLayoutRect({ x: left, y: top, width: right - left, height: bottom - top })
}

export function transformLayoutRects(
  rects: NormalizedLayoutRect[],
  source: NormalizedLayoutRect,
  target: NormalizedLayoutRect,
) {
  return rects.map((rect) => normalizeLayoutRect({
    x: target.x + (rect.x - source.x) / Math.max(0.001, source.width) * target.width,
    y: target.y + (rect.y - source.y) / Math.max(0.001, source.height) * target.height,
    width: rect.width / Math.max(0.001, source.width) * target.width,
    height: rect.height / Math.max(0.001, source.height) * target.height,
  }))
}

export function presetLayoutRects(
  count: number,
  mode: 'grid' | 'horizontal' | 'vertical',
): NormalizedLayoutRect[] {
  if (count <= 0) return []
  if (count === 1) return [{ x: 0, y: 0, width: 1, height: 1 }]
  const columns = mode === 'horizontal' ? count : mode === 'vertical' ? 1 : count <= 4 ? 2 : 3
  const rows = mode === 'vertical' ? count : mode === 'horizontal' ? 1 : Math.ceil(count / columns)
  const width = 1 / columns
  const height = 1 / rows
  return Array.from({ length: count }, (_, index) => ({
    x: index % columns * width,
    y: Math.floor(index / columns) * height,
    width,
    height,
  }))
}

export function insetLayoutRects(rects: NormalizedLayoutRect[], inset: number) {
  return rects.map((rect) => normalizeLayoutRect({
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - inset * 2,
    height: rect.height - inset * 2,
  }))
}

export function resolveDraggedLayout(
  raw: NormalizedLayoutRect,
  others: NormalizedLayoutRect[],
  snap: boolean,
  threshold: number,
) {
  let next = normalizeLayoutRect(raw)
  if (snap) {
    const xCandidates = [0, 1 - next.width]
    const yCandidates = [0, 1 - next.height]
    for (const other of others) {
      xCandidates.push(
        other.x,
        other.x + other.width,
        other.x - next.width,
        other.x + other.width - next.width,
      )
      yCandidates.push(
        other.y,
        other.y + other.height,
        other.y - next.height,
        other.y + other.height - next.height,
      )
    }
    next = {
      ...next,
      x: nearestSnap(next.x, xCandidates, threshold),
      y: nearestSnap(next.y, yCandidates, threshold),
    }
    next = normalizeLayoutRect(next)
  }
  if (others.some((other) => layoutRectsOverlap(next, other))) return null
  return next
}

export function normalizeLayoutRect(rect: NormalizedLayoutRect): NormalizedLayoutRect {
  const width = clamp(rect.width, 0.05, 1)
  const height = clamp(rect.height, 0.05, 1)
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  }
}

export function nearestSnap(value: number, candidates: number[], threshold: number) {
  let best = value
  let bestDistance = threshold + Number.EPSILON
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value)
    if (distance <= threshold && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function layoutRectsOverlap(left: NormalizedLayoutRect, right: NormalizedLayoutRect) {
  const epsilon = 0.001
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon
}
