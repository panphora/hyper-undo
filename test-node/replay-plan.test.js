import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick, nextCommit } from './_setup.js'
import { createScope } from '../src/scope.js'
import { compileCertificate, preflight } from '../src/replay-plan.js'
import { normalizePrimitives } from '../src/primitives.js'

// Whole-entry certificates and symmetric atomic preflight (Kanban 08 Step 2).
// Each case drives the real scope: the certificate is compiled when the entry
// closes, and undo/redo either apply every operation or leave the document and
// both stacks exactly as they were.

function board(html, opts = {}) {
  const dom = makeDom(`<!DOCTYPE html><html><head><title>Board</title></head><body>${html}</body></html>`)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const bytes = (doc) => doc.body.outerHTML
const ids = (scope) => scope.history.map((entry) => entry.id)

function peer(scope, fn) {
  scope.pause()
  try { fn() } finally { scope.resume() }
}

test('scalar edits: undo restores the entry start and redo restores its end', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" title="hover">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  const start = bytes(doc)
  scope.commit('Edit card', () => {
    card.setAttribute('data-title', 'Local title')
    card.removeAttribute('title')
    card.firstChild.data = 'Local text'
  })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(bytes(doc), start)
  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
})

test('value writes: undo and redo move the property both ways', async () => {
  const { doc, scope } = board('<input id="field" value="A">')
  const field = doc.getElementById('field')
  field.value = 'AB'
  scope.recordValue(field, { oldValue: 'A', newValue: 'AB' })
  await nextCommit(scope)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(field.value, 'A')
  assert.equal(scope.redo()?.ok, true)
  assert.equal(field.value, 'AB')
})

test('an added subtree is removed on undo and re-inserted at its recorded slot on redo', () => {
  const { doc, scope } = board('<ul id="list"><li data-id="card-1">Alpha</li><li data-id="card-3">Gamma</li></ul>')
  const list = doc.getElementById('list')
  const start = bytes(doc)
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.insertBefore(card, doc.querySelector('[data-id="card-3"]'))
  })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(bytes(doc), start)
  assert.equal(list.children.length, 2)

  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
  assert.equal(list.children[1].getAttribute('data-id'), 'card-2', 'redo re-inserts between its neighbours, not at the end')
})

test('a deleted subtree is restored by identity at its exact slot, then removed again', () => {
  const { doc, scope } = board('<ul id="list"><li data-id="card-1">Alpha</li><li data-id="card-2">Beta</li><li data-id="card-3">Gamma</li></ul>')
  const list = doc.getElementById('list')
  const card2 = doc.querySelector('[data-id="card-2"]')
  const start = bytes(doc)
  scope.commit('Delete card', () => { card2.remove() })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(bytes(doc), start)
  assert.equal(doc.querySelector('[data-id="card-2"]'), card2, 'the restored node is the same live node')

  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
  assert.equal(card2.parentNode, null)
})

test('a move between lists: undo returns the same node, redo moves it back', () => {
  const { doc, scope } = board('<ul id="todo" data-id="todo"><li data-id="card-1">Alpha</li></ul><ul id="done" data-id="done"><li data-id="card-2">Beta</li></ul>')
  const todo = doc.getElementById('todo')
  const done = doc.getElementById('done')
  const card = doc.querySelector('[data-id="card-1"]')
  const start = bytes(doc)
  scope.commit('Move card', () => { done.appendChild(card) })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(bytes(doc), start)
  assert.equal(card.parentNode, todo)
  assert.equal(doc.querySelector('[data-id="card-1"]'), card, 'the move is reversed on the current node')

  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
  assert.equal(card.parentNode, done)
})

test('a reorder within one list: undo returns the card to its slot, redo moves it again', () => {
  const { doc, scope } = board('<ul id="todo" data-id="todo"><li data-id="card-1">Alpha</li><li data-id="card-2">Beta</li><li data-id="card-3">Gamma</li></ul>')
  const todo = doc.getElementById('todo')
  const card = doc.querySelector('[data-id="card-3"]')
  const start = bytes(doc)
  scope.commit('Move card', () => { todo.insertBefore(card, todo.firstElementChild) })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true)
  assert.equal(bytes(doc), start)
  assert.equal(todo.lastElementChild, card)

  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
  assert.equal(todo.firstElementChild, card)
})

