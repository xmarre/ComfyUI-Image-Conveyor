import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  characterEntriesFromIndex,
  characterReferenceIndexNeedsRefresh,
  referenceSlotPath
} from '../web/image_conveyor_character_materialization_sync_math.mjs'

const syncSource = readFileSync(
  new URL('../web/image_conveyor_character_materialization_sync.js', import.meta.url),
  'utf8'
)

const ref = (path) => ({
  annotated: `${path} [input]`,
  filename: path.split('/').at(-1),
  subfolder: path.split('/').slice(0, -1).join('/'),
  type: 'input'
})
const file = (path) => ({ relative_path: path, filename: path.split('/').at(-1), type: 'input' })

test('reference slot paths normalize annotated Input references', () => {
  assert.equal(referenceSlotPath(ref('image_conveyor/characters/alice/a.png')), 'image_conveyor/characters/alice/a.png')
  assert.equal(referenceSlotPath({ annotated: 'x.png [output]', type: 'output' }), '')
  assert.equal(referenceSlotPath(null), '')
})

test('new character uploads force an Input-index refresh when their paths are absent', () => {
  const slots = [ref('image_conveyor/characters/alice/new.png')]
  const indexed = [file('existing.png')]
  assert.equal(characterReferenceIndexNeedsRefresh(slots, indexed), true)
})

test('already indexed shared canonical references do not force an Input rescan', () => {
  const shared = 'image_conveyor/characters/bob/shared.png'
  assert.equal(characterReferenceIndexNeedsRefresh([ref(shared)], [file(shared)]), false)
})

test('character entries combine physical folder contents with authoritative shared members', () => {
  const physical = 'image_conveyor/characters/alice/local.png'
  const shared = 'image_conveyor/characters/bob/shared.png'
  const unrelated = 'other/unrelated.png'
  const entries = characterEntriesFromIndex(
    [file(physical), file(shared), file(unrelated)],
    {
      preset_id: 'alice',
      folder: 'image_conveyor/characters/alice',
      members: [shared]
    }
  )
  assert.deepEqual(entries.map((entry) => entry.relative_path), [shared, physical])
})

test('character entries omit registry members missing from the current file index', () => {
  const entries = characterEntriesFromIndex(
    [file('image_conveyor/characters/alice/local.png')],
    {
      preset_id: 'alice',
      folder: 'image_conveyor/characters/alice',
      members: ['missing.png']
    }
  )
  assert.deepEqual(entries.map((entry) => entry.relative_path), ['image_conveyor/characters/alice/local.png'])
})

test('materialization sync avoids duplicate refreshes and never invokes migration/materialization itself', () => {
  assert.match(syncSource, /inputRequestBefore/)
  assert.match(syncSource, /inputRequestId/)
  assert.match(syncSource, /characterReferenceIndexNeedsRefresh\(slots, ctx\.icx\.allFiles\)/)
  assert.match(syncSource, /ctx\.refreshBtn\?\.click\?\.\(\)/)
  assert.match(syncSource, /api\.fetchApi\('\/image-conveyor\/character-folders'\)/)
  assert.equal(syncSource.includes('/character-folders/migrate'), false)
  assert.equal(syncSource.includes('/materialize'), false)
})

test('character reconciliation waits for an in-flight Input refresh before rebuilding entries', () => {
  assert.match(syncSource, /if \(ctx\.browser\?\.input\?\.loading\)/)
  assert.match(syncSource, /characterEntriesFromIndex\(ctx\.icx\.allFiles, character\)/)
})

test('fallback Input refresh preserves the active library scroll state', () => {
  assert.match(syncSource, /libraryRefreshScrollRestore\(/)
  assert.match(syncSource, /ctx\.pendingScrollRestore = restore/)
  assert.match(syncSource, /refreshInputPreservingView\(node\)/)
})

test('successful character materialization invalidates the private character metadata cache', () => {
  assert.match(syncSource, /ctx\.icx\.presetSignature = null/)
  assert.match(syncSource, /requestCharacterCacheRefresh\(node\)/)
})
