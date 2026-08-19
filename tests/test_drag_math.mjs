import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cardIntentInsertionIndex,
  materializationNeedsLibraryRefresh,
  reorderSelectedItems
} from '../web/image_conveyor_drag_math.mjs'

const items = (...ids) => ids.map((id) => ({ id }))
const ids = (values) => values.map((item) => item.id)

test('moves a contiguous selection to the end while preserving order', () => {
  const source = items('a', 'b', 'c', 'd', 'e')
  const result = reorderSelectedItems(source, ['b', 'c'], 5)
  assert.equal(result.changed, true)
  assert.deepEqual(ids(result.items), ['a', 'd', 'e', 'b', 'c'])
})

test('moves a selection backward as one block', () => {
  const source = items('a', 'b', 'c', 'd', 'e')
  const result = reorderSelectedItems(source, ['d', 'e'], 1)
  assert.equal(result.changed, true)
  assert.deepEqual(ids(result.items), ['a', 'd', 'e', 'b', 'c'])
})

test('preserves source order for non-contiguous selected items', () => {
  const source = items('a', 'b', 'c', 'd', 'e')
  const result = reorderSelectedItems(source, ['a', 'c'], 5)
  assert.deepEqual(ids(result.items), ['b', 'd', 'e', 'a', 'c'])
})

test('inserting a selected block into its existing span is a no-op', () => {
  const source = items('a', 'b', 'c', 'd')
  const result = reorderSelectedItems(source, ['b', 'c'], 3)
  assert.equal(result.changed, false)
  assert.deepEqual(ids(result.items), ['a', 'b', 'c', 'd'])
})

test('returns unchanged results for empty, unknown, full, or non-array selections', () => {
  const source = items('a', 'b', 'c')
  assert.equal(reorderSelectedItems(source, [], 1).changed, false)
  assert.equal(reorderSelectedItems(source, ['z'], 1).changed, false)
  assert.equal(reorderSelectedItems(source, ['a', 'b', 'c'], 0).changed, false)
  assert.deepEqual(ids(reorderSelectedItems(null, ['a'], 0).items), [])
})

test('clamps negative and out-of-range insertion indexes', () => {
  const source = items('a', 'b', 'c')
  assert.deepEqual(ids(reorderSelectedItems(source, ['c'], -5).items), ['c', 'a', 'b'])
  assert.deepEqual(ids(reorderSelectedItems(source, ['a'], 99).items), ['b', 'c', 'a'])
})

test('card intent mirrors single-item forward/backward semantics', () => {
  const source = items('a', 'b', 'c', 'd')
  assert.equal(cardIntentInsertionIndex(source, 'b', 'd'), 4)
  assert.equal(cardIntentInsertionIndex(source, 'd', 'b'), 1)
})

test('card intent rejects identical or unknown ids', () => {
  const source = items('a', 'b')
  assert.equal(cardIntentInsertionIndex(source, 'a', 'a'), -1)
  assert.equal(cardIntentInsertionIndex(source, 'a', 'z'), -1)
  assert.equal(cardIntentInsertionIndex(source, 'z', 'a'), -1)
  assert.equal(cardIntentInsertionIndex(null, 'a', 'b'), -1)
})

test('reference-slot materialization does not refresh a library when no file moved', () => {
  assert.equal(materializationNeedsLibraryRefresh(null), false)
  assert.equal(materializationNeedsLibraryRefresh({ files: [] }), false)
  assert.equal(materializationNeedsLibraryRefresh({ moved: [] }), false)
  assert.equal(
    materializationNeedsLibraryRefresh({
      files: [{ relative_path: 'image_conveyor/characters/a/ref.png', moved: false, reused: true }],
      shared: [{ relative_path: 'image_conveyor/characters/a/ref.png', moved: false, reused: true }],
      moved: []
    }),
    false
  )
})

test('reference-slot materialization refreshes libraries after a physical relocation', () => {
  assert.equal(
    materializationNeedsLibraryRefresh({
      moved: [{ relative_path: 'old/ref.png', keep_path: 'image_conveyor/characters/a/ref.png' }]
    }),
    true
  )
})