test('a peer edit on the moved card survives a safe move undo', () => {
  const { doc, scope } = board('<ul id="todo"><li data-id="card-1" data-title="Alpha">Alpha</li></ul><ul id="done"></ul>')
  const todo = doc.getElementById('todo')
  const done = doc.getElementById('done')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Move card', () => { done.appendChild(card) })

  peer(scope, () => {
    card.setAttribute('data-title', 'Peer retitled')
    card.firstChild.data = 'Peer text'
  })

  assert.equal(scope.undo()?.ok, true)
  assert.equal(card.parentNode, todo, 'the move itself is still reversible')
  assert.equal(card.getAttribute('data-title'), 'Peer retitled', 'and the peer change rides along on the same node')
  assert.equal(card.firstChild.data, 'Peer text')
})

test('a batch add whose child a peer edited refuses the whole removal', () => {
  const { doc, scope } = board('<ul id="list"></ul>')
  const list = doc.getElementById('list')
  const cards = []
  scope.commit('Add cards', () => {
    for (const id of ['card-1', 'card-2', 'card-3']) {
      const card = doc.createElement('li')
      card.setAttribute('data-id', id)
      card.textContent = id
      list.appendChild(card)
      cards.push(card)
    }
  })
  const entryId = ids(scope).at(-1)
  peer(scope, () => { cards[1].firstChild.data = 'Peer text' })

  const before = bytes(doc)
  const result = scope.undo()

  assert.equal(result?.ok, false, 'one conflicting child refuses the whole batch')
  assert.equal(result.code, 'content-changed')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before, 'no card is removed, so the peer text stays')
  assert.deepEqual(ids(scope), [entryId])
})

test('restoring a deleted list refuses when a nested ID is live again elsewhere', () => {
  const { doc, scope } = board('<ul id="boards"><li data-id="list-b"><span data-id="card-5">Five</span></li></ul><ul id="other"></ul>')
  const listB = doc.querySelector('[data-id="list-b"]')
  const card5 = doc.querySelector('[data-id="card-5"]')
  scope.commit('Delete list', () => { listB.remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => {
    const duplicate = doc.createElement('span')
    duplicate.setAttribute('data-id', 'card-5')
    duplicate.textContent = 'Peer copy'
    doc.getElementById('other').appendChild(duplicate)
  })

  const before = bytes(doc)
  const result = scope.undo()

  assert.equal(result?.ok, false)
  assert.equal(result.code, 'duplicate-id', 'a nested identity that is live again refuses the restore')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before)
  assert.equal(doc.querySelectorAll('[data-id="card-5"]').length, 1)
  assert.equal(card5.parentNode, listB, 'the retained subtree stays detached')
})

test('a peer renaming another child does not block undoing a delete', () => {
  const { doc, scope } = board('<ul id="list"><li data-id="card-1" data-title="Alpha">Alpha</li><li data-id="card-2">Beta</li></ul>')
  const card1 = doc.querySelector('[data-id="card-1"]')
  const list = doc.getElementById('list')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })

  peer(scope, () => { card1.setAttribute('data-title', 'Peer title') })

  assert.equal(scope.undo()?.ok, true, 'a scalar edit to a sibling is not structural drift')
  assert.equal(card1.getAttribute('data-title'), 'Peer title')
  assert.equal(list.children.length, 2)
})

test('a peer change to another field on the same card does not block a scalar undo', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" data-due="2026-01-01">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local title') })

  peer(scope, () => { card.setAttribute('data-due', '2026-05-05') })

  assert.equal(scope.undo()?.ok, true)
  assert.equal(card.getAttribute('data-title'), 'Alpha')
  assert.equal(card.getAttribute('data-due'), '2026-05-05', 'the untouched peer field is left alone')
})

