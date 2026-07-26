import {
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Settings2, Volume2, VolumeX } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { GlassPanel, TextInput } from '@/components/DesignSystem'
import { MergeNumberField as NumberField } from '@/components/merge/MergeNumberField'
import { Translated } from '@/i18n/Translated'
import type { VideoMetadata } from '@/services/backend'
import {
  useMergeStore,
  type MergeAudioItem,
  type MergeQueueItem,
  type MergeTextItem,
} from '@/stores/mergeStore'

interface MergeInspectorPanelProps {
  panelHeight: number
  selectedClip?: MergeQueueItem
  selectedClipMetadata?: VideoMetadata
  selectedAudio?: MergeAudioItem
  selectedAudioStart: number
  selectedText?: MergeTextItem
  selectedTextInputRef: RefObject<HTMLInputElement | null>
  formatTime: (seconds: number) => string
  children: ReactNode
}

export function MergeInspectorPanel({
  panelHeight,
  selectedClip,
  selectedClipMetadata,
  selectedAudio,
  selectedAudioStart,
  selectedText,
  selectedTextInputRef,
  formatTime,
  children,
}: MergeInspectorPanelProps) {
  const {
    items,
    updateAudio,
    updateText,
    updateVideo,
    updateVideos,
  } = useMergeStore(useShallow((state) => ({
    items: state.items,
    updateAudio: state.updateAudio,
    updateText: state.updateText,
    updateVideo: state.updateVideo,
    updateVideos: state.updateVideos,
  })))
  const [appliedVolumeClipId, setAppliedVolumeClipId] = useState('')

  useEffect(() => {
    if (!appliedVolumeClipId) return undefined
    const timer = window.setTimeout(() => setAppliedVolumeClipId(''), 1500)
    return () => window.clearTimeout(timer)
  }, [appliedVolumeClipId])

  const volumeApplied = appliedVolumeClipId === selectedClip?.id

  return (
    <Translated>
    <GlassPanel
      className="editor-inspector-panel"
      style={panelHeight > 0 ? { height: panelHeight, maxHeight: panelHeight } : undefined}
    >
      <div className="editor-inspector-title"><Settings2 /><strong>属性与输出</strong></div>
      {selectedClip ? (
        <div className="editor-selected-media">
          <span>视频片段</span>
          <strong title={selectedClip.path}>{selectedClip.name}</strong>
          <small style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>
              {formatTime(selectedClip.trimStart)} - {formatTime(clipSourceEnd(selectedClip, selectedClipMetadata))}
              {selectedClip.rotation ? ` · 右旋 ${selectedClip.rotation}°` : ''}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>
              分辨率: {selectedClipMetadata?.width ?? '-'}x{selectedClipMetadata?.height ?? '-'} · 帧率: {Math.round(selectedClipMetadata?.fps ?? 0) || '-'} FPS
            </span>
          </small>
          <div className="editor-time-fields">
            <NumberField label="入点" value={selectedClip.trimStart} min={0} step={0.01} onChange={(trimStart) => updateVideo(selectedClip.id, { trimStart })} />
            <NumberField label="出点" value={selectedClip.trimEnd} min={0} step={0.01} placeholder="自动" onChange={(trimEnd) => updateVideo(selectedClip.id, { trimEnd })} />
          </div>
          <div className="editor-volume-control" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="icon-button"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(238, 243, 255, 0.84)', padding: '4px' }}
              onClick={() => updateVideo(selectedClip.id, { muted: !selectedClip.muted })}
              title={selectedClip.muted ? '取消静音' : '静音'}
            >
              {selectedClip.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <input
              type="range"
              min="0"
              max="3"
              step="0.05"
              value={selectedClip.muted ? 0 : (selectedClip.volume ?? 1)}
              disabled={selectedClip.muted}
              onChange={(event) => updateVideo(selectedClip.id, { volume: Number(event.target.value) })}
              style={{ flex: 1, accentColor: 'var(--accent-color, #3b82f6)' }}
            />
            <span style={{ fontSize: '12px', minWidth: '40px', textAlign: 'right' }}>
              {selectedClip.muted ? 0 : Math.round((selectedClip.volume ?? 1) * 100)}%
            </span>
            <button
              type="button"
              className="neon-button outline"
              style={{
                padding: '2px 8px',
                fontSize: '12px',
                minWidth: '60px',
                transition: 'all 0.2s',
                position: 'relative',
                ...(volumeApplied ? {
                  backgroundColor: 'rgba(34, 197, 94, 0.2)',
                  borderColor: '#22c55e',
                  color: '#4ade80',
                } : {}),
              }}
              onClick={() => {
                updateVideos(items.map((item) => ({
                  id: item.id,
                  patch: { volume: selectedClip.volume, muted: selectedClip.muted },
                })))
                setAppliedVolumeClipId(selectedClip.id)
              }}
              title="应用当前音量设置到所有视频片段"
            >
              {volumeApplied ? '统一成功!' : '统一音量'}
            </button>
          </div>
        </div>
      ) : selectedAudio ? (
        <div className="editor-selected-media audio">
          <span>音频片段</span>
          <strong title={selectedAudio.path}>{selectedAudio.name}</strong>
          <div className="editor-time-fields">
            <NumberField label="时间线位置" value={selectedAudioStart} min={0} step={0.01} onChange={(startTime) => updateAudio(selectedAudio.id, { startTime })} />
            <NumberField label="音频入点" value={selectedAudio.trimStart} min={0} step={0.01} onChange={(trimStart) => updateAudio(selectedAudio.id, { trimStart })} />
          </div>
        </div>
      ) : selectedText ? (
        <div className="editor-selected-media text">
          <span>文本片段</span>
          <TextInput ref={selectedTextInputRef} value={selectedText.text} onChange={(event) => updateText(selectedText.id, { text: event.target.value })} />
          <div className="editor-time-fields">
            <NumberField label="开始时间" value={selectedText.startTime} min={0} step={0.01} onChange={(startTime) => updateText(selectedText.id, { startTime })} />
            <NumberField label="持续秒数" value={selectedText.duration} min={0.05} step={0.01} onChange={(duration) => updateText(selectedText.id, { duration })} />
          </div>
          <div className="editor-text-fields">
            <NumberField label="横向位置" value={selectedText.x} min={0} max={1} step={0.01} onChange={(x) => updateText(selectedText.id, { x })} />
            <NumberField label="纵向位置" value={selectedText.y} min={0} max={1} step={0.01} onChange={(y) => updateText(selectedText.id, { y })} />
            <NumberField label="字号" value={selectedText.fontSize} min={8} max={240} onChange={(fontSize) => updateText(selectedText.id, { fontSize })} />
            <label>
              <span>颜色</span>
              <TextInput value={selectedText.color} onChange={(event) => updateText(selectedText.id, { color: event.target.value })} />
            </label>
          </div>
        </div>
      ) : <p className="editor-no-selection">选择时间线上的视频、音频或文本片段后可调整属性。</p>}

      {children}
    </GlassPanel>
    </Translated>
  )
}

function clipSourceEnd(item: MergeQueueItem, info?: VideoMetadata) {
  const duration = info?.readable ? info.duration : Math.max(item.trimEnd, item.trimStart + 1)
  return item.trimEnd > item.trimStart ? Math.min(item.trimEnd, duration) : duration
}
