import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { NeonButton, TextInput } from '@/components/DesignSystem'
import { MergeNumberField as NumberField } from './MergeNumberField'
import type { MergeTextItem } from '@/stores/mergeStore'

interface MergeTextPropertiesDialogProps {
  item: MergeTextItem | null
  onSave: (patch: Pick<MergeTextItem, 'text' | 'fontSize' | 'color'>) => void
  onClose: () => void
}

/** Focused text styling dialog opened from a timeline clip's context menu. */
export function MergeTextPropertiesDialog({ item, onSave, onClose }: MergeTextPropertiesDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [text, setText] = useState(() => item?.text ?? '')
  const [fontSize, setFontSize] = useState(() => item?.fontSize ?? 48)
  const [color, setColor] = useState(() => item ? toColorInput(item.color) : '#ffffff')
  const [colorInput, setColorInput] = useState(() => item ? toColorInput(item.color) : '#ffffff')

  useEffect(() => {
    if (!item) return undefined
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [item, onClose])

  if (!item) return null
  return (
    <div className="merge-text-properties-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="merge-text-properties-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-text-properties-title" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">文本样式</span>
            <h2 id="merge-text-properties-title">编辑文本属性</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="关闭文本属性" onClick={onClose}><X /></button>
        </header>
        <div className="merge-text-properties-preview" style={{ color, fontSize: `${Math.max(8, fontSize)}px` }}>
          {text || '预览文字'}
        </div>
        <div className="merge-text-properties-fields">
          <label className="merge-text-content-field">
            <span>文本内容</span>
            <textarea value={text} rows={3} maxLength={500} onChange={(event) => setText(event.target.value)} />
          </label>
          <NumberField
            label="字号（文本大小）"
            tip="调整预览中的文本框大小，也会同步应用到导出视频。"
            value={fontSize}
            min={8}
            max={240}
            onChange={setFontSize}
          />
          <label>
            <span>颜色</span>
            <div className="merge-text-color-field">
              <input type="color" value={color} aria-label="选择文本颜色" onChange={(event) => { setColor(event.target.value); setColorInput(event.target.value) }} />
              <TextInput value={colorInput} aria-label="文本颜色值" onChange={(event) => { setColorInput(event.target.value); if (isHexColor(event.target.value)) setColor(event.target.value) }} onBlur={() => setColorInput(color)} />
            </div>
          </label>
        </div>
        <footer>
          <button type="button" className="icon-button" onClick={onClose}>取消</button>
          <NeonButton type="button" onClick={() => { onSave({ text, fontSize, color }); onClose() }}>保存属性</NeonButton>
        </footer>
      </section>
    </div>
  )
}

function isHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

function toColorInput(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return value.trim()
  const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!match) return '#ffffff'
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}