test('structural sequence drift refuses the entry and keeps both stacks', () => {
  const { doc, scope } = board('<ul id="list"><li data-id="card-1">Alpha</li><li data-id="card-2">Beta</li></ul>')
  const list = doc.getElementById('list')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => {
    const inserted = doc.createElement('li')
    inserted.setAttribute('data-id', 'card-peer')
    inserted.textContent = 'Peer card'
    list.appendChild(inserted)
  })

  const before = bytes(doc)
  const result = scope.undo()

  assert.equal(result?.ok, false)
  assert.equal(result.code, 'structure-changed')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), [entryId])
  assert.equal(scope.canRedo, false)
})

test('a refused entry reports itself on the refused event without DOM nodes', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  const entryId = ids(scope).at(-1)
  peer(scope, () => { card.setAttribute('data-title', 'Peer title') })

  const seen = []
  const off = scope.on('refused', (payload) => seen.push(payload))
  scope.undo()
  off()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].entryId, entryId)
  assert.equal(seen[0].label, 'Rename card')
  assert.equal(seen[0].direction, 'undo')
  assert.equal(typeof seen[0].code, 'string')
  assert.ok(Array.isArray(seen[0].targets))
  for (const target of seen[0].targets) {
    assert.equal(target.nodeType, undefined, 'refusal targets carry no DOM nodes')
    assert.equal(target.id, 'card-1')
  }
  assert.deepEqual(scope.history.at(-1).refused.code, seen[0].code, 'history carries the refusal metadata')
})

test('unsupported atomic validation retains the entry for recovery and dismissal', () => {
  const { doc, scope } = board('<div id="x">A</div>')
  const target = doc.getElementById('x')
  const write = (el, value) => { el.textContent = value }
  scope.commit('Custom write', () => {
    write(target, 'B')
    scope.recordValue(target, { prop: 'textContent', oldValue: 'A', newValue: 'B', write })
  })
  const entryId = ids(scope).at(-1)
  const before = bytes(doc)

  const result = scope.undo()
  assert.equal(result?.ok, false)
  assert.equal(result.code, 'unsupported', 'a write callback with no side-effect-free read cannot be validated')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), [entryId], 'the entry stays on the stack, not silently skipped')

  const older = scope.discard(entryId)
  assert.equal(older.ok, true)
  assert.equal(scope.canUndo, false)
  assert.equal(bytes(doc), before, 'dismissal never edits the document')
})

test('an ambiguous certificate is not replayable and keeps its material', () => {
  const certificate = compileCertificate([{ kind: 'add', parent: {}, nodes: [{}] }])
  assert.equal(certificate.replayable, false)
  assert.equal(certificate.reason, 'non-dom-parent')
  assert.deepEqual(preflight(certificate, 'undo'), { ok: false, code: 'unsupported', targets: [] })
})

test('a failure in the second operation rolls the first one back', () => {
  const { doc, scope } = board('<div id="title" data-v="Alpha"></div><div id="due" data-v="2026-01-01"></div>')
  const title = doc.getElementById('title')
  const due = doc.getElementById('due')
  scope.commit('Edit card', () => {
    title.setAttribute('data-v', 'Local title')
    due.setAttribute('data-v', '2026-02-02')
  })
  const entryId = ids(scope).at(-1)

  due.setAttribute = () => { throw new Error('boom') }   // the second operation of the undo
  const result = scope.undo()

  assert.equal(result?.ok, false)
  assert.equal(result.code, 'replay-error')
  assert.equal(result.entryId, entryId)
  assert.equal(title.getAttribute('data-v'), 'Local title', 'the first operation is rolled back')
  assert.equal(scope.canUndo, true)
  assert.equal(scope.canRedo, false)
})

test('repeated writes across observer deliveries normalize to one entry with the first old value', async () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>', { idleWindowMs: 200 })
  const card = doc.querySelector('[data-id="card-1"]')
  const committed = nextCommit(scope, 2000)

  card.setAttribute('data-title', 'Second')
  await tick(30)
  card.setAttribute('data-title', 'Third')
  await tick(30)
  card.setAttribute('data-title', 'Fourth')
  await tick(30)

  assert.equal(await committed, true)
  assert.equal(scope.history.length, 1)
  assert.equal(scope.undo()?.ok, true)
  assert.equal(card.getAttribute('data-title'), 'Alpha')
})

