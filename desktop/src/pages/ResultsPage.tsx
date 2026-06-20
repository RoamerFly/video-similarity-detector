import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsUpDown,
  Clapperboard,
  Eye,
  Film,
  Flame,
  FolderOpen,
  GitBranch,
  Grid2X2,
  Images,
  ListPlus,
  PlaySquare,
  RefreshCw,
  Search,
  Shapes,
  Trash2,
} from 'lucide-react'
import {
  Badge,
  GlassPanel,
  MetricBar,
  NeonButton,
  SelectInput,
  StatCard,
  TextInput,
} from '@/components/DesignSystem'
import { deleteFiles, fileName, formatDateTime, getAppInfo, listReports, normalizeBackendError, openFile, pathStatus, revealInFolder, type ReportSummary } from '@/services/backend'
import { useAnalysisStore } from '@/stores/analysisStore'
import { useMergeStore } from '@/stores/mergeStore'
import {
  useResultsViewStore,
  type RelationFilter,
  type ReportReadFormat,
  type ResultsSortKey as SortKey,
  type ResultsSortState as SortState,
} from '@/stores/resultsViewStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  formatHHMMSS,
  formatPercent,
  formatScore,
  loadBatchReport,
  metricPercent,
  summarizePairs,
  type BatchReport,
  type ReportPair,
  type ReportWindow,
} from '@/utils/reportParser'
import { getRelationInfo, relationTone } from '@/utils/relation'

interface ReportCandidate {
  paths: {
    reportJson?: string
    reportCsv?: string
  }
  summary: ReportSummary | null
  notice: string
}

interface VideoContextMenuState {
  x: number
  y: number
  pair: ReportPair
  side: 'A' | 'B'
}

const pageSizeOptions = [10, 20, 50]
const deletedPairsStorageKey = 'video-similarity-deleted-pairs:v1'

