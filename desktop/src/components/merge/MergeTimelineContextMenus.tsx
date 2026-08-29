import { createPortal } from 'react-dom'
import {
  ArrowLeft, ArrowRight, Copy, FolderOpen, Play, Plus,
  RotateCcw, RotateCw, Scissors, SkipBack, SquareDashedMousePointer,
  Settings2, Trash2, Type, Volume2, VolumeX,
} from 'lucide-react'
import { Translated } from '@/i18n/Translated'
import type { MergeTextItem } from '@/stores/mergeStore'
import type { AudioClipLayout, ClipLayout } from './timelineModel'
import { clampContextMenuPosition } from './contextMenuPosition'

export type TimelineTrackKind = 'video' | 'audio' | 'text'

export interface TrackContextMenuState {
  x: number
  y: number
  kind: TimelineTrackKind
  trackId: string
  time?: number
}

export interface ClipContextMenuState {
  x: number
  y: number
  layout: ClipLayout
  time: number
}

export interface AudioContextMenuState {
  x: number
  y: number
  layout: AudioClipLayout
}

export interface TextContextMenuState {
  x: number
  y: number
  text: MergeTextItem
}

interface MergeTimelineContextMenusProps {
  track: TrackContextMenuState | null
  clip: ClipContextMenuState | null
  audio: AudioContextMenuState | null
  text: TextContextMenuState | null
  trackCount: Record<TimelineTrackKind, number>
  clipRange: string
  formatTime: (time: number) => string
  canSplit: boolean
  canRestoreRotation: boolean
  canRestoreClip: boolean
  onTrackAddText: (track: TrackContextMenuState) => void
  onTrackAdd: (kind: TimelineTrackKind) => void
  onTrackRemove: (track: TrackContextMenuState) => void
  onClipSeek: (clip: ClipContextMenuState) => void
  onClipPlay: (clip: ClipContextMenuState) => void
  onClipSplit: (clip: ClipContextMenuState) => void
  onClipExtractAudio: (clip: ClipContextMenuState) => void
  onClipToggleMute: (clip: ClipContextMenuState) => void
  onClipRotate: (clip: ClipContextMenuState) => void
  onClipRestoreRotation: (clip: ClipContextMenuState) => void
  onClipCrop: (clip: ClipContextMenuState) => void
  onClipDuplicate: (clip: ClipContextMenuState) => void
  onClipMove: (clip: ClipContextMenuState, direction: -1 | 1) => void
  canClipMove: (clip: ClipContextMenuState, direction: -1 | 1) => boolean
  onClipRestore: (clip: ClipContextMenuState) => void
  onClipReveal: (clip: ClipContextMenuState) => void
  onClipRemove: (clip: ClipContextMenuState) => void
  onAudioSeek: (audio: AudioContextMenuState) => void
  onAudioMoveToPlayhead: (audio: AudioContextMenuState) => void
  onAudioMoveToStart: (audio: AudioContextMenuState) => void
  onAudioEditProperties: (audio: AudioContextMenuState) => void
  onAudioReveal: (audio: AudioContextMenuState) => void
  onAudioRemove: (audio: AudioContextMenuState) => void
  onTextSeek: (text: TextContextMenuState) => void
  onTextMoveToPlayhead: (text: TextContextMenuState) => void
  onTextEditProperties: (text: TextContextMenuState) => void
  onTextRemove: (text: TextContextMenuState) => void
}

