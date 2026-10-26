import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { undo } from '../src/index.js'

// A sortable gesture moves its own item over and over during dragover or
// touchmove and only records the semantic move with command(). ignoreNode tells
// the automatic recorder that those nodes' insertions and removals are not
// edits, so the gesture leaves no generic Edit entry beside the command's one.

const BOARD = '<!DOCTYPE html><html><head><title>Board</title></head><body>' +
  '<ul id="list">' +
  '<li class="card" data-id="card-1">Alpha</li>' +
  '<li class="card" data-id="card-2">Beta</li>' +
  '<li class="card" data-id="card-3">Gamma</li>' +
  '</ul>' +
  '</body></html>'

function board(opts = {}) {
  const dom = makeDom(BOARD)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const labels = (scope) => scope.history.map((entry) => entry.label)
const card = (doc, id) => doc.querySelector(`[data-id="${id}"]`)
const positions = (doc) => [...doc.querySelectorAll('#list > [data-id]')].map((el) => el.getAttribute('data-id'))
const draggedCard = (node) => node.nodeType === 1 && node.getAttribute('data-id') === 'card-1'

// One dragover step: put the card at `index` among its siblings.
function move(doc, id, index) {
  const list = doc.querySelector('#list')
  list.insertBefore(card(doc, id), list.children[index])
}

async function gesture(doc, indices) {
  for (const index of indices) {
    move(doc, 'card-1', index)
    await tick(5)
  }
}

test('a gesture over an ignored node leaves only its command entry', async () => {
  const { doc, scope } = board({ ignoreNode: draggedCard })
  await gesture(doc, [2, 0, 1])
  await tick(40)
  assert.deepEqual(labels(scope), [], "the gesture's own moves are not edits")

  const receipt = scope.command('Move card', () => { move(doc, 'card-1', 0) })

  assert.deepEqual(labels(scope), ['Move card'], 'history is exactly that one entry')
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].id, receipt.id)
  assert.deepEqual(positions(doc), ['card-1', 'card-2', 'card-3'])
  scope.stop()
})

test('a record that moves an ignored node and also inserts another node is kept', async () => {
  const { doc, scope } = board({ ignoreNode: draggedCard })
  const list = doc.querySelector('#list')
  const replacement = doc.createElement('li')
  replacement.className = 'card'
  replacement.setAttribute('data-id', 'card-4')
  replacement.textContent = 'Delta'

  list.replaceChild(replacement, card(doc, 'card-1'))
  await tick(40)

  assert.deepEqual(labels(scope), ['Edit'], 'the record also touches a node the caller does not ignore')
  assert.ok(card(doc, 'card-4'))
  scope.stop()
})

test('an unrelated edit during the same window keeps its own entry', async () => {
  const { doc, scope } = board({ ignoreNode: draggedCard })
  const other = card(doc, 'card-2')

  move(doc, 'card-1', 2)
  await tick(5)
  other.textContent = 'Beta edited'
  await tick(5)
  move(doc, 'card-1', 0)
  await tick(40)

  assert.deepEqual(labels(scope), ['Edit'])
  assert.deepEqual(positions(doc), ['card-1', 'card-2', 'card-3'])

  scope.undo()

  assert.equal(card(doc, 'card-2').textContent, 'Beta', 'the edit is undone')
  assert.deepEqual(positions(doc), ['card-1', 'card-2', 'card-3'], "the gesture's own moves were never part of the entry")
  scope.stop()
})

test('without ignoreNode the same gesture is recorded as before', async () => {
  const { doc, scope } = board()
  await gesture(doc, [2, 0, 1])
  await tick(40)
  assert.deepEqual(labels(scope), ['Edit'], 'nothing is ignored, so the moves are ordinary edits')
  scope.stop()
})

test('start() and create() forward the ignoreNode option', async () => {
  const startDom = makeDom(BOARD)
  const startDoc = startDom.window.document
  undo.start({ scope: startDoc.body, idleWindowMs: 20, bindKeys: false, ignoreNode: draggedCard })
  try {
    await gesture(startDoc, [2, 0])
    await tick(40)
    assert.deepEqual(undo.history, [], 'the singleton honors ignoreNode')
  } finally {
    undo.stop()
  }

  const createDom = makeDom(BOARD)
  const createDoc = createDom.window.document
  const scope = undo.create({ scope: createDoc.body, idleWindowMs: 20, ignoreNode: draggedCard })
  scope.start()
  try {
    await gesture(createDoc, [2, 0])
    await tick(40)
    assert.deepEqual(scope.history, [], 'create() honors ignoreNode')
  } finally {
    scope.stop()
  }
})
