import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, CheckCircle2, Clapperboard, ExternalLink, Film, FolderOpen, Images, ListPlus, Maximize2, Minimize2, Pause, PlaySquare, RotateCcw, Trash2 } from 'lucide-react'
import { Badge, GlassPanel, MetricBar, NeonButton, SelectInput } from '@/components/DesignSystem'
import { captureComparisonFrame, captureVideoFrame, deleteFiles, fileName, formatBytes, localFileSrc, normalizeBackendError, openFile, pathStatus, revealInFolder, type ComparisonFrameOptions, type PathStatus } from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useMergeStore } from '@/stores/mergeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ReportFrameMatch, ReportPair, ReportWindow } from '@/utils/reportParser'
import { formatHHMMSS, formatPercent, formatScore, metricPercent } from '@/utils/reportParser'
import { getRelationInfo, relationTone } from '@/utils/relation'

type DirectionFilter = 'all' | 'A_to_B' | 'B_to_A'
type FrameViewMode = 'original' | 'comparison'
type PlaybackFocus = 'sync' | 'source' | 'target'
type CompareContextSide = 'source' | 'target'

const pathStatusCache = new Map<string, { status: PathStatus | null; error: string }>()
const framePreviewCache = new Map<string, { dataUrl: string; error: string }>()
const comparisonFrameCache = new Map<string, { dataUrl: string; error: string }>()

