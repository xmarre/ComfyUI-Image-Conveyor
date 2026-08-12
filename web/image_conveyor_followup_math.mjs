export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

export function normalizePath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return ''
  return parts.join('/')
}

export function parentPath(path) {
  const value = normalizePath(path)
  const index = value.lastIndexOf('/')
  return index < 0 ? '' : value.slice(0, index)
}

export function pathName(path) {
  const value = normalizePath(path)
  const index = value.lastIndexOf('/')
  return index < 0 ? value : value.slice(index + 1)
}

export function itemPath(item) {
  if (!item || item.kind === 'folder' || item.localFile) return ''
  const explicit = normalizePath(item.relative_path)
  if (explicit) return explicit
  const annotated = String(item.annotated ?? '')
  return normalizePath(annotated.replace(/ \[(input|output|temp)\]$/, ''))
}

export function itemId(item) {
  return String(item?.key ?? item?.relative_path ?? item?.id ?? '')
}

export function pathReference(path) {
  const normalized = normalizePath(path)
  if (!normalized) return null
  return {
    annotated: `${normalized} [input]`,
    filename: pathName(normalized),
    subfolder: parentPath(normalized),
    type: 'input'
  }
}

export function updatedEntry(entry, keepPath) {
  const next = { ...entry }
  next.relative_path = keepPath
  next.filename = pathName(keepPath)
  next.subfolder = parentPath(keepPath)
  if (next.annotated) next.annotated = `${keepPath} [input]`
  if (next.source_path) next.source_path = keepPath
  return next
}

export function dedupeEntries(entries) {
  const result = []
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind === 'folder') {
      result.push(entry)
      continue
    }
    const key = itemPath(entry) || itemId(entry)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(entry)
  }
  return result
}

export function buildRelocationMapping(entries) {
  const mapping = new Map()
  for (const entry of entries ?? []) {
    const oldPath = normalizePath(entry?.relative_path)
    const keepPath = normalizePath(entry?.keep_path)
    if (oldPath && keepPath && oldPath !== keepPath) mapping.set(oldPath, keepPath)
  }
  return mapping
}

export function indexLibraryEntries(entries, characterRoot = 'image_conveyor_characters') {
  const byParent = new Map()
  const byCharacterFolder = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind === 'folder') continue
    const path = itemPath(entry)
    if (!path) continue

    const parent = parentPath(path)
    let parentEntries = byParent.get(parent)
    if (!parentEntries) {
      parentEntries = []
      byParent.set(parent, parentEntries)
    }
    parentEntries.push(entry)

    const parts = path.split('/')
    if (parts.length >= 3 && parts[0] === characterRoot) {
      const folder = `${parts[0]}/${parts[1]}`
      let characterEntries = byCharacterFolder.get(folder)
      if (!characterEntries) {
        characterEntries = []
        byCharacterFolder.set(folder, characterEntries)
      }
      characterEntries.push(entry)
    }
  }
  return { byParent, byCharacterFolder }
}
