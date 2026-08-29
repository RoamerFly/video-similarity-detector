export interface TimelineLayoutMetrics {
  trackHeight: number
  trackGap: number
  rulerHeight: number
  tracksMarginTop: number
  toggleHeight: number
  panelPaddingTop: number
  panelPaddingBottom: number
  panelBorderWidth: number
  workspaceHeight: number
  panelHeight: number
}

/**
 * The timeline panel is sized from the same metrics used by its CSS rows.
 * Keeping this calculation in one place prevents empty tracks from reserving
 * space and prevents the preview/timeline grid from drifting apart.
 */
export function timelineLayoutForRows(rowCount: number, compact: boolean): TimelineLayoutMetrics {
  const rows = Math.max(1, rowCount)
  const trackHeight = compact ? 26 : 34
  const trackGap = 3
  const rulerHeight = compact ? 20 : 22
  const tracksMarginTop = 3
  // These values are also exported to CSS custom properties by MergePage;
  // keeping them here prevents the toggle row from silently clipping tracks.
  const toggleHeight = 16
  const panelPaddingTop = compact ? 3 : 5
  const panelPaddingBottom = compact ? 5 : 7
  const panelBorderWidth = 1
  const tracksHeight = rows * trackHeight + Math.max(0, rows - 1) * trackGap
  const workspaceHeight = rulerHeight + tracksMarginTop + tracksHeight
  return {
    trackHeight,
    trackGap,
    rulerHeight,
    tracksMarginTop,
    toggleHeight,
    panelPaddingTop,
    panelPaddingBottom,
    panelBorderWidth,
    workspaceHeight,
    panelHeight: panelBorderWidth * 2 + panelPaddingTop + panelPaddingBottom + toggleHeight + workspaceHeight,
  }
}

/** Height available to the panel before its synchronized timeline scrollbars. */
export function timelinePanelHeightForViewport(
  metrics: TimelineLayoutMetrics,
  viewportHeight: number,
  maxHeightFraction = 0.42,
) {
  const maxHeight = Math.max(0, viewportHeight) * Math.max(0, maxHeightFraction)
  return Math.min(metrics.panelHeight, maxHeight)
}
