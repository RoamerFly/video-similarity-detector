import type { CropGeometry, CropRect } from './previewGeometry'

interface MergeCropMasksProps {
  rect: CropRect
  geometry: CropGeometry
}

export function MergeCropMasks({ rect, geometry }: MergeCropMasksProps) {
  const left = rect.x / geometry.sourceWidth * 100
  const top = rect.y / geometry.sourceHeight * 100
  const right = (rect.x + rect.width) / geometry.sourceWidth * 100
  const bottom = (rect.y + rect.height) / geometry.sourceHeight * 100

  return (
    <>
      <i className="video-crop-mask top" style={{ height: `${top}%` }} />
      <i className="video-crop-mask bottom" style={{ top: `${bottom}%` }} />
      <i
        className="video-crop-mask left"
        style={{ top: `${top}%`, width: `${left}%`, height: `${bottom - top}%` }}
      />
      <i
        className="video-crop-mask right"
        style={{ top: `${top}%`, left: `${right}%`, height: `${bottom - top}%` }}
      />
    </>
  )
}
