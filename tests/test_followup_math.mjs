import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRelocationMapping,
  dedupeEntries,
  indexLibraryEntries,
  itemPath,
  normalizePath,
  pathReference,
  updatedEntry
} from '../web/image_conveyor_followup_math.mjs'

test('normalizePath accepts relative input paths and rejects traversal or absolute paths', () => {
  assert.equal(normalizePath('folder\\image.png'), 'folder/image.png')
  assert.equal(normalizePath('../image.png'), '')
  assert.equal(normalizePath('folder/../image.png'), '')
  assert.equal(normalizePath('/tmp/image.png'), '')
  assert.equal(normalizePath('C:\\tmp\\image.png'), '')
})

test('itemPath resolves explicit and annotated input paths', () => {
  assert.equal(itemPath({ relative_path: 'a/b.png' }), 'a/b.png')
  assert.equal(itemPath({ annotated: 'refs/a.png [input]' }), 'refs/a.png')
  assert.equal(itemPath({ kind: 'folder', relative_path: 'refs' }), '')
})

test('dedupeEntries keeps folders and removes duplicate physical image paths', () => {
  const folder = { kind: 'folder', key: 'folder:refs' }
  const first = { relative_path: 'refs/a.png' }
  const duplicate = { relative_path: 'refs/a.png' }
  assert.deepEqual(dedupeEntries([folder, first, duplicate]), [folder, first])
})

test('relocation mappings keep the latest valid mapping and ignore no-ops', () => {
  const mapping = buildRelocationMapping([
    { relative_path: 'a.png', keep_path: 'dest/a.png' },
    { relative_path: 'a.png', keep_path: 'dest/final.png' },
    { relative_path: 'same.png', keep_path: 'same.png' },
    { relative_path: '../bad.png', keep_path: 'dest/bad.png' }
  ])
  assert.equal(mapping.size, 1)
  assert.equal(mapping.get('a.png'), 'dest/final.png')
})

test('updatedEntry and pathReference rewrite all path metadata consistently', () => {
  const updated = updatedEntry({
    relative_path: 'old/a.png',
    filename: 'a.png',
    subfolder: 'old',
    annotated: 'old/a.png [input]',
    source_path: 'old/a.png'
  }, 'character/a.png')
  assert.equal(updated.relative_path, 'character/a.png')
  assert.equal(updated.filename, 'a.png')
  assert.equal(updated.subfolder, 'character')
  assert.equal(updated.annotated, 'character/a.png [input]')
  assert.equal(updated.source_path, 'character/a.png')
  assert.deepEqual(pathReference('character/a.png'), {
    annotated: 'character/a.png [input]',
    filename: 'a.png',
    subfolder: 'character',
    type: 'input'
  })
})

test('indexLibraryEntries builds direct-folder and managed-character indexes in one pass', () => {
  const root = { relative_path: 'root.png' }
  const nested = { relative_path: 'folder/a.png' }
  const character = { relative_path: 'image_conveyor_characters/Mara--12345678/a.png' }
  const nestedCharacter = { relative_path: 'image_conveyor_characters/Mara--12345678/poses/b.png' }
  const indexes = indexLibraryEntries([root, nested, character, nestedCharacter])
  assert.deepEqual(indexes.byParent.get(''), [root])
  assert.deepEqual(indexes.byParent.get('folder'), [nested])
  assert.deepEqual(indexes.byCharacterFolder.get('image_conveyor_characters/Mara--12345678'), [character, nestedCharacter])
})
