import { useState } from 'react'
import { RotateCw, X } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { useI18n } from '@/i18n/useI18n'
import type { MergeQueueItem } from '@/stores/mergeStore'

interface MergeRotationDialogProps {
  item: MergeQueueItem | null
  onConfirm: (angle: number) => void
  onClose: () => void
}

export function MergeRotationDialog({ item, onConfirm, onClose }: MergeRotationDialogProps) {
  const { t } = useI18n()
  const [angle, setAngle] = useState(() => item?.rotation ?? 0)

  if (!item) return null
  const normalized = ((Math.round(Number(angle) || 0) % 360) + 360) % 360

  return (
    <Translated>
      <div className="merge-video-order-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <section className="merge-rotation-dialog" role="dialog" aria-modal="true" aria-label={t('旋转操作')}>
          <header>
            <div><span className="eyebrow">{t('视频片段')}</span><h2>{t('旋转操作')}</h2></div>
            <button type="button" className="icon-button" aria-label={t('关闭旋转操作')} onClick={onClose}><X /></button>
          </header>
          <p title={item.path}>{item.name}</p>
          <label className="merge-rotation-field">
            <span>{t('顺时针旋转角度')}</span>
            <div><input type="number" min="-359" max="359" step="1" value={angle} onChange={(event) => setAngle(Number(event.target.value))} /><b>°</b></div>
          </label>
          <div className="merge-rotation-presets">
            {[0, 90, 180, 270].map((value) => <button type="button" className={normalized === value ? 'active' : ''} key={value} onClick={() => setAngle(value)}>{value}°</button>)}
          </div>
          <small>{t('支持任意整数角度；0° 表示重置旋转。')}</small>
          <footer>
            <NeonButton variant="outline" type="button" onClick={() => setAngle(0)}><RotateCw />{t('重置旋转')}</NeonButton>
            <NeonButton type="button" onClick={() => onConfirm(normalized)}>{t('应用')}</NeonButton>
          </footer>
        </section>
      </div>
    </Translated>
  )
}