export function ComparePage() {
  const navigate = useNavigate()
  const selectedPair = useAnalysisStore((state) => state.selectedPair)
  const settings = useSettingsStore()
  const videoDir = settings.videoDir
  const [direction, setDirection] = useState<DirectionFilter>('all')
  const [frameViewMode, setFrameViewMode] = useState<FrameViewMode>('original')
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const [playbackFocus, setPlaybackFocus] = useState<PlaybackFocus>('sync')
  const [syncPlaying, setSyncPlaying] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [videoContextMenu, setVideoContextMenu] = useState<{ x: number; y: number; side: CompareContextSide } | null>(null)
  const [duplicateSelection, setDuplicateSelection] = useState<{ pairId: string; paths: Set<string> }>(() => ({ pairId: '', paths: new Set() }))
  const [duplicateMessageState, setDuplicateMessageState] = useState<{ pairId: string; message: string }>(() => ({ pairId: '', message: '' }))
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null)
  const targetVideoRef = useRef<HTMLVideoElement | null>(null)
  const addMergeVideo = useMergeStore((state) => state.addVideo)
  const addMergeVideos = useMergeStore((state) => state.addVideos)

  const matches = useMemo(() => {
    const rows = selectedPair?.frameMatches ?? []
    return rows
      .filter((match) => direction === 'all' || match.direction === direction)
      .sort((left, right) => (right.similarity ?? -1) - (left.similarity ?? -1))
  }, [direction, selectedPair?.frameMatches])
  const matchSections = useMemo(() => {
    const sections = [
      {
        direction: 'A_to_B' as const,
        label: 'A 到 B(A to B)',
        rows: matches.filter((match) => match.direction === 'A_to_B'),
      },
      {
        direction: 'B_to_A' as const,
        label: 'B 到 A(B to A)',
        rows: matches.filter((match) => match.direction === 'B_to_A'),
      },
    ]
    return sections.filter((section) => direction === 'all' || section.direction === direction)
  }, [direction, matches])
  const matchesAToBCount = selectedPair?.matchesAToBTotal ?? 0
  const matchesBToACount = selectedPair?.matchesBToATotal ?? 0

  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, matches.length - 1))
  const selectedMatch = matches[safeSelectedIndex]
  const totalFrameMatches = selectedPair
    ? selectedPair.matchesAToBTotal + selectedPair.matchesBToATotal || selectedPair.frameMatches.length
    : 0
  const duplicatePaths = useMemo(() => getDuplicateGroupPaths(selectedPair), [selectedPair])
  const isDuplicateFileMode = duplicatePaths.length > 0
  const selectedPairId = selectedPair?.id ?? ''
  const selectedMatchKey = selectedMatch
    ? `${selectedMatch.direction}::${selectedMatch.sourceFrameIndex ?? ''}::${selectedMatch.targetFrameIndex ?? ''}::${selectedMatch.sourceTimestamp ?? ''}::${selectedMatch.targetTimestamp ?? ''}`
    : 'no-match'
  const selectedDuplicatePaths = duplicateSelection.pairId === selectedPairId ? duplicateSelection.paths : new Set<string>()
  const duplicateMessage = duplicateMessageState.pairId === selectedPairId ? duplicateMessageState.message : ''
  const comparisonFrameOptions = useMemo<ComparisonFrameOptions>(() => ({
    cropBlackBorders: pairPreprocessOption(selectedPair, 'crop_black_borders', settings.defaultCropBlackBorders),
    resizeMode: pairPreprocessOption(selectedPair, 'resize_mode', settings.defaultResizeMode),
    inputSize: pairPreprocessOption(selectedPair, 'input_size', settings.defaultInputSize),
    portraitRotation: pairPreprocessOption(selectedPair, 'portrait_rotation', settings.defaultPortraitRotation),
  }), [
    selectedPair,
    settings.defaultCropBlackBorders,
    settings.defaultInputSize,
    settings.defaultPortraitRotation,
    settings.defaultResizeMode,
  ])

  const seekBothToSelectedFrame = useCallback(() => {
    if (!selectedMatch) return
    setPlaybackFocus('sync')
    seekVideoTo(sourceVideoRef.current, selectedMatch.sourceTimestamp)
    seekVideoTo(targetVideoRef.current, selectedMatch.targetTimestamp)
  }, [selectedMatch])

  const toggleSyncPlayback = useCallback(async () => {
    const source = sourceVideoRef.current
    const target = targetVideoRef.current
    if (!source || !target) return

    setPlaybackFocus('sync')
    if (!source.paused || !target.paused) {
      source.pause()
      target.pause()
      setSyncPlaying(false)
      return
    }

    const results = await Promise.allSettled([source.play(), target.play()])
    setSyncPlaying(results.some((result) => result.status === 'fulfilled') || !source.paused || !target.paused)
  }, [])

  const toggleSinglePlayback = useCallback(async (side: Exclude<PlaybackFocus, 'sync'>) => {
    const element = side === 'source' ? sourceVideoRef.current : targetVideoRef.current
    if (!element) return

    setPlaybackFocus(side)
    setSyncPlaying(false)
    if (!element.paused) {
      element.pause()
      return
    }
    await element.play().catch(() => undefined)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return
      event.preventDefault()
      if (playbackFocus === 'source' || playbackFocus === 'target') {
        void toggleSinglePlayback(playbackFocus)
        return
      }
      void toggleSyncPlayback()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [playbackFocus, toggleSinglePlayback, toggleSyncPlayback])

  useEffect(() => {
    sourceVideoRef.current?.pause()
    targetVideoRef.current?.pause()
    const timer = window.setTimeout(() => setSyncPlaying(false), 0)
    return () => window.clearTimeout(timer)
  }, [selectedMatchKey])

  useEffect(() => {
    const updateSyncState = () => {
      if (playbackFocus !== 'sync') {
        setSyncPlaying(false)
        return
      }
      const sourcePlaying = Boolean(sourceVideoRef.current && !sourceVideoRef.current.paused && !sourceVideoRef.current.ended)
      const targetPlaying = Boolean(targetVideoRef.current && !targetVideoRef.current.paused && !targetVideoRef.current.ended)
      setSyncPlaying(sourcePlaying || targetPlaying)
    }
    const source = sourceVideoRef.current
    const target = targetVideoRef.current
    const events = ['play', 'pause', 'ended'] as const
    events.forEach((event) => {
      source?.addEventListener(event, updateSyncState)
      target?.addEventListener(event, updateSyncState)
    })
    updateSyncState()
    return () => {
      events.forEach((event) => {
        source?.removeEventListener(event, updateSyncState)
        target?.removeEventListener(event, updateSyncState)
      })
    }
  }, [frameViewMode, playbackFocus, selectedMatchKey])

  useEffect(() => {
    if (!videoContextMenu) return undefined
    const close = () => setVideoContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [videoContextMenu])

  async function handleOpenVideo(path: string) {
    if (!path) return
    setError('')
    try {
      await openFile(path)
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  function toggleDuplicatePath(path: string, checked: boolean) {
    setDuplicateSelection((current) => {
      const next = new Set(current.pairId === selectedPairId ? current.paths : [])
      if (checked) next.add(path)
      else next.delete(path)
      return { pairId: selectedPairId, paths: next }
    })
  }

  async function handleRevealPath(path: string) {
    setError('')
    try {
      await revealInFolder(path)
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  async function handleDeleteDuplicatePaths(paths: string[], actionLabel: string) {
    const uniquePaths = Array.from(new Set(paths)).filter(Boolean)
    if (uniquePaths.length === 0) return
    const confirmed = window.confirm(`${actionLabel}：确认永久删除 ${uniquePaths.length} 个文件吗？此操作不可撤销。`)
    if (!confirmed) return
    setError('')
    setDuplicateMessageState({ pairId: selectedPairId, message: '' })
    try {
      const result = await deleteFiles(uniquePaths)
      setDuplicateMessageState({ pairId: selectedPairId, message: result.message })
      setDuplicateSelection({ pairId: selectedPairId, paths: new Set() })
      if (result.failed.length > 0) {
        setError(result.failed.map((item) => `${item.path}: ${item.error}`).join('；'))
      }
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  if (!selectedPair) {
    return (
      <GlassPanel className="route-fill page-card compare-empty-page">
        <div className="compare-empty-content">
          <AlertCircle size={34} />
          <h2>尚未选择视频对</h2>
          <p>请先从结果总览选择一条视频比较结果。</p>
          <NeonButton type="button" onClick={() => navigate('/results')}>
            <ArrowLeft size={20} />
            返回结果总览
          </NeonButton>
        </div>
      </GlassPanel>
    )
  }

  if (isDuplicateFileMode) {
    const selectedPaths = duplicatePaths.filter((path) => selectedDuplicatePaths.has(path))
    const unselectedPaths = duplicatePaths.filter((path) => !selectedDuplicatePaths.has(path))
    const fileSize = numericRawValue(selectedPair.raw.file_size_bytes)

    return (
      <div className="route-fill compare-page duplicate-compare-page">
        <GlassPanel className="compare-toolbar-panel">
          <div className="compare-title">
            <button type="button" onClick={() => navigate('/results')} aria-label="返回结果总览">
              <ArrowLeft size={20} />
            </button>
            <div>
              <h2>
                <Images size={28} />
                相同文件对比(Identical File Check)
              </h2>
              <p title={duplicatePaths.join(' / ')}>
                {duplicatePaths.length} 个路径指向完全相同的文件内容
              </p>
            </div>
          </div>

          <div className="compare-toolbar-actions">
            <Badge tone="purple">完全相同(Identical)</Badge>
            <Badge tone="blue">大小：{formatBytes(fileSize)}</Badge>
          </div>
        </GlassPanel>

        {(error || duplicateMessage) && (
          <div className={error ? 'inline-error compact-message compare-error' : 'compact-message success-message compare-error'}>
            {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
            {error || duplicateMessage}
          </div>
        )}

        <GlassPanel className="duplicate-path-panel">
          <div className="compare-list-head">
            <h3>相同文件路径</h3>
            <span>{duplicatePaths.length} 个路径</span>
          </div>

          <div className="duplicate-path-actions">
            <NeonButton
              variant="outline"
              type="button"
              onClick={() => setDuplicateSelection({ pairId: selectedPairId, paths: new Set(duplicatePaths.slice(1)) })}
              disabled={duplicatePaths.length <= 1}
            >
              <CheckCircle2 size={17} />
              保留第一项
            </NeonButton>
            <NeonButton
              variant="outline"
              tone="red"
              type="button"
              onClick={() => void handleDeleteDuplicatePaths(selectedPaths, '删除选中路径')}
              disabled={selectedPaths.length === 0}
            >
              <Trash2 size={17} />
              删除选中({selectedPaths.length})
            </NeonButton>
            <NeonButton
              variant="outline"
              tone="red"
              type="button"
              onClick={() => void handleDeleteDuplicatePaths(unselectedPaths, '保留选中路径，删除其他路径')}
              disabled={selectedPaths.length === 0 || unselectedPaths.length === 0}
            >
              <Trash2 size={17} />
              保留选中
            </NeonButton>
          </div>

          <div className="table-shell compare-table-shell duplicate-path-table-shell">
            <table className="data-table compare-table duplicate-path-table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>文件名</th>
                  <th>完整路径</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {duplicatePaths.map((path) => (
                  <tr key={path} className={selectedDuplicatePaths.has(path) ? 'selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${path}`}
                        checked={selectedDuplicatePaths.has(path)}
                        onChange={(event) => toggleDuplicatePath(path, event.target.checked)}
                      />
                    </td>
                    <td title={fileName(path)}>{fileName(path)}</td>
                    <td title={path}>{path}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-button" type="button" title="打开文件" onClick={() => void handleOpenVideo(path)}>
                          <ExternalLink size={20} />
                        </button>
                        <button className="icon-button" type="button" title="打开所在文件夹" onClick={() => void handleRevealPath(path)}>
                          <FolderOpen size={20} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          title="删除该文件"
                          disabled={duplicatePaths.length <= 1}
                          onClick={() => void handleDeleteDuplicatePaths([path], '删除该路径')}
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      </div>
    )
  }

  const sourceVideoPath = selectedMatch ? resolveFrameVideoPath(selectedPair, selectedMatch, 'source', videoDir) : ''
  const targetVideoPath = selectedMatch ? resolveFrameVideoPath(selectedPair, selectedMatch, 'target', videoDir) : ''

  function openVideoContextMenu(event: React.MouseEvent, side: CompareContextSide) {
    event.preventDefault()
    event.stopPropagation()
    setVideoContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 170),
      side,
    })
  }

  function addContextVideo(openMergePage: boolean) {
    if (!videoContextMenu) return
    const source = videoContextMenu.side === 'source'
    const path = source ? sourceVideoPath : targetVideoPath
    const name = source ? selectedPair.videoA : selectedPair.videoB
    const added = addMergeVideo(path, name)
    setError('')
    setNotice(added ? `${name} 已加入合并列表。` : `${name} 已在合并列表中。`)
    setVideoContextMenu(null)
    if (openMergePage) navigate('/merge')
  }

  function addContextPair() {
    addMergeVideos([
      { path: sourceVideoPath, name: selectedPair.videoA },
      { path: targetVideoPath, name: selectedPair.videoB },
    ])
    setVideoContextMenu(null)
    navigate('/merge')
  }

  async function deleteContextVideoFile() {
    if (!videoContextMenu) return
    const source = videoContextMenu.side === 'source'
    const path = source ? sourceVideoPath : targetVideoPath
    const name = source ? selectedPair.videoA : selectedPair.videoB
    setVideoContextMenu(null)
    const confirmed = window.confirm(`确定永久删除视频文件“${name}”吗？\n${path}\n\n此操作不可撤销。`)
    if (!confirmed) return
    setError('')
    setNotice('')
    try {
      const result = await deleteFiles([path])
      if (result.failed.length > 0) {
        setError(result.failed.map((item) => `${item.path}：${item.error}`).join('；'))
        return
      }
      setNotice(`已删除视频文件：${name}。返回结果总览后可删除对应记录。`)
    } catch (deleteError) {
      setError(normalizeBackendError(deleteError))
    }
  }

  return (
    <div className={previewExpanded ? 'route-fill compare-page preview-expanded' : 'route-fill compare-page'}>
      <GlassPanel className="compare-toolbar-panel">
        <div className="compare-title">
          <button type="button" onClick={() => navigate('/results')} aria-label="返回结果总览">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2>
              <Images size={28} />
              相似帧对比(Frame Comparison)
            </h2>
            <p title={`${selectedPair.videoAPath} / ${selectedPair.videoBPath}`}>
              {selectedPair.videoA} / {selectedPair.videoB}
            </p>
          </div>
        </div>

        <div className="compare-toolbar-actions">
          <Badge tone={relationTone(selectedPair.relation)}>{formatRelation(selectedPair.relation)}</Badge>
          <Badge tone="purple">相似帧(Frame Matches)：{totalFrameMatches}</Badge>
          <SelectInput value={direction} onChange={(event) => {
            setDirection(event.target.value as DirectionFilter)
            setSelectedIndex(0)
          }}>
            <option value="all">全部方向(All)</option>
            <option value="A_to_B">A 到 B(A to B)</option>
            <option value="B_to_A">B 到 A(B to A)</option>
          </SelectInput>
        </div>
      </GlassPanel>

      {(error || notice) && (
        <div className={error ? 'inline-error compact-message compare-error' : 'compact-message success-message compare-error'}>
          {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          {error || notice}
        </div>
      )}

      <GlassPanel className={previewExpanded ? 'compare-preview-panel expanded' : 'compare-preview-panel'}>
        {selectedMatch ? (
          <>
            <VideoPreview
              title="源视频(Source)-A"
              video={formatMatchVideoName(sourceVideoPath, selectedPair.videoA)}
              path={sourceVideoPath}
              frameIndex={selectedMatch.sourceFrameIndex}
              timestamp={selectedMatch.sourceTimestamp}
              viewMode={frameViewMode}
              side="source"
              comparisonOptions={comparisonFrameOptions}
              videoRef={sourceVideoRef}
              onPlaybackFocus={() => setPlaybackFocus('source')}
              onOpen={() => void handleOpenVideo(sourceVideoPath)}
              onContextMenu={(event) => openVideoContextMenu(event, 'source')}
            />
            <div className="compare-score-card">
              <span>{formatDirection(selectedMatch.direction)}</span>
              <strong>{formatScore(selectedMatch.similarity)}</strong>
              <MetricBar value={metricPercent(selectedMatch.similarity)} tone="pink" />
              <small>当前帧相似度(Frame Similarity)</small>
              <div className="pair-score-mini">
                <span title={formatPercent(selectedPair.aInB)}>A 在 B 中：{formatPercent(selectedPair.aInB)}</span>
                <span title={formatPercent(selectedPair.bInA)}>B 在 A 中：{formatPercent(selectedPair.bInA)}</span>
                <span title={formatScore(selectedPair.symmetricSimilarity)}>整体：{formatScore(selectedPair.symmetricSimilarity)}</span>
              </div>
              <div className="compare-view-toggle" aria-label="帧查看视角">
                <button
                  type="button"
                  className={frameViewMode === 'original' ? 'active' : ''}
                  onClick={() => setFrameViewMode('original')}
                >
                  原视频视角
                </button>
                <button
                  type="button"
                  className={frameViewMode === 'comparison' ? 'active' : ''}
                  onClick={() => setFrameViewMode('comparison')}
                >
                  算法视角
                </button>
              </div>
              {frameViewMode === 'original' ? (
                <>
                  <button type="button" className="sync-play-button" onClick={() => void toggleSyncPlayback()}>
                    {syncPlaying && playbackFocus === 'sync' ? <Pause size={16} /> : <PlaySquare size={16} />}
                    {syncPlaying && playbackFocus === 'sync' ? '同步暂停' : '同步播放'}
                  </button>
                  <button type="button" className="reset-frame-button" onClick={seekBothToSelectedFrame}>
                    <RotateCcw size={15} />
                    回到该帧
                  </button>
                  <em>{playbackFocus === 'sync' ? '空格同步播放/暂停' : playbackFocus === 'source' ? '空格控制左侧视频' : '空格控制右侧视频'}</em>
                </>
              ) : (
                <em title="显示裁剪黑边、竖屏旋转、统一缩放后的单帧，也就是算法实际参与特征比较的画面。">
                  显示预处理后的比对画面
                </em>
              )}
              <button type="button" className="preview-size-button" onClick={() => setPreviewExpanded((value) => !value)}>
                {previewExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                {previewExpanded ? '恢复布局' : '放大视频框'}
              </button>
            </div>
            <VideoPreview
              title="目标视频(Target)-B"
              video={formatMatchVideoName(targetVideoPath, selectedPair.videoB)}
              path={targetVideoPath}
              frameIndex={selectedMatch.targetFrameIndex}
              timestamp={selectedMatch.targetTimestamp}
              viewMode={frameViewMode}
              side="target"
              comparisonOptions={comparisonFrameOptions}
              videoRef={targetVideoRef}
              onPlaybackFocus={() => setPlaybackFocus('target')}
              onOpen={() => void handleOpenVideo(targetVideoPath)}
              onContextMenu={(event) => openVideoContextMenu(event, 'target')}
            />
          </>
        ) : (
          <div className="compare-no-match">
            <AlertCircle size={30} />
            <h3>当前报告没有相似帧明细(Frame Matches)</h3>
            <p>请重新运行分析，生成包含 matches_a_to_b / matches_b_to_a 时间戳的新报告。</p>
          </div>
        )}
      </GlassPanel>

      <div className="compare-detail-grid">
        <GlassPanel className="compare-list-panel">
          <div className="compare-list-head">
            <h3>相似帧列表(Frame Match List)</h3>
            <div className="frame-direction-counts">
              <span title={`报告总数 ${matchesAToBCount}，列表最多保留高分样本`}>A→B {matchesAToBCount} 条</span>
              <span title={`报告总数 ${matchesBToACount}，列表最多保留高分样本`}>B→A {matchesBToACount} 条</span>
            </div>
          </div>

          <div className="table-shell compare-table-shell">
            <table className="data-table compare-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>方向(Direction)</th>
                  <th>源时间(Source Time)</th>
                  <th>目标时间(Target Time)</th>
                  <th>源帧(Source Frame)</th>
                  <th>目标帧(Target Frame)</th>
                  <th>相似度(Similarity)</th>
                </tr>
              </thead>
              <tbody>
                {matches.length > 0 ? matchSections.flatMap((section) => {
                  const header = (
                    <tr className="frame-direction-section" key={`${section.direction}-header`}>
                      <td colSpan={7}>
                        <strong>{section.label}</strong>
                        <span>{section.rows.length} 条匹配</span>
                      </td>
                    </tr>
                  )
                  const rows = section.rows.map((match, sectionIndex) => {
                    const index = matches.indexOf(match)
                    return (
                      <tr
                        className={index === safeSelectedIndex ? 'selected' : ''}
                        key={`${match.direction}-${match.sourceFrameIndex}-${match.targetFrameIndex}-${sectionIndex}`}
                        onClick={() => setSelectedIndex(index)}
                      >
                        <td title={String(sectionIndex + 1)}>{sectionIndex + 1}</td>
                        <td title={formatDirection(match.direction)}>{formatDirection(match.direction)}</td>
                        <td title={formatHHMMSS(match.sourceTimestamp)}>{formatHHMMSS(match.sourceTimestamp)}</td>
                        <td title={formatHHMMSS(match.targetTimestamp)}>{formatHHMMSS(match.targetTimestamp)}</td>
                        <td>
                          <span className="video-name" title={String(match.sourceFrameIndex ?? '-')}>
                            <PlaySquare size={18} />
                            {match.sourceFrameIndex ?? '-'}
                          </span>
                        </td>
                        <td>
                          <span className="video-name" title={String(match.targetFrameIndex ?? '-')}>
                            <PlaySquare size={18} />
                            {match.targetFrameIndex ?? '-'}
                          </span>
                        </td>
                        <td title={formatScore(match.similarity)}>
                          <div className="metric-cell">
                            <span>{formatScore(match.similarity)}</span>
                            <MetricBar value={metricPercent(match.similarity)} tone="blue" />
                          </div>
                        </td>
                      </tr>
                    )
                  })
                  return [header, ...rows]
                }) : (
                  <tr>
                    <td colSpan={7} className="empty-table-cell">
                      没有可展示的相似帧(Frame Matches)。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassPanel>

        <GlassPanel className="compare-segments-panel">
          <div className="compare-list-head">
            <h3>匹配片段(Matched Segments)</h3>
            <span>{selectedPair.matchedSegments.length} 条</span>
          </div>
          <div className="table-shell compare-table-shell compact">
            <table className="data-table compare-table">
              <thead>
                <tr>
                  <th>A 时间(A Range)</th>
                  <th>B 时间(B Range)</th>
                  <th>覆盖率(Coverage)</th>
                  <th>相似度(Similarity)</th>
                  <th>匹配数(Matches)</th>
                </tr>
              </thead>
              <tbody>
                {selectedPair.matchedSegments.length > 0 ? selectedPair.matchedSegments.map((segment, index) => (
                  <tr key={`${selectedPair.id}-segment-${index}`}>
                    <td title={`${formatHHMMSS(segment.aStart)} - ${formatHHMMSS(segment.aEnd)}`}>{formatHHMMSS(segment.aStart)} - {formatHHMMSS(segment.aEnd)}</td>
                    <td title={`${formatHHMMSS(segment.bStart)} - ${formatHHMMSS(segment.bEnd)}`}>{formatHHMMSS(segment.bStart)} - {formatHHMMSS(segment.bEnd)}</td>
                    <td title={formatPercent(segment.coverage)}>{formatPercent(segment.coverage)}</td>
                    <td title={formatScore(segment.avgSimilarity)}>{formatScore(segment.avgSimilarity)}</td>
                    <td title={String(segment.matchCount ?? '-')}>{segment.matchCount ?? '-'}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={5} className="empty-table-cell">该视频对没有匹配片段(matched_segments)明细。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassPanel>

        <GlassPanel className="compare-windows-panel">
          <div className="compare-list-head">
            <h3>时间窗口(Window Similarity)</h3>
            <span>{selectedPair.windowSimilarity.length} 条</span>
          </div>
          <div className="table-shell compare-table-shell compact">
            <table className="data-table compare-table">
              <thead>
                <tr>
                  <th>方向(Direction)</th>
                  <th>源窗口(Source)</th>
                  <th>目标窗口(Target)</th>
                  <th>覆盖率(Coverage)</th>
                  <th>相似度(Similarity)</th>
                </tr>
              </thead>
              <tbody>
                {selectedPair.windowSimilarity.length > 0 ? selectedPair.windowSimilarity.map((window, index) => (
                  <tr key={`${selectedPair.id}-window-${index}`}>
                    <td title={formatWindowDirection(window.direction)}>{formatWindowDirection(window.direction)}</td>
                    <td title={`${formatHHMMSS(window.sourceStart)} - ${formatHHMMSS(window.sourceEnd)}`}>{formatHHMMSS(window.sourceStart)} - {formatHHMMSS(window.sourceEnd)}</td>
                    <td title={`${formatHHMMSS(window.bestTargetStart)} - ${formatHHMMSS(window.bestTargetEnd)}`}>{formatHHMMSS(window.bestTargetStart)} - {formatHHMMSS(window.bestTargetEnd)}</td>
                    <td title={formatPercent(window.matchedFrameRatio)}>{formatPercent(window.matchedFrameRatio)}</td>
                    <td title={formatScore(window.avgSimilarity)}>{formatScore(window.avgSimilarity)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={5} className="empty-table-cell">该视频对没有时间窗口相似度明细。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      </div>
      {videoContextMenu && createPortal(
        <div
          className="video-context-menu"
          style={{ left: videoContextMenu.x, top: videoContextMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong title={videoContextMenu.side === 'source' ? sourceVideoPath : targetVideoPath}>
            {videoContextMenu.side === 'source' ? selectedPair.videoA : selectedPair.videoB}
          </strong>
          <button type="button" role="menuitem" onClick={() => addContextVideo(false)}>
            <ListPlus />加入合并列表
          </button>
          <button type="button" role="menuitem" onClick={addContextPair}>
            <Clapperboard />将该视频对加入并打开合并页
          </button>
          <button type="button" role="menuitem" onClick={() => addContextVideo(true)}>
            <Clapperboard />加入并打开合并页
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => void deleteContextVideoFile()}>
            <Trash2 />删除视频文件
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

function VideoPreview({
  title,
  video,
  path,
  frameIndex,
  timestamp,
  viewMode,
  side,
  comparisonOptions,
  videoRef,
  onPlaybackFocus,
  onOpen,
  onContextMenu,
}: {
  title: string
  video: string
  path: string
  frameIndex: number | null
  timestamp: number | null
  viewMode: FrameViewMode
  side: Exclude<PlaybackFocus, 'sync'>
  comparisonOptions: ComparisonFrameOptions
  videoRef: RefObject<HTMLVideoElement | null>
  onPlaybackFocus: () => void
  onOpen: () => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}) {
  const [failedPath, setFailedPath] = useState('')
  const [statusResult, setStatusResult] = useState<{
    path: string
    status: PathStatus | null
    error: string
  } | null>(null)
  const [framePreview, setFramePreview] = useState<{
    key: string
    dataUrl: string
    error: string
  } | null>(null)
  const [comparisonPreview, setComparisonPreview] = useState<{
    key: string
    dataUrl: string
    error: string
    loading: boolean
  } | null>(null)
  const status = statusResult?.path === path ? statusResult.status : null
  const statusError = statusResult?.path === path ? statusResult.error : ''
  const normalizedPath = status?.normalizedPath || path
  const pathExists = Boolean(path && (!status || (status.exists && status.isFile)))
  const src = pathExists ? localFileSrc(normalizedPath) : ''
  const failed = failedPath === normalizedPath
  const previewKey = `${normalizedPath}::${timestamp ?? ''}::${frameIndex ?? ''}`
  const previewDataUrl = framePreview?.key === previewKey ? framePreview.dataUrl : ''
  const previewError = framePreview?.key === previewKey ? framePreview.error : ''
  const comparisonKey = `${normalizedPath}::${timestamp ?? ''}::${frameIndex ?? ''}::${comparisonOptions.cropBlackBorders}::${comparisonOptions.resizeMode}::${comparisonOptions.inputSize}::${comparisonOptions.portraitRotation}`
  const comparisonDataUrl = comparisonPreview?.key === comparisonKey ? comparisonPreview.dataUrl : ''
  const comparisonError = comparisonPreview?.key === comparisonKey ? comparisonPreview.error : ''
  const comparisonLoading = comparisonPreview?.key === comparisonKey
    ? comparisonPreview.loading
    : viewMode === 'comparison'
      && pathExists
      && !comparisonDataUrl
      && !comparisonError
      && Number.isFinite(timestamp ?? Number.NaN)

  useEffect(() => {
    let alive = true
    if (!path) return undefined

    const cached = pathStatusCache.get(path)
    if (cached) {
      const timer = window.setTimeout(() => setStatusResult({ path, status: cached.status, error: cached.error }), 0)
      return () => window.clearTimeout(timer)
    }

    pathStatus(path)
      .then((nextStatus) => {
        pathStatusCache.set(path, { status: nextStatus, error: '' })
        if (alive) setStatusResult({ path, status: nextStatus, error: '' })
      })
      .catch((error) => {
        const message = normalizeBackendError(error)
        pathStatusCache.set(path, { status: null, error: message })
        if (alive) setStatusResult({ path, status: null, error: message })
      })

    return () => {
      alive = false
    }
  }, [path])

  useEffect(() => {
    const element = videoRef.current
    if (viewMode !== 'original' || failed || !src || !element || !Number.isFinite(timestamp ?? Number.NaN)) return undefined

    const seek = () => {
      seekVideoTo(element, timestamp)
    }

    if (element.readyState >= 1) {
      seek()
      return undefined
    }

    element.addEventListener('loadedmetadata', seek, { once: true })
    return () => element.removeEventListener('loadedmetadata', seek)
  }, [failed, src, timestamp, videoRef, viewMode])

  useEffect(() => {
    let alive = true
    if (viewMode !== 'original' || !failed || !pathExists || !normalizedPath || !Number.isFinite(timestamp ?? Number.NaN)) return undefined

    const cached = framePreviewCache.get(previewKey)
    if (cached) {
      const timer = window.setTimeout(() => setFramePreview({ key: previewKey, dataUrl: cached.dataUrl, error: cached.error }), 0)
      return () => window.clearTimeout(timer)
    }

    captureVideoFrame(normalizedPath, timestamp, frameIndex)
      .then((dataUrl) => {
        framePreviewCache.set(previewKey, { dataUrl, error: '' })
        if (alive) setFramePreview({ key: previewKey, dataUrl, error: '' })
      })
      .catch((error) => {
        const message = normalizeBackendError(error)
        framePreviewCache.set(previewKey, { dataUrl: '', error: message })
        if (alive) setFramePreview({ key: previewKey, dataUrl: '', error: message })
      })

    return () => {
      alive = false
    }
  }, [failed, frameIndex, normalizedPath, pathExists, previewKey, timestamp, viewMode])

  useEffect(() => {
    let alive = true
    if (viewMode !== 'comparison' || !pathExists || !normalizedPath || !Number.isFinite(timestamp ?? Number.NaN)) return undefined

    const cached = comparisonFrameCache.get(comparisonKey)
    if (cached) {
      const timer = window.setTimeout(() => setComparisonPreview({ key: comparisonKey, dataUrl: cached.dataUrl, error: cached.error, loading: false }), 0)
      return () => window.clearTimeout(timer)
    }

    captureComparisonFrame(normalizedPath, timestamp, comparisonOptions, frameIndex)
      .then((dataUrl) => {
        comparisonFrameCache.set(comparisonKey, { dataUrl, error: '' })
        if (alive) setComparisonPreview({ key: comparisonKey, dataUrl, error: '', loading: false })
      })
      .catch((error) => {
        const message = normalizeBackendError(error)
        comparisonFrameCache.set(comparisonKey, { dataUrl: '', error: message })
        if (alive) setComparisonPreview({ key: comparisonKey, dataUrl: '', error: message, loading: false })
      })

    return () => {
      alive = false
    }
  }, [comparisonKey, comparisonOptions, frameIndex, normalizedPath, pathExists, timestamp, viewMode])

  return (
    <article className="frame-preview-card video-preview-card" onContextMenu={onContextMenu}>
      <div className="frame-preview-head">
        <div>
          <h3 title={title}>{title}</h3>
          <p title={video}>{video}</p>
        </div>
        <button type="button" onClick={onOpen} disabled={!path} title="打开视频">
          <ExternalLink size={18} />
        </button>
      </div>

      <div className={viewMode === 'comparison' ? 'frame-image-box algorithm-frame-box' : 'frame-image-box video-box'}>
        {viewMode === 'comparison' ? (
          comparisonDataUrl ? (
            <img src={comparisonDataUrl} alt={`${video} 算法视角 ${formatHHMMSS(timestamp)}`} />
          ) : (
            <div className="frame-image-missing">
              <Images size={24} />
              <span>{comparisonLoading ? '正在生成算法视角帧...' : comparisonError ? `算法视角生成失败：${comparisonError}` : videoUnavailableMessage(path, status, false, statusError, '')}</span>
            </div>
          )
        ) : src && !failed ? (
          <video
            ref={videoRef}
            data-side={side}
            src={src}
            controls
            preload="metadata"
            playsInline
            onPointerDown={onPlaybackFocus}
            onFocus={onPlaybackFocus}
            onError={() => setFailedPath(normalizedPath)}
          >
            <track kind="captions" />
          </video>
        ) : previewDataUrl ? (
          <img src={previewDataUrl} alt={`${video} ${formatHHMMSS(timestamp)}`} />
        ) : (
          <div className="frame-image-missing">
            <Film size={24} />
            <span>{videoUnavailableMessage(path, status, failed, statusError, previewError)}</span>
          </div>
        )}
      </div>

      <dl className="frame-meta-grid">
        <div>
          <dt>帧号(Frame)</dt>
          <dd title={String(frameIndex ?? '-')}>{frameIndex ?? '-'}</dd>
        </div>
        <div>
          <dt>时间(Time)</dt>
          <dd title={formatHHMMSS(timestamp)}>{formatHHMMSS(timestamp)}</dd>
        </div>
        <div>
          <dt>路径(Path)</dt>
          <dd title={normalizedPath}>{normalizedPath ? fileName(normalizedPath) : '-'}</dd>
        </div>
        <div>
          <dt>视角(View)</dt>
          <dd title={viewMode === 'comparison' ? comparisonViewTitle(comparisonOptions) : '原视频播放视角'}>{viewMode === 'comparison' ? '算法视角' : '原视频'}</dd>
        </div>
        {failed && previewDataUrl && (
          <div>
            <dt>预览(Preview)</dt>
            <dd title="播放器无法加载，已显示帧预览">播放器无法加载，已显示帧预览</dd>
          </div>
        )}
      </dl>
    </article>
  )
}

function resolveFrameVideoPath(pair: ReportPair, match: ReportFrameMatch, role: 'source' | 'target', videoDir: string) {
  const isSource = role === 'source'
  const candidate = isSource ? match.sourceVideo : match.targetVideo

  if (match.direction === 'A_to_B') {
    return resolveVideoPath(candidate, isSource ? pair.videoAPath : pair.videoBPath, isSource ? pair.videoA : pair.videoB, videoDir)
  }
  return resolveVideoPath(candidate, isSource ? pair.videoBPath : pair.videoAPath, isSource ? pair.videoB : pair.videoA, videoDir)
}

function getDuplicateGroupPaths(pair: ReportPair | null) {
  if (!pair) return []
  const rawPaths = Array.isArray(pair.raw.duplicate_group_paths)
    ? pair.raw.duplicate_group_paths
    : []
  const paths = rawPaths
    .map((path) => String(path ?? '').trim())
    .filter(Boolean)
  const fallback = [pair.videoAPath, pair.videoBPath].filter(Boolean)
  const unique = Array.from(new Set(paths.length > 0 ? paths : fallback))
  const mode = String(pair.raw.analysis_mode ?? '')
  return mode === 'duplicate_file' || pair.relation === 'identical_file' ? unique : []
}

function numericRawValue(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function pairPreprocessOption<T extends boolean | number | string>(
  pair: ReportPair | null,
  key: string,
  fallback: T,
): T {
  const config = pair?.raw.preprocess_config
  if (!config || typeof config !== 'object') return fallback
  const value = (config as Record<string, unknown>)[key]
  return (typeof value === typeof fallback ? value : fallback) as T
}

function formatDirection(direction: ReportFrameMatch['direction']) {
  return direction === 'A_to_B' ? 'A 到 B(A to B)' : 'B 到 A(B to A)'
}

function formatWindowDirection(direction: ReportWindow['direction']) {
  if (direction === 'A_to_B') return 'A 到 B(A to B)'
  if (direction === 'B_to_A') return 'B 到 A(B to A)'
  return '综合(combined)'
}

function formatRelation(relation: string) {
  const info = getRelationInfo(relation)
  return `${info.label}(${info.labelEn})`
}

function formatMatchVideoName(path: string, fallback: string) {
  return fileName(path) || fallback
}

function comparisonViewTitle(options: ComparisonFrameOptions) {
  return [
    `裁剪黑边=${options.cropBlackBorders ? '开启' : '关闭'}`,
    `缩放=${options.resizeMode}`,
    `分辨率=${options.inputSize}`,
    `竖屏旋转=${options.portraitRotation}`,
  ].join('；')
}

function seekVideoTo(element: HTMLVideoElement | null, timestamp: number | null | undefined) {
  if (!element || !Number.isFinite(timestamp ?? Number.NaN)) return
  const nextTime = Math.max(0, timestamp as number)
  const applySeek = () => {
    try {
      if (Math.abs(element.currentTime - nextTime) > 0.08) {
        element.currentTime = nextTime
      }
    } catch {
      // Some containers reject seeking until metadata is available.
    }
  }

  if (element.readyState >= 1) {
    applySeek()
    return
  }
  element.addEventListener('loadedmetadata', applySeek, { once: true })
}

function resolveVideoPath(candidate: string, pairPath: string, fallbackName: string, videoDir: string) {
  if (isUsablePath(candidate)) return candidate
  if (isUsablePath(pairPath)) return pairPath

  const name = fileName(candidate || pairPath || fallbackName)
  if (videoDir && name) return joinPath(videoDir, name)
  return pairPath || candidate || fallbackName
}

function isUsablePath(path: string) {
  return Boolean(path && (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || /[\\/]/.test(path)))
}

function joinPath(directory: string, name: string) {
  if (!directory) return name
  const separator = directory.includes('\\') ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name.replace(/^[\\/]+/, '')}`
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName.toLowerCase()
  return target.isContentEditable || ['input', 'textarea', 'select', 'button'].includes(tagName)
}

function videoUnavailableMessage(path: string, status: PathStatus | null, failed: boolean, statusError: string, previewError: string) {
  if (!path) return '报告没有视频路径'
  if (statusError) return '无法检查视频路径'
  if (status && !status.exists) return '视频文件不存在'
  if (status && !status.isFile) return '路径不是视频文件'
  if (previewError) return `帧预览失败：${previewError}`
  if (failed) return '播放器无法加载，正在抽取帧预览'
  return '视频路径不可用'
}
