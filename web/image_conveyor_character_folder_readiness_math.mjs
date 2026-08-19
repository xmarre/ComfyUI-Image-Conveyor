export function characterFolderReadinessAction({ loaded = false, loading = false, refreshStarted = false } = {}) {
  if (loaded && !loading) return 'ready'
  if (loading) return 'wait'
  return refreshStarted ? 'error' : 'refresh'
}
