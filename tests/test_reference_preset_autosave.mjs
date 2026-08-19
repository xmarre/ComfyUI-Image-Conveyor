import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  referencePresetSaveKey,
  referencePresetStateSnapshot,
  shouldAutosaveReferencePreset
} from '../web/image_conveyor_reference_autosave_math.mjs'

const ref = (path) => ({
  annotated: `${path} [input]`,
  filename: path.split('/').at(-1),
  subfolder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  type: 'input'
})

const state = (presetId, slots, extra = {}) => ({
  active_reference_preset_id: presetId,
  reference_slots: slots,
  ...extra
})

test('same active preset autosaves only when reference slots change', () => {
  const before = referencePresetStateSnapshot(state('character-a', [ref('a/one.png')]))
  const unchanged = referencePresetStateSnapshot(state('character-a', [ref('a/one.png')], {
    items: [{ id: 'queue-change-only' }]
  }))
  const changed = referencePresetStateSnapshot(state('character-a', [ref('a/two.png')]))

  assert.equal(shouldAutosaveReferencePreset(before, unchanged), false)
  assert.equal(shouldAutosaveReferencePreset(before, changed), true)
})

test('loading or switching presets never becomes an autosave write', () => {
  const unsaved = referencePresetStateSnapshot(state('', [ref('loose.png')]))
  const characterA = referencePresetStateSnapshot(state('character-a', [ref('a/one.png')]))
  const characterB = referencePresetStateSnapshot(state('character-b', [ref('b/one.png')]))

  assert.equal(shouldAutosaveReferencePreset(null, characterA), false)
  assert.equal(shouldAutosaveReferencePreset(unsaved, characterA), false)
  assert.equal(shouldAutosaveReferencePreset(characterA, characterB), false)
})

test('slot clearing and reordering count as preset edits', () => {
  const before = referencePresetStateSnapshot(state('character-a', [
    ref('a/one.png'),
    ref('a/two.png')
  ]))
  const cleared = referencePresetStateSnapshot(state('character-a', [
    ref('a/one.png'),
    null
  ]))
  const reordered = referencePresetStateSnapshot(state('character-a', [
    ref('a/two.png'),
    ref('a/one.png')
  ]))

  assert.equal(shouldAutosaveReferencePreset(before, cleared), true)
  assert.equal(shouldAutosaveReferencePreset(before, reordered), true)
})

test('save identity is stable for normalized reference slots', () => {
  const first = referencePresetSaveKey('character-a', [ref('a/one.png'), null])
  const second = referencePresetSaveKey('character-a', [ref('a/one.png'), null])
  assert.equal(first, second)
  assert.equal(referencePresetSaveKey('', [ref('a/one.png')]), '')
})

test('autosave frontend persists presets without character-library migration or materialization', () => {
  const source = readFileSync(
    new URL('../web/image_conveyor_reference_autosave.js', import.meta.url),
    'utf8'
  )
  assert.match(source, /\/image-conveyor\/reference-presets\//)
  assert.match(source, /method: 'PUT'/)
  assert.match(source, /shouldAutosaveReferencePreset\(previous, current\)/)
  assert.equal(source.includes('/image-conveyor/character-folders/migrate'), false)
  assert.equal(source.includes('/materialize'), false)
})
