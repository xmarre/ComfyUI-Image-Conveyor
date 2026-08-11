import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cardIntentInsertionIndex,
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

test('card intent mirrors single-item forward/backward semantics', () => {
  const source = items('a', 'b', 'c', 'd')
  assert.equal(cardIntentInsertionIndex(source, 'b', 'd'), 4)
  assert.equal(cardIntentInsertionIndex(source, 'd', 'b'), 1)
})
