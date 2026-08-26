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
  const presetInstallIndex = interactionSource.indexOf('\n  installPresetAutoLoad(node, ctx)\n')
  const dragReadinessIndex = interactionSource.indexOf(
    '\n  const ext = ctx.icx\n  if (!ext || !ext.batchWindowDrop)',
    presetInstallIndex
  )

  assert.notEqual(presetInstallIndex, -1)
  assert.ok(dragReadinessIndex > presetInstallIndex)
})

test('character preset auto-load owns cleanup independent of drag initialization', () => {
  assert.match(interactionSource, /presetAutoLoadHandlers\.set\(node, documentChange\)/)
  assert.match(interactionSource, /document\.removeEventListener\('change', documentChange, true\)/)
})

test('closed preview is not exposed as an active ARIA modal', () => {
  assert.match(
    interactionSource,
    /if \(root\.hidden\) root\.removeAttribute\('aria-modal'\)/
  )
  assert.match(
    interactionSource,
    /else root\.setAttribute\('aria-modal', 'true'\)/
  )
  assert.match(
    interactionSource,
    /observer\.observe\(root, \{ attributes: true, attributeFilter: \['hidden'\] \}\)/
  )
})
