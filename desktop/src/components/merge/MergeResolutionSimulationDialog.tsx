import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { NeonButton } from '@/components/DesignSystem'
import { formatPreciseTime } from './mergeFormat'
import { MergeNumberField as NumberField } from './MergeNumberField'

export interface ResolutionPreviewClipOption {
  id: string
  label: string
  start: number
  duration: number
}

interface MergeResolutionSimulationDialogProps {
  open: boolean
  clips: ResolutionPreviewClipOption[]
  mode: 'clips' | 'duration'
  selectedClipIds: string[]
  duration: number
  calculating: boolean
  onModeChange: (mode: 'clips' | 'duration') => void
  onSelectedClipIdsChange: (ids: string[]) => void
  onDurationChange: (duration: number) => void
  onStart: () => void
  onClose: () => void
}

export function MergeResolutionSimulationDialog({
  open,
  clips,
  mode,
  selectedClipIds,
  duration,
  calculating,
  onModeChange,
  onSelectedClipIdsChange,
  onDurationChange,
  onStart,
  onClose,
}: MergeResolutionSimulationDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || calculating) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [calculating, onClose, open])
  if (!open) return null
  const selectionValid = mode === 'duration' ? duration > 0 : selectedClipIds.length > 0
  return (
    <div className="merge-resolution-simulation-backdrop" role="presentation" onMouseDown={(event) => { if (!calculating && event.target === event.currentTarget) onClose() }}>
      <section className="merge-resolution-simulation-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-resolution-simulation-title">
        <header>
          <div>
            <span className="eyebrow">预计算高保真预览</span>
            <h2 id="merge-resolution-simulation-title">模拟真实分辨率清晰度</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-button" disabled={calculating} aria-label="关闭清晰度预览设置" onClick={onClose}><X /></button>
        </header>
        <p>按正式导出参数生成一段缓存视频。计算完成后可在播放器中切换“实时 / 已计算”，已计算模式只播放本次选定范围。</p>
        <div className="resolution-preview-range-tabs" role="tablist" aria-label="计算范围">
          <button type="button" role="tab" aria-selected={mode === 'clips'} className={mode === 'clips' ? 'active' : ''} onClick={() => onModeChange('clips')}>选取当前视频线片段</button>
          <button type="button" role="tab" aria-selected={mode === 'duration'} className={mode === 'duration' ? 'active' : ''} onClick={() => onModeChange('duration')}>从播放头指定时长</button>
        </div>
        {mode === 'clips' ? (
          <div className="resolution-preview-clip-list" aria-label="选择要计算的视频片段">
            {clips.length > 0 ? clips.map((clip) => {
              const checked = selectedClipIds.includes(clip.id)
              return (
                <label key={clip.id}>
                  <input type="checkbox" checked={checked} onChange={() => onSelectedClipIdsChange(checked ? selectedClipIds.filter((id) => id !== clip.id) : [...selectedClipIds, clip.id])} />
                  <span>{clip.label}</span>
                  <small>{formatPreciseTime(clip.start)} – {formatPreciseTime(clip.start + clip.duration)}</small>
                </label>
              )
            }) : <p className="resolution-preview-empty">当前视频线没有可计算的片段。</p>}
          </div>
        ) : (
          <NumberField label="从当前播放头计算（秒）" tip="只生成播放头之后的指定时长，超出时间线的部分会自动截断。" value={duration} min={1} max={300} step={1} onChange={onDurationChange} />
        )}
        <footer>
          <button type="button" className="icon-button" disabled={calculating} onClick={onClose}>取消</button>
          <NeonButton type="button" disabled={!selectionValid || calculating} onClick={onStart}>{calculating ? '正在计算…' : '开始计算'}</NeonButton>
        </footer>
      </section>
    </div>
  )
}