export function MergeTimelineContextMenus(props: MergeTimelineContextMenusProps) {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const trackLabel = (kind: TimelineTrackKind) => kind === 'video' ? '视频线' : kind === 'audio' ? '音频线' : '文本线'
  return <>
    {props.track && createPortal(<Translated><div className="video-context-menu clip-context-menu track-context-menu" style={clampContextMenuPosition(props.track.x, props.track.y, viewport.width, viewport.height, 220, 120)} role="menu" onPointerDown={(event) => event.stopPropagation()}>
      {props.track.kind === 'text' && <button type="button" role="menuitem" onClick={() => props.onTrackAddText(props.track!)}><Type />添加文本片段</button>}
      <button type="button" role="menuitem" onClick={() => props.onTrackAdd(props.track!.kind)}><Plus />新建{trackLabel(props.track.kind)}</button>
      <button className="danger" type="button" role="menuitem" disabled={props.trackCount[props.track.kind] <= 1} title="删除轨道后，其中的片段会移动到保留的第一条同类轨道" onClick={() => props.onTrackRemove(props.track!)}><Trash2 />删除当前{trackLabel(props.track.kind)}</button>
    </div></Translated>, document.body)}
    {props.clip && createPortal(<Translated><div className="video-context-menu clip-context-menu" style={{ ...clampContextMenuPosition(props.clip.x, props.clip.y, viewport.width, viewport.height, 250, 390), maxHeight: Math.max(160, viewport.height - props.clip.y - 8) }} role="menu" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <strong title={props.clip.layout.item.path}>{props.clip.layout.item.name}</strong><span className="clip-context-menu-range">{props.clipRange}</span>
      <button type="button" role="menuitem" onClick={() => props.onClipSeek(props.clip!)}><SkipBack />定位到右键位置</button><button type="button" role="menuitem" onClick={() => props.onClipPlay(props.clip!)}><Play />从片段开头播放</button><button type="button" role="menuitem" disabled={!props.canSplit} onClick={() => props.onClipSplit(props.clip!)}><Scissors />在右键位置拆分</button><button type="button" role="menuitem" onClick={() => props.onClipExtractAudio(props.clip!)}><Volume2 />提取该片段音频</button>
      <button type="button" role="menuitem" onClick={() => props.onClipToggleMute(props.clip!)}>{props.clip.layout.item.muted ? <Volume2 /> : <VolumeX />}{props.clip.layout.item.muted ? '恢复片段原音' : '静音该视频片段'}</button><button type="button" role="menuitem" onClick={() => props.onClipRotate(props.clip!)}><RotateCw />向右旋转 90°（默认）</button><button type="button" role="menuitem" disabled={!props.canRestoreRotation} onClick={() => props.onClipRestoreRotation(props.clip!)}><RotateCcw />还原旋转</button><button type="button" role="menuitem" onClick={() => props.onClipCrop(props.clip!)}><SquareDashedMousePointer />调整视频尺寸</button><button type="button" role="menuitem" onClick={() => props.onClipDuplicate(props.clip!)}><Copy />复制片段</button>
      <button type="button" role="menuitem" disabled={!props.canClipMove(props.clip, -1)} onClick={() => props.onClipMove(props.clip!, -1)}><ArrowLeft />向前移动</button><button type="button" role="menuitem" disabled={!props.canClipMove(props.clip, 1)} onClick={() => props.onClipMove(props.clip!, 1)}><ArrowRight />向后移动</button><button type="button" role="menuitem" disabled={!props.canRestoreClip} onClick={() => props.onClipRestore(props.clip!)}><RotateCcw />恢复完整片段</button><button type="button" role="menuitem" onClick={() => props.onClipReveal(props.clip!)}><FolderOpen />在文件夹中显示</button><button className="danger" type="button" role="menuitem" onClick={() => props.onClipRemove(props.clip!)}><Trash2 />删除片段</button>
    </div></Translated>, document.body)}
    {props.audio && createPortal(<Translated><div className="video-context-menu clip-context-menu audio-context-menu" style={{ ...clampContextMenuPosition(props.audio.x, props.audio.y, viewport.width, viewport.height, 240, 270), maxHeight: Math.max(160, viewport.height - props.audio.y - 8) }} role="menu" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}><strong title={props.audio.layout.item.path}>{props.audio.layout.item.name}</strong><span className="clip-context-menu-range">时间线位置 {props.formatTime(props.audio.layout.start)}</span><button type="button" role="menuitem" onClick={() => props.onAudioSeek(props.audio!)}><SkipBack />定位到音频开头</button><button type="button" role="menuitem" onClick={() => props.onAudioMoveToPlayhead(props.audio!)}><ArrowRight />移动到播放头</button><button type="button" role="menuitem" disabled={props.audio.layout.start === 0} onClick={() => props.onAudioMoveToStart(props.audio!)}><RotateCcw />移到时间线起点</button><button type="button" role="menuitem" onClick={() => props.onAudioEditProperties(props.audio!)}><Settings2 />属性</button><button type="button" role="menuitem" onClick={() => props.onAudioReveal(props.audio!)}><FolderOpen />在文件夹中显示</button><button className="danger" type="button" role="menuitem" onClick={() => props.onAudioRemove(props.audio!)}><Trash2 />删除音频片段</button></div></Translated>, document.body)}
    {props.text && createPortal(<Translated><div className="video-context-menu clip-context-menu text-context-menu" style={{ ...clampContextMenuPosition(props.text.x, props.text.y, viewport.width, viewport.height, 240, 250), maxHeight: Math.max(160, viewport.height - props.text.y - 8) }} role="menu" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}><strong title={props.text.text.text}>{props.text.text.text}</strong><span className="clip-context-menu-range">时间线位置 {props.formatTime(props.text.text.startTime)}</span><button type="button" role="menuitem" onClick={() => props.onTextSeek(props.text!)}><SkipBack />定位到文本开头</button><button type="button" role="menuitem" onClick={() => props.onTextMoveToPlayhead(props.text!)}><ArrowRight />移动到播放头</button><button type="button" role="menuitem" onClick={() => props.onTextEditProperties(props.text!)}><Settings2 />属性</button><button className="danger" type="button" role="menuitem" onClick={() => props.onTextRemove(props.text!)}><Trash2 />删除文本片段</button></div></Translated>, document.body)}
  </>
}