test('normalizePrimitives keeps one endpoint pair per field and drops net no-ops', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="x" data-v="a"></div></body>')
  const el = dom.window.document.getElementById('x')
  const normalized = normalizePrimitives([
    { kind: 'attr-set', target: el, name: 'data-v', oldValue: 'a', newValue: 'b' },
    { kind: 'text', target: el, oldValue: null, newValue: null },
    { kind: 'attr-set', target: el, name: 'data-v', oldValue: 'b', newValue: 'a' },
    { kind: 'attr-add', target: el, name: 'data-new', newValue: 'v' },
  ])
  assert.equal(normalized.length, 1, 'the no-op pair is dropped and the untouched add survives')
  assert.equal(normalized[0].kind, 'attr-add')
  assert.equal(normalized[0].name, 'data-new')
})

test('redo of a multi-node add keeps the recorded order and the next undo succeeds', () => {
  const { doc, scope } = board('<ul id="list"></ul>', { recording: 'commands' })
  const list = doc.getElementById('list')
  scope.command('Add cards', () => {
    const fragment = doc.createDocumentFragment()
    for (const id of ['card-1', 'card-2', 'card-3']) {
      const card = doc.createElement('li')
      card.setAttribute('data-id', id)
      card.textContent = id
      fragment.appendChild(card)
    }
    list.appendChild(fragment)
  })
  const end = bytes(doc)
  assert.equal(list.children.length, 3, 'one record, three added nodes')

  assert.equal(scope.undo()?.ok, true)
  assert.equal(list.children.length, 0)

  assert.equal(scope.redo()?.ok, true)
  assert.equal(bytes(doc), end)
  assert.deepEqual([...list.children].map((child) => child.getAttribute('data-id')), ['card-1', 'card-2', 'card-3'], 'redo re-inserts the batch in its recorded order')
  assert.equal(scope.undo()?.ok, true, 'and the order redo wrote is the order undo recorded')
  assert.equal(list.children.length, 0)
})

test('redo of an add refuses when a peer node already carries the added durable id', () => {
  const { doc, scope } = board('<ul id="a"></ul><ul id="b"></ul>', { recording: 'commands' })
  const listA = doc.getElementById('a')
  scope.command('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-1')
    card.textContent = 'original'
    listA.appendChild(card)
  })
  const entryId = ids(scope).at(-1)
  assert.equal(scope.undo()?.ok, true)

  peer(scope, () => {
    const duplicate = doc.createElement('li')
    duplicate.setAttribute('data-id', 'card-1')
    duplicate.textContent = 'peer'
    doc.getElementById('b').appendChild(duplicate)
  })

  const before = bytes(doc)
  const result = scope.redo()

  assert.equal(result?.ok, false, 'redo may not create a second live node with one durable id')
  assert.equal(result.code, 'duplicate-id')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before)
  assert.equal(doc.querySelectorAll('[data-id="card-1"]').length, 1)
})

test('replacing a node with a new node of the same id undoes and redoes', () => {
  const { doc, scope } = board('<ul id="list"><li data-id="c1">Old card</li></ul>', { recording: 'commands' })
  const list = doc.getElementById('list')
  const start = bytes(doc)
  scope.command('Replace card', () => {
    list.querySelector('[data-id="c1"]').remove()
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'c1')
    card.textContent = 'New card'
    list.appendChild(card)
  })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true, 'the replacement node this undo removes is not a live duplicate')
  assert.equal(bytes(doc), start)
  assert.equal(doc.querySelector('[data-id="c1"]').textContent, 'Old card')
  assert.equal(scope.redo()?.ok, true, 'the removed card this redo removes is not a live duplicate either')
  assert.equal(bytes(doc), end)
  assert.equal(doc.querySelector('[data-id="c1"]').textContent, 'New card')
})

