import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'

// A refused entry must stay reviewable after reload (Kanban 08 Step 6): the
// recovery store accepts only serializable values, and the entry itself holds
// live DOM nodes. describe(entryId) is the plain-data projection of one entry,
// built from its certificate alone.

function board(html, opts = {}) {
  const dom = makeDom(`<!DOCTYPE html><html><head><title>Board</title></head><body>${html}</body></html>`)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const bytes = (doc) => doc.body.outerHTML

// Every value must be a string, number, boolean, null, or a plain array/object
// of those: a Node, function or Map here is exactly what the recovery store
// cannot hold.
function assertSerializable(value, path = 'd') {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSerializable(item, `${path}[${i}]`))
    return
  }
  if (type === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertSerializable(item, `${path}.${key}`)
    return
  }
  throw new Error(`${path} is not serializable: ${Object.prototype.toString.call(value)}`)
}

function describeOnly(scope, doc, expectedSteps) {
  const [entry] = scope.history
  const described = scope.describe(entry.id)
  assert.deepEqual(described, {
    id: entry.id,
    label: entry.label,
    timestamp: entry.timestamp,
    refused: null,
    steps: expectedSteps,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described)
  assertSerializable(described)
  assert.equal(bytes(doc), bytes(doc))
  return described
}

test('a text edit describes its target and both endpoints', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => { card.firstChild.data = 'Alpha local' })
  describeOnly(scope, doc, [
    { kind: 'text', target: { id: 'card-1' }, before: 'Alpha', after: 'Alpha local' },
  ])
})

test('an attribute edit describes its name and both endpoints', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1" title="hover">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Retitle card', () => { card.setAttribute('title', 'local') })
  describeOnly(scope, doc, [
    { kind: 'attribute', target: { id: 'card-1' }, name: 'title', before: 'hover', after: 'local' },
  ])
})

test('an added attribute describes a null before value', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Mark card', () => { card.setAttribute('data-x', 'one') })
  describeOnly(scope, doc, [
    { kind: 'attribute', target: { id: 'card-1' }, name: 'data-x', before: null, after: 'one' },
  ])
})

test('a recordValue step describes its property and both endpoints', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Set card title', () => {
    scope.recordValue(card, { prop: 'title', oldValue: 'Alpha', newValue: 'Alpha local' })
  })
  describeOnly(scope, doc, [
    { kind: 'value', target: { id: 'card-1' }, prop: 'title', before: 'Alpha', after: 'Alpha local' },
  ])
})

test('an add describes its parent, the node id and the durable html', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('[data-id="list"]')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })
  describeOnly(scope, doc, [
    { kind: 'add', parent: { id: 'list' }, nodes: [{ id: 'card-2', html: '<li data-id="card-2">#text:"Beta"</>' }] },
  ])
})

test('a remove describes its parent, the node id and the durable html', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('[data-id="list"]')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Remove card', () => { list.removeChild(card) })
  describeOnly(scope, doc, [
    { kind: 'remove', parent: { id: 'list' }, nodes: [{ id: 'card-1', html: '<li data-id="card-1">#text:"Alpha"</>' }] },
  ])
})

test('a move describes the node and both ends of its journey', () => {
  const { doc, scope } = board(
    '<ul data-id="list"><li data-id="card-1">Alpha</li><li data-id="card-3">Gamma</li></ul>' +
    '<ul data-id="other"><li data-id="card-9">Iota</li></ul>'
  )
  const list = doc.querySelector('[data-id="list"]')
  const other = doc.querySelector('[data-id="other"]')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Move card', () => {
    list.removeChild(card)
    other.appendChild(card)
  })
  describeOnly(scope, doc, [
    { kind: 'move', node: { id: 'card-1' }, from: { id: 'list' }, to: { id: 'other' } },
  ])
})

test('a refused redo of a replaced text node names the element that carried it', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="c1"><h3 class="card-title">Title</h3></li></ul>')
  const title = doc.querySelector('.card-title')
  scope.commit('Rename card', () => { title.textContent = 'Mine' })
  const [entry] = scope.history
  assert.equal(scope.undo()?.ok, true)

  scope.pause()
  try { title.firstChild.data = 'Theirs' } finally { scope.resume() }

  const seen = []
  const off = scope.on('refused', (payload) => seen.push(payload))
  const receipt = scope.redo()
  off()

  assert.equal(receipt.ok, false)
  assert.deepEqual(seen[0].targets, [{ id: 'c1', kind: 'removed' }], 'a detached text node is described by the element it was removed from')
  assert.deepEqual(scope.describe(entry.id).refused.targets, [{ id: 'c1', kind: 'removed' }])
})

test('a refused entry carries its direction, code and targets', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('[data-id="list"]')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })
  const [entry] = scope.history
  const added = doc.querySelector('[data-id="card-2"]')
  scope.pause()
  try { added.firstChild.data = 'Peer text' } finally { scope.resume() }

  const receipt = scope.undo()
  assert.equal(receipt.ok, false)
  assert.equal(receipt.code, 'content-changed')

  const described = scope.describe(entry.id)
  assert.deepEqual(described.refused, {
    direction: 'undo',
    code: 'content-changed',
    targets: [{ id: 'card-2', kind: 'added' }],
  })
  assert.deepEqual(described, JSON.parse(JSON.stringify(described)))
  assertSerializable(described)
})

test('an entry in future is found after an undo', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => { card.firstChild.data = 'Alpha local' })
  const [entry] = scope.history
  const whileInHistory = scope.describe(entry.id)
  assert.equal(scope.undo().ok, true)
  assert.deepEqual(scope.future.map((e) => e.id), [entry.id])
  assert.deepEqual(scope.describe(entry.id), whileInHistory)
  assert.equal(scope.describe(entry.id).refused, null)
})

test('an unknown id describes as null', () => {
  const { scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul>')
  const card = document.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => { card.firstChild.data = 'Alpha local' })
  assert.equal(scope.describe('no-such-entry'), null)
  assert.equal(scope.describe(undefined), null)
})

test('describing changes neither stack nor the document', () => {
  const { doc, scope } = board('<ul data-id="list"><li data-id="card-1">Alpha</li></ul><p data-id="note">Note</p>')
  const card = doc.querySelector('[data-id="card-1"]')
  const note = doc.querySelector('[data-id="note"]')
  scope.commit('Edit card', () => { card.firstChild.data = 'Alpha local' })
  scope.commit('Edit note', () => { note.firstChild.data = 'Note local' })
  const firstId = scope.history[0].id
  assert.equal(scope.undo().ok, true)

  const before = {
    history: JSON.stringify(scope.history),
    future: JSON.stringify(scope.future),
    body: bytes(doc),
  }
  scope.describe(firstId)
  scope.describe(scope.history[0].id)
  const after = {
    history: JSON.stringify(scope.history),
    future: JSON.stringify(scope.future),
    body: bytes(doc),
  }
  assert.deepEqual(after, before)
  assert.deepEqual(scope.history.map((e) => e.id), [firstId])
  assert.equal(scope.history.length + scope.future.length, 2)
})

test('the serializable check rejects a step that returns a node', () => {
  const { doc } = board('<ul data-id="list"></ul>')
  const leaked = {
    id: 'entry',
    label: 'Add card',
    timestamp: 1,
    refused: null,
    steps: [{ kind: 'add', parent: { id: 'list' }, nodes: [{ id: 'card-2', html: doc.querySelector('[data-id="list"]') }] }],
  }
  assert.throws(() => assertSerializable(leaked), /html is not serializable/)
})
