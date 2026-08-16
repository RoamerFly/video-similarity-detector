import type { NormalizedLayoutRect } from './previewGeometry'

export function layoutPatch(rect: NormalizedLayoutRect) {
  return {
    layoutCustom: true,
    layoutX: rect.x,
    layoutY: rect.y,
    layoutWidth: rect.width,
    layoutHeight: rect.height,
  }
}

export function textPositionFromPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) {
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height))),
  }
}
