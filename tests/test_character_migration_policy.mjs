import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const followupSource = readFileSync(
  new URL('../web/image_conveyor_followup_fixes.js', import.meta.url),
  'utf8'
)
const interactionSource = readFileSync(
  new URL('../web/image_conveyor_interaction_guards.js', import.meta.url),
  'utf8'
)

test('normal frontend lifecycle never invokes whole-character-library migration', () => {
  assert.equal(
    followupSource.includes('/image-conveyor/character-folders/migrate'),
    false
  )
})

test('normal frontend lifecycle never materializes character slots from render or refresh hooks', () => {
  assert.equal(
    followupSource.includes('/image-conveyor/character-folders/${encodeURIComponent(presetId)}/materialize'),
    false
  )
})

test('followup lifecycle retains relocation synchronization for explicit file operations', () => {
  assert.match(followupSource, /void syncRelocations\(\)/)
})

test('character preset auto-load is installed before drag-specific readiness is required', () => {
  assert.match(
    interactionSource,
    /installPresetAutoLoad\(node, ctx\)\s*\n\s*const ext = ctx\.icx\s*\n\s*if \(!ext \|\| !ext\.batchWindowDrop\)/
  )
})

test('character preset auto-load owns cleanup independent of drag initialization', () => {
  assert.match(interactionSource, /presetAutoLoadHandlers\.set\(node, documentChange\)/)
  assert.match(interactionSource, /document\.removeEventListener\('change', documentChange, true\)/)
})
