export interface TimelineLayoutMetrics {
  trackHeight: number
  trackGap: number
  rulerHeight: number
  tracksMarginTop: number
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
  const panelPadding = 3 + 5
  const panelBorder = 2
  const tracksHeight = rows * trackHeight + Math.max(0, rows - 1) * trackGap
  const workspaceHeight = rulerHeight + tracksMarginTop + tracksHeight
  return {
    trackHeight,
    trackGap,
    rulerHeight,
    tracksMarginTop,
    workspaceHeight,
    panelHeight: panelBorder + panelPadding + workspaceHeight,
  }
}
