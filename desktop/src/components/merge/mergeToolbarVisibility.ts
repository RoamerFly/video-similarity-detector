export function shouldShowOverlapToolbar(
  activeVideoCount: number,
  selectedOverlapGroup = false,
  groupEditing = false,
): boolean {
  return activeVideoCount > 1 || selectedOverlapGroup || groupEditing
}
