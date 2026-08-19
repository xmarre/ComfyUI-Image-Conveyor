import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { characterFolderReadinessAction } from '../web/image_conveyor_character_folder_readiness_math.mjs'

test('character folder readiness only refreshes an uninitialized idle input index', () => {
  assert.equal(characterFolderReadinessAction({ loaded: false, loading: false, refreshStarted: false }), 'refresh')
  assert.equal(characterFolderReadinessAction({ loaded: false, loading: true, refreshStarted: false }), 'wait')
  assert.equal(characterFolderReadinessAction({ loaded: false, loading: false, refreshStarted: true }), 'error')
  assert.equal(characterFolderReadinessAction({ loaded: true, loading: false, refreshStarted: true }), 'ready')
  assert.equal(characterFolderReadinessAction({ loaded: true, loading: true, refreshStarted: true }), 'wait')
})

test('Folder waits for the shared input index before delegating to the existing character handler', () => {
  const source = readFileSync(
    new URL('../web/image_conveyor_character_folder_readiness.js', import.meta.url),
    'utf8'
  )

  const wrapperStart = source.indexOf('node.onMouseDown = function')
  const readyCall = source.indexOf('ensureCharacterFolderInputReady(node, controller)', wrapperStart)
  const delegateCall = source.indexOf('previousMouseDown?.call(node, event, localPosition, graphCanvas)', wrapperStart)

  assert.ok(wrapperStart >= 0)
  assert.ok(readyCall > wrapperStart)
  assert.ok(delegateCall > readyCall)
  assert.match(source, /loaded: Boolean\(ctx\.browser\.input\.loaded\)/)
  assert.match(source, /loading: Boolean\(ctx\.browser\.input\.loading\)/)
  assert.match(source, /ctx\.refreshBtn\.click\(\)/)
  assert.match(source, /syncSharedInputIndex\(ctx\)/)
  assert.match(source, /ext\.allFiles = Array\.isArray\(current\)/)
  assert.match(source, /ext\.characterRevision = -1/)
})

test('character folder readiness is read-only with respect to character migration/materialization', () => {
  const source = readFileSync(
    new URL('../web/image_conveyor_character_folder_readiness.js', import.meta.url),
    'utf8'
  )

  assert.equal(source.includes('/image-conveyor/character-folders/migrate'), false)
  assert.equal(source.includes('/materialize'), false)
  assert.equal(source.includes('/character-folders/'), false)
})
