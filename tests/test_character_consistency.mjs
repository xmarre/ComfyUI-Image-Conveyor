import assert from 'node:assert/strict'
import test from 'node:test'

import {
  referenceAutosaveTransition,
  referenceSlotSignature
} from '../web/image_conveyor_character_consistency_math.mjs'

function ref(path) {
  const parts = path.split('/')
  return {
    annotated: `${path} [input]`,
    filename: parts.at(-1),
    subfolder: parts.slice(0, -1).join('/'),
    type: 'input'
  }
}

function snapshot(presetId, slots) {
  return {
    presetId,
    slots,
    signature: referenceSlotSignature(slots)
  }
}

test('reference autosave only triggers for slot changes within the same active preset', () => {
  const before = snapshot('preset-a', [ref('characters/a.png')])
  const after = snapshot('preset-a', [ref('characters/b.png')])
  const transition = referenceAutosaveTransition(before, after)
  assert.equal(transition?.presetId, 'preset-a')
  assert.equal(transition?.signature, after.signature)
  assert.equal(transition?.slots[0]?.annotated, 'characters/b.png [input]')
})

test('reference autosave ignores preset switches and unrelated state rewrites', () => {
  const slots = [ref('characters/a.png')]
  assert.equal(
    referenceAutosaveTransition(snapshot('preset-a', slots), snapshot('preset-b', slots)),
    null
  )
  assert.equal(
    referenceAutosaveTransition(snapshot('preset-a', slots), snapshot('preset-a', slots)),
    null
  )
})

test('reference autosave ignores unsaved shelves without an active preset', () => {
  const before = snapshot('', [])
  const after = snapshot('', [ref('characters/a.png')])
  assert.equal(referenceAutosaveTransition(before, after), null)
})
