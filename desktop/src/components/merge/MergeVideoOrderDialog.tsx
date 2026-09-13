import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react'

import { NeonButton } from '@/components/DesignSystem'
import { Translated } from '@/i18n/Translated'
import { useI18n } from '@/i18n/useI18n'

export interface MergeVideoOrderOption {
  id: string
  name: string
  path: string
  detail?: string
}

interface MergeVideoOrderDialogProps {
  open: boolean
  title: string
  description: string
  items: MergeVideoOrderOption[]
  focusedId?: string
  confirmLabel: string
  onConfirm: (orderedIds: string[]) => void
  onClose: () => void
}

export function MergeVideoOrderDialog({
  open,
  title,
  description,
  items,
  focusedId,
  confirmLabel,
  onConfirm,
  onClose,
}: MergeVideoOrderDialogProps) {
  const { t } = useI18n()
  const [ordered, setOrdered] = useState(() => items)
  const [draggingId, setDraggingId] = useState('')
  const focusedRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      focusedRef.current?.focus()
      focusedRef.current?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  const move = (id: string, direction: -1 | 1) => {
    setOrdered((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const dropBefore = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return
    setOrdered((current) => {
      const sourceIndex = current.findIndex((item) => item.id === draggingId)
      const targetIndex = current.findIndex((item) => item.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [moving] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moving)
      return next
    })
    setDraggingId('')
  }

  return (
    <Translated>
      <div className="merge-video-order-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
        <section className="merge-video-order-dialog" role="dialog" aria-modal="true" aria-label={title}>
          <header>
            <div>
              <span className="eyebrow">{t('视频排序')}</span>
              <h2>{title}</h2>
            </div>
            <button type="button" className="icon-button" aria-label={t('关闭视频排序')} onClick={onClose}><X /></button>
          </header>
          <p>{description}</p>
          <ol className="merge-video-order-list">
            {ordered.map((item, index) => (
              <li
                key={item.id}
                ref={item.id === focusedId ? focusedRef : undefined}
                tabIndex={item.id === focusedId ? 0 : -1}
                className={item.id === focusedId ? 'is-focused' : ''}
                draggable
                onDragStart={() => setDraggingId(item.id)}
                onDragEnd={() => setDraggingId('')}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropBefore(item.id)}
              >
                <GripVertical className="merge-video-order-grip" aria-hidden="true" />
                <span className="merge-video-order-index">{index + 1}</span>
                <div>
                  <strong title={item.path}>{item.name}</strong>
                  <small title={item.path}>{item.detail || item.path}</small>
                </div>
                <span className="merge-video-order-actions">
                  <button type="button" aria-label={`${t('向上移动')} ${item.name}`} disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp /></button>
                  <button type="button" aria-label={`${t('向下移动')} ${item.name}`} disabled={index === ordered.length - 1} onClick={() => move(item.id, 1)}><ArrowDown /></button>
                </span>
              </li>
            ))}
          </ol>
          <footer>
            <NeonButton variant="outline" type="button" onClick={onClose}>{t('取消')}</NeonButton>
            <NeonButton type="button" disabled={ordered.length === 0} onClick={() => onConfirm(ordered.map((item) => item.id))}>{confirmLabel}</NeonButton>
          </footer>
        </section>
      </div>
    </Translated>
  )
}