export function ResultsPage() {
  const navigate = useNavigate()
  const reportDir = useSettingsStore((state) => state.reportDir)
  const videoDir = useSettingsStore((state) => state.videoDir)
  const threshold = useSettingsStore((state) => state.defaultMatchThreshold)
  const hydrateAppDefaults = useSettingsStore((state) => state.hydrateAppDefaults)
  const {
    reportPaths,
    report,
    setReport,
    setResultSummary,
    setSelectedPair,
  } = useAnalysisStore()
  const {
    activeTab,
    query,
    relationFilter,
    reportReadFormat,
    sortState,
    reportOptions,
    selectedReportKey,
    page,
    pageSize,
    setActiveTab,
    setQuery,
    setRelationFilter,
    setReportReadFormat,
    setSortState,
    setReportOptions,
    setSelectedReportKey,
    setPage,
    setPageSize,
    resetPage,
  } = useResultsViewStore()
  const [reportListLoading, setReportListLoading] = useState(false)
  const [reportListError, setReportListError] = useState('')
  const [activeReport, setActiveReport] = useState<ReportSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [rawPath, setRawPath] = useState('')
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectedVideoKeys, setSelectedVideoKeys] = useState<Set<string>>(() => new Set())
  const [deletedPairIdsBySource, setDeletedPairIdsBySource] = useState<Record<string, string[]>>(readDeletedPairMap)
  const [defaultReportDir, setDefaultReportDir] = useState('')
  const [videoContextMenu, setVideoContextMenu] = useState<VideoContextMenuState | null>(null)
  const initializedRef = useRef(false)
  const addMergeVideo = useMergeStore((state) => state.addVideo)
  const addMergeVideos = useMergeStore((state) => state.addVideos)

  useEffect(() => {
    if (!videoContextMenu) return undefined
    const close = () => setVideoContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [videoContextMenu])

  const reportSourceKey = useMemo(
    () => buildReportSourceKey(report, activeReport),
    [activeReport, report],
  )
  const deletedPairIds = useMemo(
    () => new Set(reportSourceKey ? deletedPairIdsBySource[reportSourceKey] ?? [] : []),
    [deletedPairIdsBySource, reportSourceKey],
  )

  useEffect(() => {
    let alive = true
    getAppInfo()
      .then((info) => {
        if (!alive) return
        hydrateAppDefaults({
          projectRoot: info.projectRoot,
          videoDir: info.defaultVideoDir,
          cacheDir: info.defaultCacheDir,
          reportDir: info.defaultOutputDir,
        })
        setDefaultReportDir(info.defaultOutputDir)
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [hydrateAppDefaults])

  const loadReportList = useCallback(async (options?: { selectLatest?: boolean }) => {
    setReportListLoading(true)
    setReportListError('')
    try {
      const lists = await Promise.all(
        uniqueNonEmpty([reportDir, defaultReportDir]).map((dir) => listReports(dir, Boolean(options?.selectLatest))),
      )
      const latestPaths: { reportJson?: string; reportCsv?: string } = reportPaths ? await existingReportPaths(reportPaths) : {}
      const merged = mergeReports([
        ...(latestPaths.reportJson || latestPaths.reportCsv ? [syntheticReportFromPaths(latestPaths, 'latest-report')] : []),
        ...lists.flat(),
      ])

      setReportOptions(merged)
      const current = useResultsViewStore.getState().selectedReportKey
      const nextKey = !options?.selectLatest && current && merged.some((item) => reportKey(item) === current)
        ? current
        : merged[0] ? reportKey(merged[0]) : ''
      setSelectedReportKey(nextKey)
      return merged
    } catch (err) {
      setReportOptions([])
      setReportListError(normalizeBackendError(err))
      return []
    } finally {
      setReportListLoading(false)
    }
  }, [defaultReportDir, reportDir, reportPaths, setReportOptions, setSelectedReportKey])

  const loadReport = useCallback(async (options?: {
    report?: ReportSummary | null
    reportList?: ReportSummary[]
    paths?: { reportJson?: string; reportCsv?: string }
    format?: ReportReadFormat
  }) => {
    setLoading(true)
    setError('')
    setNotice('')
    setRawPath('')
    try {
      const candidates: ReportCandidate[] = []
      const seen = new Set<string>()
      const addCandidate = (candidate: ReportCandidate) => {
        const paths = selectReportPaths(candidate.paths, options?.format ?? useResultsViewStore.getState().reportReadFormat)
        const key = `${paths.reportJson ?? ''}|${paths.reportCsv ?? ''}`
        if (key === '|' || seen.has(key)) return
        seen.add(key)
        candidates.push({ ...candidate, paths })
      }
      const currentView = useResultsViewStore.getState()
      const availableReports = options?.reportList ?? currentView.reportOptions
      const selectedReport = options?.report
        ?? availableReports.find((item) => reportKey(item) === currentView.selectedReportKey)
        ?? null

      if (options?.paths?.reportJson || options?.paths?.reportCsv) {
        addCandidate({
          paths: options.paths,
          summary: options.report ?? null,
          notice: '',
        })
      }

      if (selectedReport?.jsonPath || selectedReport?.csvPath) {
        addCandidate({
          paths: { reportJson: selectedReport.jsonPath, reportCsv: selectedReport.csvPath },
          summary: selectedReport,
          notice: '',
        })
      }

      if (!selectedReport && (reportPaths?.reportJson || reportPaths?.reportCsv)) {
        const existingPaths = await existingReportPaths(reportPaths)
        if (existingPaths.reportJson || existingPaths.reportCsv) {
          addCandidate({
            paths: existingPaths,
            summary: null,
            notice: '',
          })
        }
      }

      if (!selectedReport) {
        const latestFromList = availableReports.find((item) => item.jsonPath || item.csvPath) ?? null
        if (latestFromList) {
          addCandidate({
            paths: { reportJson: latestFromList.jsonPath, reportCsv: latestFromList.csvPath },
            summary: latestFromList,
            notice: '',
          })
        }
      }

      if (candidates.length === 0) {
        setActiveReport(null)
        setReport(null)
        setResultSummary(null)
        setNotice('尚未找到可读取的报告文件，完成分析后会自动显示结果。')
        setSelectedIds(new Set())
        return
      }

      const errors: string[] = []
      for (const candidate of candidates) {
        try {
          const parsed = await loadBatchReport(candidate.paths, threshold)
          setReport(parsed)
          setResultSummary(parsed.summary)
          setActiveReport(candidate.summary)
          setSelectedIds(new Set())
          if (parsed.pairs.length === 0) {
            const warningText = parsed.warnings.length > 0
              ? `报告已读取，但没有生成视频对结果；报告内有 ${parsed.warnings.length} 条警告，请查看日志或原始报告。`
              : '报告已读取，但没有生成视频对结果。'
            setNotice(warningText)
          } else if (candidate.notice) {
            setNotice(candidate.notice)
          }
          return
        } catch (err) {
          errors.push(normalizeBackendError(err))
          setRawPath(err && typeof err === 'object' && 'rawPath' in err ? String(err.rawPath ?? '') : '')
        }
      }

      throw new Error(errors.join('；') || '报告解析失败')
    } catch (err) {
      setReport(null)
      setResultSummary(null)
      setError(normalizeBackendError(err))
      setRawPath(err && typeof err === 'object' && 'rawPath' in err ? String(err.rawPath ?? '') : '')
      setSelectedIds(new Set())
    } finally {
      setLoading(false)
    }
  }, [reportPaths, setReport, setResultSummary, threshold])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const initialize = async () => {
      if (report) return

      let reports = useResultsViewStore.getState().reportOptions
      if (reports.length === 0) {
        reports = await loadReportList()
      }

      const latestPaths: { reportJson?: string; reportCsv?: string } = reportPaths
        ? await existingReportPaths(reportPaths)
        : {}
      const currentKey = useResultsViewStore.getState().selectedReportKey
      const selected = reports.find((item) => reportKey(item) === currentKey) ?? reports[0] ?? null
      await loadReport({
        report: selected,
        reportList: reports,
        paths: latestPaths.reportJson || latestPaths.reportCsv ? latestPaths : undefined,
      })
    }

    void initialize()
  }, [loadReport, loadReportList, report, reportPaths])

  useEffect(() => {
    const timer = window.setTimeout(() => resetPage(), 0)
    return () => window.clearTimeout(timer)
  }, [query, relationFilter, sortState, activeTab, pageSize, deletedPairIdsBySource, resetPage])

  const visibleSourcePairs = useMemo(
    () => (report?.pairs ?? []).filter((pair) => !deletedPairIds.has(pair.id)),
    [deletedPairIds, report?.pairs],
  )
  const visibleSourcePairIds = useMemo(
    () => visibleSourcePairs.map((pair) => pair.id),
    [visibleSourcePairs],
  )

  const filteredPairs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return [...visibleSourcePairs]
      .filter((pair) => {
        const names = `${pair.videoA} ${pair.videoB} ${fileName(pair.videoAPath)} ${fileName(pair.videoBPath)}`.toLowerCase()
        if (normalizedQuery && !names.includes(normalizedQuery)) return false
        return relationMatches(pair.relation, relationFilter)
      })
      .sort((left, right) => comparePairs(left, right, sortState))
  }, [query, relationFilter, sortState, visibleSourcePairs])

  const segmentRows = useMemo(() => filteredPairs.flatMap((pair) => pair.matchedSegments.map((segment, index) => ({
    id: `${pair.id}-${index}`,
    pair,
    segment,
  }))), [filteredPairs])
  const windowRows = useMemo(() => filteredPairs.flatMap((pair) => pair.windowSimilarity.map((window, index) => ({
    id: `${pair.id}-window-${index}`,
    pair,
    window,
  }))), [filteredPairs])

  const stats = useMemo(() => summarizePairs(visibleSourcePairs, threshold), [threshold, visibleSourcePairs])
  const totalRows = activeTab === 'results'
    ? filteredPairs.length
    : activeTab === 'segments'
      ? segmentRows.length
      : windowRows.length
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize))
  const safePage = Math.min(page, pageCount)
  const start = (safePage - 1) * pageSize
  const visiblePairs = filteredPairs.slice(start, start + pageSize)
  const visibleSegments = segmentRows.slice(start, start + pageSize)
  const visibleWindows = windowRows.slice(start, start + pageSize)
  const selectedVisibleCount = visiblePairs.filter((pair) => selectedIds.has(pair.id)).length
  const allVisibleSelected = visiblePairs.length > 0 && selectedVisibleCount === visiblePairs.length
  const selectedVideoEntries = useMemo(() => visibleSourcePairs.flatMap((pair) => {
    const rows: Array<{ key: string; pairId: string; path: string; name: string }> = []
    const aKey = videoSelectionKey(pair.id, 'A')
    const bKey = videoSelectionKey(pair.id, 'B')
    if (selectedVideoKeys.has(aKey)) {
      rows.push({
        key: aKey,
        pairId: pair.id,
        path: resolveResultVideoPath(pair.videoAPath, pair.videoA, videoDir),
        name: pair.videoA,
      })
    }
    if (selectedVideoKeys.has(bKey)) {
      rows.push({
        key: bKey,
        pairId: pair.id,
        path: resolveResultVideoPath(pair.videoBPath, pair.videoB, videoDir),
        name: pair.videoB,
      })
    }
    return rows
  }), [selectedVideoKeys, videoDir, visibleSourcePairs])

  async function handleOpenRawReport() {
    const path = rawPath || report?.sourcePath || activeReport?.jsonPath || activeReport?.csvPath
    if (!path) return
    try {
      await openFile(path)
    } catch (err) {
      setError(normalizeBackendError(err))
    }
  }

  async function handleRefreshReports() {
    const reports = await loadReportList({ selectLatest: true })
    await loadReport({
      report: reports[0] ?? null,
      reportList: reports,
      paths: reportPaths ?? undefined,
    })
  }

  async function handleReportSelection(key: string) {
    setSelectedReportKey(key)
    const selected = reportOptions.find((item) => reportKey(item) === key) ?? null
    if (selected) await loadReport({ report: selected, reportList: reportOptions })
  }

  async function handleReportFormatChange(format: ReportReadFormat) {
    setReportReadFormat(format)
    const selected = reportOptions.find((item) => reportKey(item) === selectedReportKey) ?? activeReport
    if (selected) await loadReport({ report: selected, reportList: reportOptions, format })
  }

  function handleSort(key: SortKey) {
    const current = useResultsViewStore.getState().sortState
    setSortState({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    })
  }

  function toggleSelectPair(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleVisiblePairs(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const pair of visiblePairs) {
        if (checked) next.add(pair.id)
        else next.delete(pair.id)
      }
      return next
    })
  }

  function toggleVideoSelection(pairId: string, side: 'A' | 'B', checked: boolean) {
    const key = videoSelectionKey(pairId, side)
    setSelectedVideoKeys((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function markPairsDeleted(ids: string[], message: string) {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean)
    if (!reportSourceKey || uniqueIds.length === 0) return
    setDeletedPairIdsBySource((current) => {
      const nextIds = new Set(current[reportSourceKey] ?? [])
      uniqueIds.forEach((id) => nextIds.add(id))
      const next = { ...current, [reportSourceKey]: Array.from(nextIds) }
      writeDeletedPairMap(next)
      return next
    })
    setSelectedIds(new Set())
    setSelectedVideoKeys(new Set())
    setSelectedPair(null)
    setNotice(message)
  }

  function deletePairs(ids: string[], scope: 'selected' | 'all' = 'selected') {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean)
    if (!reportSourceKey || uniqueIds.length === 0) return
    const confirmed = window.confirm(
      scope === 'all'
        ? `确定删除当前报告中的全部 ${uniqueIds.length} 条结果数据吗？`
        : uniqueIds.length === 1
          ? '确定删除这条结果数据吗？'
          : `确定删除选中的 ${uniqueIds.length} 条结果数据吗？`,
    )
    if (!confirmed) return

    markPairsDeleted(
      uniqueIds,
      scope === 'all'
        ? `已删除当前报告中的全部 ${uniqueIds.length} 条结果。`
        : `已从当前结果列表删除 ${uniqueIds.length} 条数据。`,
    )
  }

  async function deleteSelectedVideoFiles(entries = selectedVideoEntries) {
    const uniquePaths = Array.from(new Set(entries.map((entry) => entry.path).filter(Boolean)))
    if (uniquePaths.length === 0) return
    const names = Array.from(new Set(entries.map((entry) => entry.name))).slice(0, 4).join('、')
    const confirmed = window.confirm(
      `确定永久删除 ${uniquePaths.length} 个视频文件吗？\n${names}${entries.length > 4 ? ' 等' : ''}\n\n文件删除后无法恢复，对应结果记录也会从当前视图移除。`,
    )
    if (!confirmed) return

    setError('')
    try {
      const result = await deleteFiles(uniquePaths)
      const deleted = new Set(result.deletedPaths.map(normalizeComparablePath))
      const affectedPairIds = entries
        .filter((entry) => deleted.has(normalizeComparablePath(entry.path)))
        .map((entry) => entry.pairId)
      if (affectedPairIds.length > 0) {
        markPairsDeleted(affectedPairIds, `已删除 ${result.deletedPaths.length} 个视频文件及对应结果记录。`)
      }
      if (result.failed.length > 0) {
        setError(result.failed.map((item) => `${item.path}：${item.error}`).join('；'))
      } else if (affectedPairIds.length === 0) {
        setNotice(result.message)
      }
    } catch (deleteError) {
      setError(normalizeBackendError(deleteError))
    }
  }

  async function deleteContextVideoFile() {
    if (!videoContextMenu) return
    const isA = videoContextMenu.side === 'A'
    const entry = {
      key: videoSelectionKey(videoContextMenu.pair.id, videoContextMenu.side),
      pairId: videoContextMenu.pair.id,
      path: resolveResultVideoPath(
        isA ? videoContextMenu.pair.videoAPath : videoContextMenu.pair.videoBPath,
        isA ? videoContextMenu.pair.videoA : videoContextMenu.pair.videoB,
        videoDir,
      ),
      name: isA ? videoContextMenu.pair.videoA : videoContextMenu.pair.videoB,
    }
    setVideoContextMenu(null)
    await deleteSelectedVideoFiles([entry])
  }

  function openCompare(pair: ReportPair) {
    setSelectedPair(pair)
    navigate('/compare')
  }

  function openVideoContextMenu(event: React.MouseEvent, pair: ReportPair, side: 'A' | 'B') {
    event.preventDefault()
    event.stopPropagation()
    setVideoContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 180),
      pair,
      side,
    })
  }

  function addContextVideo(openMergePage = false) {
    if (!videoContextMenu) return
    const isA = videoContextMenu.side === 'A'
    const name = isA ? videoContextMenu.pair.videoA : videoContextMenu.pair.videoB
    const path = resolveResultVideoPath(
      isA ? videoContextMenu.pair.videoAPath : videoContextMenu.pair.videoBPath,
      name,
      videoDir,
    )
    const added = addMergeVideo(path, name)
    setNotice(added ? `已将 ${name} 加入合并列表。` : `${name} 已在合并列表中。`)
    setVideoContextMenu(null)
    if (openMergePage) navigate('/merge')
  }

  function addContextPair() {
    if (!videoContextMenu) return
    const pair = videoContextMenu.pair
    const added = addMergeVideos([
      { path: resolveResultVideoPath(pair.videoAPath, pair.videoA, videoDir), name: pair.videoA },
      { path: resolveResultVideoPath(pair.videoBPath, pair.videoB, videoDir), name: pair.videoB },
    ])
    setNotice(added > 0 ? `已将该视频对中的 ${added} 个视频加入合并列表。` : '该视频对已在合并列表中。')
    setVideoContextMenu(null)
  }

  return (
    <div className="route-fill results-page">
      <GlassPanel className="results-summary-panel">
        <div className="results-stat-grid">
          <StatCard title="视频数量" value={stats.videos} unit="个" icon={<Film />} tone="blue" />
          <StatCard title="比较对数" value={stats.pairs} unit="对" icon={<GitBranch />} tone="purple" />
          <StatCard title="近似重复" value={stats.highPairs} unit="对" icon={<Shapes />} tone="pink" />
          <StatCard title="部分重叠" value={stats.partialPairs} unit="对" icon={<Grid2X2 />} tone="blue" />
          <StatCard title="匹配片段" value={stats.segments} unit="个" icon={<Flame />} tone="orange" />
        </div>
      </GlassPanel>

      <GlassPanel className="results-table-panel">
        <div className="tabs-row">
          <button className={activeTab === 'results' ? 'active' : ''} type="button" onClick={() => setActiveTab('results')}>
            比较结果
          </button>
          <button className={activeTab === 'segments' ? 'active' : ''} type="button" onClick={() => setActiveTab('segments')}>
            匹配片段
          </button>
          <button className={activeTab === 'windows' ? 'active' : ''} type="button" onClick={() => setActiveTab('windows')}>
            时间窗口
          </button>
          <NeonButton variant="outline" className="refresh-report-button" onClick={() => void handleRefreshReports()} disabled={loading || reportListLoading}>
            <RefreshCw size={16} className={loading || reportListLoading ? 'spin-slow' : undefined} />
            {loading || reportListLoading ? '读取中' : '刷新'}
          </NeonButton>
        </div>

        <div className="results-filter-row">
          <label className="search-field">
            <Search size={24} />
            <TextInput value={query} placeholder="搜索视频文件名" onChange={(event) => setQuery(event.target.value)} />
          </label>

          <SelectInput
            className="report-picker-select"
            value={selectedReportKey}
            onChange={(event) => void handleReportSelection(event.target.value)}
            title={reportOptionTitle(reportOptions.find((item) => reportKey(item) === selectedReportKey))}
            disabled={reportOptions.length === 0 || reportListLoading}
          >
            <option value="">{reportListLoading ? '正在扫描报告...' : '选择报告文件'}</option>
            {reportOptions.map((item) => (
              <option value={reportKey(item)} key={reportKey(item)}>
                {reportOptionLabel(item)}
              </option>
            ))}
          </SelectInput>

          <SelectInput value={relationFilter} onChange={(event) => setRelationFilter(event.target.value as RelationFilter)}>
            <option value="all">全部关系</option>
            <option value="near">近似重复</option>
            <option value="partial">部分重叠</option>
            <option value="clip">片段包含</option>
            <option value="different">差异较大</option>
            <option value="unknown">未知关系</option>
          </SelectInput>

          <SelectInput value={reportReadFormat} onChange={(event) => void handleReportFormatChange(event.target.value as ReportReadFormat)}>
            <option value="auto">自动读取报告</option>
            <option value="json">只读 JSON 报告</option>
            <option value="csv">只读 CSV 报告</option>
          </SelectInput>

          <div className="results-action-group">
            <NeonButton variant="outline" type="button" onClick={() => {
              setMultiSelectMode((current) => {
                if (current) {
                  setSelectedIds(new Set())
                  setSelectedVideoKeys(new Set())
                }
                return !current
              })
            }}>
              <ListPlus size={16} />
              {multiSelectMode ? '退出多选' : '多选'}
            </NeonButton>
            {multiSelectMode && (
              <>
                <NeonButton
                  variant="outline"
                  tone="red"
                  type="button"
                  className="batch-delete-button"
                  disabled={selectedIds.size === 0}
                  onClick={() => deletePairs(Array.from(selectedIds))}
                >
                  <Trash2 size={16} />
                  仅删除记录({selectedIds.size})
                </NeonButton>
                <NeonButton
                  variant="outline"
                  tone="red"
                  type="button"
                  disabled={selectedVideoEntries.length === 0}
                  onClick={() => void deleteSelectedVideoFiles()}
                >
                  <Trash2 size={16} />
                  删除视频文件({selectedVideoEntries.length})
                </NeonButton>
              </>
            )}
            <NeonButton
              variant="outline"
              tone="red"
              type="button"
              className="delete-all-results-button"
              disabled={visibleSourcePairIds.length === 0}
              onClick={() => deletePairs(visibleSourcePairIds, 'all')}
            >
              <Trash2 size={16} />
              删除全部
            </NeonButton>
          </div>

          <div className="report-context-row">
            <span title={report?.sourcePath || activeReport?.path || reportDir}>
              {report?.sourcePath ? `当前报告：${report.sourcePath}` : `报告目录：${reportDir}`}
            </span>
          </div>
        </div>

        {(error || reportListError || notice) && (
          <div className={error || reportListError ? 'inline-error compact-message' : 'compact-message success-message'}>
            {error || reportListError ? <AlertCircle size={16} /> : <RefreshCw size={16} />}
            {error || reportListError || notice}
            {error && (rawPath || report?.sourcePath) && (
              <button type="button" onClick={() => void handleOpenRawReport()}>
                打开原始报告
              </button>
            )}
          </div>
        )}

        <div className="table-shell results-table-shell">
          {activeTab === 'results' ? (
            <table className="data-table results-data-table pair-results-table">
              <colgroup>
                {multiSelectMode && <col className="pair-column-select" />}
                <col className="pair-column-completed" />
                <col className="pair-column-video" />
                <col className="pair-column-video" />
                <col className="pair-column-containment" />
                <col className="pair-column-containment" />
                <col className="pair-column-similarity" />
                <col className="pair-column-relation" />
                <col className="pair-column-segments" />
                <col className="pair-column-frames" />
                <col className="pair-column-actions" />
              </colgroup>
              <thead>
                <tr>
                  {multiSelectMode && (
                    <th className="select-column">
                      <input
                        aria-label="选择当前页全部结果记录"
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) => toggleVisiblePairs(event.target.checked)}
                      />
                    </th>
                  )}
                  <SortableHeader className="completed-column" label="完成时间" sortKey="completedAt" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="video-column" label="视频 A(Video A)" sortKey="videoA" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="video-column" label="视频 B(Video B)" sortKey="videoB" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="containment-column" label="A 在 B 中(A in B)" sortKey="aInB" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="containment-column" label="B 在 A 中(B in A)" sortKey="bInA" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="similarity-column" label="整体相似度(Symmetric)" sortKey="symmetricSimilarity" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="relation-column" label="关系判断(Relation)" sortKey="relation" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="segments-column" label="匹配片段数(Segments)" sortKey="matchedSegmentCount" sortState={sortState} onSort={handleSort} />
                  <SortableHeader className="frames-column" label="相似帧(Frame Matches)" sortKey="frameMatches" sortState={sortState} onSort={handleSort} />
                  <th className="actions-column">操作(Action)</th>
                </tr>
              </thead>
              <tbody>
                {visiblePairs.length > 0 ? visiblePairs.map((pair) => (
                  <tr key={pair.id} onDoubleClick={() => openCompare(pair)}>
                    {multiSelectMode && (
                      <td className="select-column" onClick={(event) => event.stopPropagation()}>
                        <input
                          aria-label={`选择记录 ${pair.videoA} 和 ${pair.videoB}`}
                          type="checkbox"
                          checked={selectedIds.has(pair.id)}
                          onChange={(event) => toggleSelectPair(pair.id, event.target.checked)}
                        />
                      </td>
                    )}
                    <td className="completed-column" title={formatDateTime(pair.completedAt || report?.timestamp)}>{formatDateTime(pair.completedAt || report?.timestamp)}</td>
                    <td className="video-column" title={pair.videoAPath || pair.videoA} onContextMenu={(event) => openVideoContextMenu(event, pair, 'A')}>
                      <span className="video-name">
                        {multiSelectMode && (
                          <input
                            type="checkbox"
                            aria-label={`选择视频文件 ${pair.videoA}`}
                            checked={selectedVideoKeys.has(videoSelectionKey(pair.id, 'A'))}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleVideoSelection(pair.id, 'A', event.target.checked)}
                          />
                        )}
                        <PlaySquare size={24} />
                        <span className="video-name-text" title={pair.videoAPath || pair.videoA}>{pair.videoA || '-'}</span>
                      </span>
                    </td>
                    <td className="video-column" title={pair.videoBPath || pair.videoB} onContextMenu={(event) => openVideoContextMenu(event, pair, 'B')}>
                      <span className="video-name">
                        {multiSelectMode && (
                          <input
                            type="checkbox"
                            aria-label={`选择视频文件 ${pair.videoB}`}
                            checked={selectedVideoKeys.has(videoSelectionKey(pair.id, 'B'))}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => toggleVideoSelection(pair.id, 'B', event.target.checked)}
                          />
                        )}
                        <PlaySquare size={24} />
                        <span className="video-name-text" title={pair.videoBPath || pair.videoB}>{pair.videoB || '-'}</span>
                      </span>
                    </td>
                    <td className="containment-column">
                      <div className="metric-cell">
                        <span>{formatPercent(pair.aInB)}</span>
                        <MetricBar value={metricPercent(pair.aInB)} />
                      </div>
                    </td>
                    <td className="containment-column">
                      <div className="metric-cell">
                        <span>{formatPercent(pair.bInA)}</span>
                        <MetricBar value={metricPercent(pair.bInA)} tone="pink" />
                      </div>
                    </td>
                    <td className="similarity-column similarity-value" title={formatScore(pair.symmetricSimilarity)}>{formatScore(pair.symmetricSimilarity)}</td>
                    <td className="relation-column relation-cell" title={formatRelation(pair.relation)}>
                      <Badge className="relation-badge" tone={relationTone(pair.relation)}>{formatRelation(pair.relation)}</Badge>
                    </td>
                    <td className="segments-column" title={String(pair.matchedSegmentCount)}>{pair.matchedSegmentCount}</td>
                    <td className="frames-column">
                      <button className="frame-link-button" type="button" title={`相似帧：${formatFrameMatchCount(pair)}，点击进入对比视图`} onClick={(event) => {
                        event.stopPropagation()
                        openCompare(pair)
                      }}>
                        <Images size={18} />
                        {formatFrameMatchCount(pair)}
                      </button>
                    </td>
                    <td className="actions-column">
                      <div className="row-actions">
                        <button className="icon-button" type="button" aria-label={`查看 ${pair.videoA}`} title="双击行也可进入对比视图" onClick={(event) => {
                          event.stopPropagation()
                          openCompare(pair)
                        }}>
                          <Eye size={22} />
                        </button>
                        <button className="icon-button danger" type="button" aria-label={`删除 ${pair.videoA}`} onClick={(event) => {
                          event.stopPropagation()
                          deletePairs([pair.id])
                        }}>
                          <Trash2 size={22} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={multiSelectMode ? 11 : 10} className="empty-table-cell">
                      {loading ? '正在读取真实报告...' : report ? '没有找到可展示的视频对结果。' : '尚未运行分析，请先选择视频目录并开始分析。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : activeTab === 'segments' ? (
            <table className="data-table results-data-table">
              <thead>
                <tr>
                  <th>视频对(Video Pair)</th>
                  <th>A 时间范围(A Range)</th>
                  <th>B 时间范围(B Range)</th>
                  <th>覆盖率(Coverage)</th>
                  <th>平均相似度(Avg Similarity)</th>
                  <th>可信度(Confidence)</th>
                  <th>匹配数(Match Count)</th>
                </tr>
              </thead>
              <tbody>
                {visibleSegments.length > 0 ? visibleSegments.map(({ id, pair, segment }) => (
                  <tr key={id} onDoubleClick={() => openCompare(pair)}>
                    <td title={`${pair.videoAPath || pair.videoA} / ${pair.videoBPath || pair.videoB}`}>{pair.videoA} / {pair.videoB}</td>
                    <td title={`${formatHHMMSS(segment.aStart)} - ${formatHHMMSS(segment.aEnd)}`}>{formatHHMMSS(segment.aStart)} - {formatHHMMSS(segment.aEnd)}</td>
                    <td title={`${formatHHMMSS(segment.bStart)} - ${formatHHMMSS(segment.bEnd)}`}>{formatHHMMSS(segment.bStart)} - {formatHHMMSS(segment.bEnd)}</td>
                    <td title={formatPercent(segment.coverage)}>{formatPercent(segment.coverage)}</td>
                    <td className="similarity-value" title={formatScore(segment.avgSimilarity)}>{formatScore(segment.avgSimilarity)}</td>
                    <td title={formatPercent(segment.confidence)}>{formatPercent(segment.confidence)}</td>
                    <td title={String(segment.matchCount ?? '-')}>{segment.matchCount ?? '-'}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={7} className="empty-table-cell">
                      当前报告没有可展示的匹配片段(matched_segments)，可双击比较结果进入对比视图查看详情。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="data-table results-data-table">
              <thead>
                <tr>
                  <th>视频对(Video Pair)</th>
                  <th>方向(Direction)</th>
                  <th>源窗口(Source Window)</th>
                  <th>最佳目标窗口(Best Target)</th>
                  <th>匹配帧(Matched Frames)</th>
                  <th>窗口覆盖率(Window Coverage)</th>
                  <th>平均相似度(Avg Similarity)</th>
                </tr>
              </thead>
              <tbody>
                {visibleWindows.length > 0 ? visibleWindows.map(({ id, pair, window }) => (
                  <tr key={id} onDoubleClick={() => openCompare(pair)}>
                    <td title={`${pair.videoAPath || pair.videoA} / ${pair.videoBPath || pair.videoB}`}>{pair.videoA} / {pair.videoB}</td>
                    <td title={formatWindowDirection(window.direction)}>{formatWindowDirection(window.direction)}</td>
                    <td title={`${formatHHMMSS(window.sourceStart)} - ${formatHHMMSS(window.sourceEnd)}`}>{formatHHMMSS(window.sourceStart)} - {formatHHMMSS(window.sourceEnd)}</td>
                    <td title={`${formatHHMMSS(window.bestTargetStart)} - ${formatHHMMSS(window.bestTargetEnd)}`}>{formatHHMMSS(window.bestTargetStart)} - {formatHHMMSS(window.bestTargetEnd)}</td>
                    <td title={String(window.matchedFrameCount ?? '-')}>{window.matchedFrameCount ?? '-'}</td>
                    <td>
                      <div className="metric-cell">
                        <span>{formatPercent(window.matchedFrameRatio)}</span>
                        <MetricBar value={metricPercent(window.matchedFrameRatio)} tone="blue" />
                      </div>
                    </td>
                    <td className="similarity-value" title={formatScore(window.avgSimilarity)}>{formatScore(window.avgSimilarity)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={7} className="empty-table-cell">
                      当前报告没有可展示的时间窗口相似度。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="pagination-row">
          <span>共 {totalRows} 条结果</span>
          <div className="pagination-center">
            <button type="button" disabled={safePage <= 1} onClick={() => setPage(Math.max(1, safePage - 1))}>上一页</button>
            {pageNumbers(safePage, pageCount).map((item) => (
              <button className={item === safePage ? 'active' : ''} type="button" key={item} onClick={() => setPage(item)}>
                第 {item} 页
              </button>
            ))}
            <button type="button" disabled={safePage >= pageCount} onClick={() => setPage(Math.min(pageCount, safePage + 1))}>下一页</button>
            <label className="page-jump-control">
              <span>跳至</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={safePage}
                aria-label="输入页码跳转"
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next)) setPage(Math.max(1, Math.min(pageCount, next)))
                }}
              />
              <span>页</span>
            </label>
          </div>
          <label className="page-size-control">
            <span>每页</span>
            <SelectInput value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              {pageSizeOptions.map((size) => (
                <option value={size} key={size}>{size} 条</option>
              ))}
            </SelectInput>
            <ChevronDown size={18} />
          </label>
        </div>
      </GlassPanel>
      {videoContextMenu && createPortal(
        <div
          className="video-context-menu"
          style={{ left: videoContextMenu.x, top: videoContextMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong title={videoContextMenu.side === 'A' ? videoContextMenu.pair.videoAPath : videoContextMenu.pair.videoBPath}>
            {videoContextMenu.side === 'A' ? videoContextMenu.pair.videoA : videoContextMenu.pair.videoB}
          </strong>
          <button type="button" role="menuitem" onClick={() => addContextVideo(false)}>
            <ListPlus />加入合并列表
          </button>
          <button type="button" role="menuitem" onClick={addContextPair}>
            <Clapperboard />将该视频对加入列表
          </button>
          <button type="button" role="menuitem" onClick={() => addContextVideo(true)}>
            <Clapperboard />加入并打开合并页
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const isA = videoContextMenu.side === 'A'
            const path = resolveResultVideoPath(
              isA ? videoContextMenu.pair.videoAPath : videoContextMenu.pair.videoBPath,
              isA ? videoContextMenu.pair.videoA : videoContextMenu.pair.videoB,
              videoDir,
            )
            setVideoContextMenu(null)
            void revealInFolder(path).catch((error) => setError(normalizeBackendError(error)))
          }}>
            <FolderOpen />在文件夹中显示
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

function SortableHeader({
  className,
  label,
  sortKey,
  sortState,
  onSort,
}: {
  className?: string
  label: string
  sortKey: SortKey
  sortState: SortState
  onSort: (key: SortKey) => void
}) {
  const active = sortState.key === sortKey
  const Icon = !active ? ChevronsUpDown : sortState.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <th className={className}>
      <button className={`sort-header-button ${active ? 'active' : ''}`} type="button" title={label} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <Icon size={15} />
      </button>
    </th>
  )
}

function formatWindowDirection(direction: ReportWindow['direction']) {
  if (direction === 'A_to_B') return 'A 到 B(A to B)'
  if (direction === 'B_to_A') return 'B 到 A(B to A)'
  return '综合(combined)'
}

function formatFrameMatchCount(pair: ReportPair) {
  return pair.matchesAToBTotal + pair.matchesBToATotal || pair.frameMatches.length
}

function videoSelectionKey(pairId: string, side: 'A' | 'B') {
  return `${pairId}::${side}`
}

function normalizeComparablePath(path: string) {
  return path.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function formatRelation(relation: string) {
  const info = getRelationInfo(relation)
  return `${info.label}(${info.labelEn})`
}

function comparePairs(left: ReportPair, right: ReportPair, sortState: SortState) {
  const direction = sortState.direction === 'asc' ? 1 : -1
  const result = comparePairValues(left, right, sortState.key)
  return result * direction
}

function comparePairValues(left: ReportPair, right: ReportPair, key: SortKey) {
  if (key === 'videoA') return compareText(left.videoA, right.videoA)
  if (key === 'videoB') return compareText(left.videoB, right.videoB)
  if (key === 'relation') {
    const rankDifference = relationSortRank(left.relation) - relationSortRank(right.relation)
    return rankDifference || compareText(formatRelation(left.relation), formatRelation(right.relation))
  }
  if (key === 'completedAt') return compareNullableNumber(timeValue(left.completedAt), timeValue(right.completedAt))
  if (key === 'aInB') return compareNullableNumber(left.aInB, right.aInB)
  if (key === 'bInA') return compareNullableNumber(left.bInA, right.bInA)
  if (key === 'matchedSegmentCount') return compareNullableNumber(left.matchedSegmentCount, right.matchedSegmentCount)
  if (key === 'frameMatches') return compareNullableNumber(formatFrameMatchCount(left), formatFrameMatchCount(right))
  return compareNullableNumber(left.symmetricSimilarity, right.symmetricSimilarity)
}

function relationSortRank(relation: string) {
  const normalized = relation.toLowerCase()
  if (normalized.includes('identical')) return 5
  if (normalized.includes('clip') || normalized.includes('contains')) return 4
  if (normalized.includes('near')) return 3
  if (normalized.includes('partial')) return 2
  if (normalized.includes('similar')) return 1
  if (normalized.includes('different')) return 0
  return -1
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function compareNullableNumber(left: number | null | undefined, right: number | null | undefined) {
  const leftOk = Number.isFinite(left ?? Number.NaN)
  const rightOk = Number.isFinite(right ?? Number.NaN)
  if (!leftOk && !rightOk) return 0
  if (!leftOk) return -1
  if (!rightOk) return 1
  return (left as number) - (right as number)
}

function timeValue(value: string) {
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function relationMatches(relation: string, filter: RelationFilter) {
  if (filter === 'all') return true
  const normalized = relation.toLowerCase()
  const label = getRelationInfo(relation).label
  if (filter === 'near') return normalized.includes('near') || normalized.includes('identical') || label.includes('重复')
  if (filter === 'partial') return normalized.includes('partial') || normalized.includes('contains') || label.includes('重叠') || label.includes('包含')
  if (filter === 'clip') return normalized.includes('clip') || label.includes('片段')
  if (filter === 'unknown') return normalized === 'unknown' || label.includes('未知')
  return normalized.includes('different') || label.includes('差异')
}

function buildReportSourceKey(report: BatchReport | null, activeReport: ReportSummary | null) {
  const path = report?.sourcePath || activeReport?.path || ''
  if (!path) return ''
  const version = report?.timestamp || activeReport?.modifiedAt || ''
  return `${path}::${version || 'unknown-version'}`
}

function selectReportPaths(paths: { reportJson?: string; reportCsv?: string }, format: ReportReadFormat) {
  if (format === 'json') return { reportJson: paths.reportJson }
  if (format === 'csv') return { reportCsv: paths.reportCsv }
  return paths
}

function mergeReports(reports: ReportSummary[]) {
  const byKey = new Map<string, ReportSummary>()
  for (const report of reports) {
    if (!report.jsonPath && !report.csvPath) continue
    const key = reportKey(report)
    if (!key) continue
    const current = byKey.get(key)
    if (!current || timeValue(report.modifiedAt) > timeValue(current.modifiedAt)) {
      byKey.set(key, report)
    }
  }
  return Array.from(byKey.values()).sort((left, right) => compareNullableNumber(timeValue(right.modifiedAt), timeValue(left.modifiedAt)))
}

function reportKey(report: ReportSummary) {
  return report.path || report.jsonPath || report.csvPath || report.htmlPath || report.id
}

function reportOptionLabel(report: ReportSummary) {
  const time = formatDateTime(report.modifiedAt || report.createdAt)
  const suffix = report.pairCount > 0 ? ` · ${report.pairCount} 对` : ''
  return `${report.name}${time !== '-' ? ` · ${time}` : ''}${suffix}`
}

function reportOptionTitle(report?: ReportSummary) {
  if (!report) return ''
  return [
    `报告：${report.name}`,
    `路径：${report.path || report.jsonPath || report.csvPath || '-'}`,
    `格式：${report.formats.join(' / ') || '-'}`,
    `修改时间：${formatDateTime(report.modifiedAt || report.createdAt)}`,
  ].join('\n')
}

function syntheticReportFromPaths(paths: { reportJson?: string; reportCsv?: string }, id: string): ReportSummary {
  const path = paths.reportJson || paths.reportCsv || ''
  const now = new Date().toISOString()
  return {
    id,
    path,
    jsonPath: paths.reportJson,
    csvPath: paths.reportCsv,
    htmlPath: undefined,
    name: reportNameFromPath(path),
    createdAt: now,
    modifiedAt: now,
    sizeBytes: 0,
    videoCount: 0,
    pairCount: 0,
    warningCount: 0,
    status: '最近分析',
    formats: ['JSON', 'CSV'].filter((_, index) => [paths.reportJson, paths.reportCsv][index]),
  }
}

function reportNameFromPath(path?: string) {
  if (!path) return '最近分析报告'
  const name = fileName(path)
  return name.replace(/\.(json|csv|html)$/i, '') || name
}

async function existingReportPaths(paths: { reportJson?: string; reportCsv?: string }) {
  const [jsonExists, csvExists] = await Promise.all([
    isExistingFile(paths.reportJson),
    isExistingFile(paths.reportCsv),
  ])
  return {
    reportJson: jsonExists ? paths.reportJson : undefined,
    reportCsv: csvExists ? paths.reportCsv : undefined,
  }
}

async function isExistingFile(path?: string) {
  if (!path?.trim()) return false
  try {
    const status = await pathStatus(path)
    return status.exists && status.isFile
  } catch {
    return false
  }
}

function uniqueNonEmpty(values: string[]) {
  const seen = new Set<string>()
  return values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    })
}

function pageNumbers(current: number, total: number) {
  const start = Math.max(1, Math.min(current - 1, total - 2))
  const end = Math.min(total, start + 2)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function readDeletedPairMap(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(deletedPairsStorageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(String) : [],
      ]),
    )
  } catch {
    return {}
  }
}

function writeDeletedPairMap(value: Record<string, string[]>) {
  window.localStorage.setItem(deletedPairsStorageKey, JSON.stringify(value))
}

function resolveResultVideoPath(path: string, name: string, videoDir: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) return path
  const base = videoDir.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  return base ? `${base}${separator}${fileName(path || name)}` : path || name
}
