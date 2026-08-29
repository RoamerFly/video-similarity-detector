/**
 * Progress events can arrive after a terminal merge event because the native
 * event bridge and its timer are independent. Once terminal, only an explicit
 * new running task may reopen the progress channel.
 */
export function shouldAcceptMergeProgress(terminal: boolean, running: boolean) {
  return !terminal || running
}
