function normalizePath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return ''
  return parts.join('/')
}

function normalizeFolder(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw) return ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) return ''
  return parts.join('/')
}

export function referenceSlotPath(slot) {
  if (!slot || typeof slot !== 'object') return ''
  const explicit = normalizePath(slot.relative_path)
  if (explicit) return explicit
  if (String(slot.type ?? 'input').toLowerCase() !== 'input') return ''
  const annotated = String(slot.annotated ?? '').trim()
  return annotated.endsWith(' [input]')
    ? normalizePath(annotated.slice(0, -' [input]'.length))
    : ''
}

export function characterReferenceIndexNeedsRefresh(referenceSlots, indexedFiles) {
  const indexed = new Set(
    (Array.isArray(indexedFiles) ? indexedFiles : [])
      .map((entry) => normalizePath(entry?.relative_path))
      .filter(Boolean)
  )
  for (const slot of Array.isArray(referenceSlots) ? referenceSlots : []) {
    const path = referenceSlotPath(slot)
    if (path && !indexed.has(path)) return true
  }
  return false
}

export function characterEntriesFromIndex(indexedFiles, character) {
  const files = Array.isArray(indexedFiles) ? indexedFiles : []
  const members = Array.isArray(character?.members) ? character.members : []
  const wanted = new Set(members.map(normalizePath).filter(Boolean))
  const folder = normalizeFolder(character?.folder)

  for (const file of files) {
    const path = normalizePath(file?.relative_path)
    if (folder && path.startsWith(`${folder}/`)) wanted.add(path)
  }

  const byPath = new Map()
  for (const file of files) {
    const path = normalizePath(file?.relative_path)
    if (path) byPath.set(path, file)
  }
  return Array.from(wanted).map((path) => byPath.get(path)).filter(Boolean)
}
