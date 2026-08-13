import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contextTargetIds,
  dragEdgeAutoscrollConfig,
  dragEdgeAutoscrollSpeed,
  jumpPendingItemsToFront,
  normalizeWheelDelta
} from '../web/image_conveyor_queue_qol_math.mjs'

function item(id, status) {
  return { id, status }
}

test('context target follows the active selection only when the clicked item belongs to it', () => {
  const items = [item('a', 'pending'), item('b', 'pending'), item('c', 'pending')]
  assert.deepEqual(contextTargetIds(items, new Set(['a', 'c']), 'c'), ['a', 'c'])
  assert.deepEqual(contextTargetIds(items, new Set(['a', 'c']), 'b'), ['b'])
})

test('queue jump inserts selected pending items at the earliest pending boundary', () => {
  const items = [
    item('done-1', 'processed'),
    item('done-2', 'processed'),
    item('a', 'pending'),
    item('b', 'pending'),
    item('c', 'pending')
  ]
  const result = jumpPendingItemsToFront(items, new Set(['b', 'c']), 'c')
  assert.equal(result.changed, true)
  assert.deepEqual(result.items.map((entry) => entry.id), ['done-1', 'done-2', 'b', 'c', 'a'])
  assert.deepEqual(result.movedIds, ['b', 'c'])
})

test('queue jump can precede later processed history when pending work already does', () => {
  const items = [
    item('done-1', 'processed'),
    item('a', 'pending'),
    item('done-2', 'processed'),
    item('b', 'pending')
  ]
  const result = jumpPendingItemsToFront(items, new Set(['b']), 'b')
  assert.deepEqual(result.items.map((entry) => entry.id), ['done-1', 'b', 'a', 'done-2'])
})

test('queue jump never crosses queued reservations and ignores non-pending selected items', () => {
  const items = [
    item('done', 'processed'),
    item('reserved', 'queued'),
    item('a', 'pending'),
    item('b', 'pending')
  ]
  const result = jumpPendingItemsToFront(items, new Set(['done', 'reserved', 'b']), 'b')
  assert.deepEqual(result.items.map((entry) => entry.id), ['done', 'reserved', 'b', 'a'])
  assert.deepEqual(result.movedIds, ['b'])
})

test('queue jump is a no-op when the requested pending items already lead pending work', () => {
  const items = [item('done', 'processed'), item('a', 'pending'), item('b', 'pending')]
  const result = jumpPendingItemsToFront(items, new Set(['a']), 'a')
  assert.equal(result.changed, false)
  assert.deepEqual(result.items.map((entry) => entry.id), ['done', 'a', 'b'])
})

test('wheel delta normalization handles pixel, line and page units', () => {
  assert.equal(normalizeWheelDelta(120, 0, 500), 120)
  assert.equal(normalizeWheelDelta(3, 1, 500), 96)
  assert.equal(normalizeWheelDelta(-1, 2, 500), -450)
})

test('drag edge autoscroll uses a smooth signed ramp with adaptive bounds', () => {
  const config = dragEdgeAutoscrollConfig(600)
  assert.equal(config.edgeSize, 108)
  assert.equal(config.maxSpeed, 1320)
  assert.equal(dragEdgeAutoscrollSpeed(300, 100, 700, config.edgeSize, config.maxSpeed), 0)
  assert.ok(dragEdgeAutoscrollSpeed(100, 100, 700, config.edgeSize, config.maxSpeed) < -1300)
  assert.ok(dragEdgeAutoscrollSpeed(700, 100, 700, config.edgeSize, config.maxSpeed) > 1300)
  assert.equal(dragEdgeAutoscrollSpeed(154, 100, 700, config.edgeSize, config.maxSpeed), -660)
})