test('redo of an add refuses when a peer node carries an id nested in the added subtree', () => {
  const { doc, scope } = board('<ul id="a"></ul><ul id="b"></ul>', { recording: 'commands' })
  const listA = doc.getElementById('a')
  scope.command('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-1')
    const label = doc.createElement('span')
    label.setAttribute('data-id', 'label-1')
    label.textContent = 'Label'
    card.appendChild(label)
    listA.appendChild(card)
  })
  const entryId = ids(scope).at(-1)
  assert.equal(scope.undo()?.ok, true)

  peer(scope, () => {
    const duplicate = doc.createElement('span')
    duplicate.setAttribute('data-id', 'label-1')
    duplicate.textContent = 'Peer label'
    doc.getElementById('b').appendChild(duplicate)
  })

  const before = bytes(doc)
  const result = scope.redo()

  assert.equal(result?.ok, false)
  assert.equal(result.code, 'duplicate-id', 'a descendant identity that is live again refuses the redo')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before)
  assert.equal(doc.querySelectorAll('[data-id="label-1"]').length, 1)
})

test('rolling back a move puts the card back in the list and position it held', () => {
  const { doc, scope } = board('<p id="title" data-v="old">Title</p><ul id="a" data-id="a"><li data-id="card-1">Alpha</li><li data-id="card-2">Beta</li></ul><ul id="b" data-id="b"></ul>', { recording: 'commands' })
  const title = doc.getElementById('title')
  const listA = doc.getElementById('a')
  const listB = doc.getElementById('b')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit and move', () => {
    title.setAttribute('data-v', 'new')
    listB.appendChild(card)
  })
  const entryId = ids(scope).at(-1)
  const before = bytes(doc)

  const setAttribute = title.setAttribute.bind(title)
  title.setAttribute = (name, value) => {
    if (value === 'old') throw new Error('fixture DOM failure')
    setAttribute(name, value)
  }
  const result = scope.undo()

  assert.equal(result?.ok, false)
  assert.equal(result.code, 'replay-error')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before, 'the rolled-back move puts the card back where it was')
  assert.equal(card.parentNode, listB, 'the card is in neither list before the rollback undoes the move')
  assert.equal(listB.firstElementChild, card, 'and in its original position')
  assert.equal(listA.children.length, 1)
  assert.equal(scope.canUndo, true)
  assert.equal(scope.canRedo, false)
})

test('redo of an add that was followed by a write inside the new node succeeds', () => {
  const { doc, scope } = board('<ul id="list"></ul>', { recording: 'commands' })
  const list = doc.getElementById('list')
  scope.command('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-1')
    list.appendChild(card)
    card.setAttribute('data-title', 'New')
  })
  const end = bytes(doc)

  assert.equal(scope.undo()?.ok, true, 'undo removes the node the entry added, write and all')
  assert.equal(list.children.length, 0)

  assert.equal(scope.redo()?.ok, true, 'redo re-inserts it and the write is judged against the planned structure')
  assert.equal(bytes(doc), end)
  assert.equal(list.firstElementChild.getAttribute('data-title'), 'New')
})

test('undo of a text edit and a delete in one automatic entry restores the card and its old text', async () => {
  const { doc, scope } = board('<ul id="list"><li data-id="card-1">Alpha</li><li data-id="card-2">Beta</li></ul>', { idleWindowMs: 50 })
  const list = doc.getElementById('list')
  const card = doc.querySelector('[data-id="card-2"]')
  const start = bytes(doc)

  card.firstChild.data = 'Beta edited'
  await tick(0)
  card.remove()
  assert.equal(await nextCommit(scope), true)
  assert.equal(scope.history.length, 1, 'both mutations close as one idle batch')

  assert.equal(scope.undo()?.ok, true, 'the edit is planned on a node the same entry restores')
  assert.equal(bytes(doc), start)
  assert.equal(doc.querySelector('[data-id="card-2"]'), card)
  assert.equal(card.firstChild.data, 'Beta', 'the restored card carries its pre-entry text')
  assert.equal(list.children.length, 2)
})

test('a refused text step names the nearest element that carries a data-id', () => {
  const { doc, scope } = board('<article class="entry" data-id="e-1"><div class="body"><p id="para">first</p></div></article>')
  const text = doc.getElementById('para').firstChild
  scope.commit('Write', () => { text.data = 'mine' })
  peer(scope, () => { text.data = 'theirs' })

  const seen = []
  const off = scope.on('refused', (payload) => seen.push(payload))
  scope.undo()
  off()

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].targets.map((target) => target.id), ['e-1'])
  assert.equal(text.data, 'theirs')
})
