import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { NeonButton, ParameterHint, SelectInput, Toggle } from '@/components/DesignSystem'
import { MergeNumberField as NumberField } from './MergeNumberField'
import type { MergeFitMode, MergeRateControl, MergeSettings, MergeVideoEncoder } from '@/stores/mergeStore'

interface MergeAdvancedSettingsDialogProps {
  open: boolean
  settings: MergeSettings
  onChange: (patch: Partial<MergeSettings>) => void
  onClose: () => void
}

export function MergeAdvancedSettingsDialog({ open, settings, onChange, onClose }: MergeAdvancedSettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [onClose, open])
  if (!open) return null
  return (
    <div className="merge-advanced-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="merge-advanced-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-advanced-dialog-title" aria-describedby="merge-advanced-dialog-description">
        <header>
          <div>
            <span className="eyebrow" id="merge-advanced-dialog-description">导出工作流</span>
            <h2 id="merge-advanced-dialog-title">高级导出设置</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="关闭高级导出设置" onClick={onClose}><X /></button>
        </header>
        <div className="merge-advanced-dialog-grid">
          <label><ParameterHint label="视频编码器" tip="H.264 兼容性更广；H.265 通常更省空间。" /><SelectInput value={settings.videoEncoder} onChange={(event) => onChange({ videoEncoder: event.target.value as MergeVideoEncoder })}><option value="h264">H.264 (x264)</option><option value="h265">H.265 (x265)</option></SelectInput></label>
          <label><ParameterHint label="码率控制" tip="恒定质量适合大多数场景；平均码率便于控制文件大小。" /><SelectInput value={settings.rateControl} onChange={(event) => { const rateControl = event.target.value as MergeRateControl; onChange({ rateControl, twoPass: rateControl === 'bitrate' && settings.twoPass }) }}><option value="quality">恒定质量（推荐）</option><option value="bitrate">平均码率</option></SelectInput></label>
          {settings.rateControl === 'quality' ? <NumberField label="恒定质量 RF" value={settings.crf} min={0} max={51} onChange={(crf) => onChange({ crf })} /> : <NumberField label="视频码率（kbps）" value={settings.videoBitrate} min={100} max={100000} step={100} onChange={(videoBitrate) => onChange({ videoBitrate })} />}
          <label><ParameterHint label="编码速度" tip="速度越慢压缩效率越高，但导出耗时更长。" /><SelectInput value={settings.encoderPreset} onChange={(event) => onChange({ encoderPreset: event.target.value })}>{['ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((preset) => <option key={preset} value={preset}>{preset}</option>)}</SelectInput></label>
          <NumberField label="音频码率（kbps）" value={settings.audioBitrate} min={32} max={512} step={16} onChange={(audioBitrate) => onChange({ audioBitrate })} />
          <label className={`editor-toggle-row compact ${settings.rateControl !== 'bitrate' ? 'disabled' : ''}`}><ParameterHint label="两遍编码" tip="平均码率模式下提高码率分配稳定性，但导出耗时更长。" /><Toggle checked={settings.twoPass} onChange={(twoPass) => settings.rateControl === 'bitrate' && onChange({ twoPass })} /></label>
          <label><ParameterHint label="画面适配" tip="完整画面会保留整个视频；铺满画布会裁掉超出部分。" /><SelectInput value={settings.fitMode} onChange={(event) => onChange({ fitMode: event.target.value as MergeFitMode })}><option value="contain">完整画面</option><option value="cover">铺满画布</option><option value="stretch">拉伸填满</option></SelectInput></label>
          <label><ParameterHint label="空余区域" tip="输出画布大于视频时填充空余区域。" /><SelectInput value={settings.canvasBackground} onChange={(event) => onChange({ canvasBackground: event.target.value === 'white' ? 'white' : 'black' })}><option value="black">留黑</option><option value="white">留白</option></SelectInput></label>
        </div>
        <footer><NeonButton type="button" onClick={onClose}>完成</NeonButton></footer>
      </section>
    </div>
  )
}
