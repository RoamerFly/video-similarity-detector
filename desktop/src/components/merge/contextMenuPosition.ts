export function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  menuWidth: number,
  menuHeight: number,
) {
  return {
    left: Math.max(8, Math.min(x, width - menuWidth)),
    top: Math.max(8, Math.min(y, height - menuHeight)),
  }
}
