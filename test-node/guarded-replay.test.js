import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick, nextCommit } from './_setup.js'
import { createScope } from '../src/scope.js'

// Diagnosis fixtures for the guarded replay design (Kanban 08 Step 1).
// Every refusal must leave the document AND both stacks exactly as they were,
// and report itself: undo/redo return { ok, code, entryId, label, direction }
// instead of replaying whatever still happens to match field by field.
// These are expected red against the current engine; they record today's
// behavior so the next step can change it.

function board(html, opts = {}) {
  const dom = makeDom(`<!DOCTYPE html><html><head><title>Board</title></head><body>${html}</body></html>`)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const bytes = (doc) => doc.body.outerHTML
const ids = (scope) => scope.history.map(e => e.id)

// A peer/disk write: paused so it never enters this scope's history.
function peer(scope, fn) {
  scope.pause()
  try { fn() } finally { scope.resume() }
}

function assertRefused(result, { entryId, direction }) {
  assert.ok(result && typeof result === 'object', `${direction}() must return a result object { ok: false, code, entryId, direction }`)
  assert.equal(result.ok, false, `${direction}() must report the refusal, not a partial replay`)
  assert.equal(typeof result.code, 'string', 'a refusal carries a machine-readable code')
  assert.notEqual(result.code, 'empty', 'a non-empty stack cannot report an empty result')
  assert.equal(result.entryId, entryId, 'the refusal names the entry it left on the stack')
  assert.equal(result.direction, direction)
}

test('undo and redo return the documented receipts and restore the document', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  const renamed = bytes(doc)
  const entryId = ids(scope).at(-1)
  assert.equal(typeof entryId, 'string', 'every history entry carries a stable id plus its label and timestamp')
  assert.equal(scope.history.at(-1).label, 'Rename card')

  const undone = scope.undo()
  assert.equal(card.getAttribute('data-title'), 'Alpha')
  assert.equal(undone?.ok, true, 'undo returns { ok: true, entryId, label, direction }')
  assert.equal(undone.entryId, entryId)
  assert.equal(undone.label, 'Rename card')
  assert.equal(undone.direction, 'undo')

  const redone = scope.redo()
  assert.equal(bytes(doc), renamed, 'redo symmetrically restores the same entry')
  assert.equal(redone?.ok, true, 'redo returns { ok: true, entryId, label, direction }')
  assert.equal(redone.entryId, entryId)
  assert.equal(redone.label, 'Rename card')
  assert.equal(redone.direction, 'redo')
})

test('undo on an empty stack returns the empty result', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1">Alpha</li></ul>')
  const before = bytes(doc)
  const result = scope.undo()
  assert.ok(result && typeof result === 'object', 'undo() must return { ok: false, code: \'empty\' }')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty')
  assert.equal(bytes(doc), before)
})

test('probe 1: undo of an add whose card a peer edited is refused and keeps the peer text', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => {
    card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.firstChild.data = 'Peer text' })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(bytes(doc), before, 'a refused undo of an add must not erase the card, and with it the text a peer just wrote')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('probe 2: undo of a two-field step whose title a peer changed is refused whole', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" data-due="2026-01-01">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => {
    card.setAttribute('data-title', 'Local title')
    card.setAttribute('data-due', '2026-02-02')
  })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.setAttribute('data-title', 'Peer title') })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(bytes(doc), before, 'a partially conflicting step must be refused whole, so the peer title and the local due date both stay')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('probe 3: redo of that refused two-field step cannot overwrite the peer title', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" data-due="2026-01-01">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => {
    card.setAttribute('data-title', 'Local title')
    card.setAttribute('data-due', '2026-02-02')
  })
  peer(scope, () => { card.setAttribute('data-title', 'Peer title') })

  scope.undo()
  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.redo()

  assert.equal(card.getAttribute('data-title'), 'Peer title', 'redo must never write the local title over the peer value')
  assert.equal(bytes(doc), before, 'a refused redo leaves the document unchanged')
  assert.equal(scope.canRedo, false, 'the refused entry is not reachable as a redo')
  assert.deepEqual(ids(scope), beforeIds, 'a refused redo leaves the undo stack untouched')
  assert.equal(result?.ok, false, 'redo() must report that there is nothing safe to redo')
})

test('probe 3: redo compares against the value the undo wrote back', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" data-due="2026-01-01">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => {
    card.setAttribute('data-title', 'Local title')
    card.setAttribute('data-due', '2026-02-02')
  })

  assert.equal(scope.undo()?.ok, true, 'the two-field step undoes while both fields still hold the local values')
  assert.equal(card.getAttribute('data-title'), 'Alpha')
  assert.equal(card.getAttribute('data-due'), '2026-01-01')

  const redone = scope.redo()
  assert.equal(redone?.ok, true, 'a redo whose fields hold the values the undo wrote back must replay, not refuse')
  assert.equal(card.getAttribute('data-title'), 'Local title')
  assert.equal(card.getAttribute('data-due'), '2026-02-02')

  assert.equal(scope.undo()?.ok, true)
  peer(scope, () => { card.setAttribute('data-title', 'Peer title') })

  const before = bytes(doc)
  const result = scope.redo()

  assert.equal(card.getAttribute('data-title'), 'Peer title', 'and a redo whose field a peer changed is refused, leaving the peer value in place')
  assert.equal(bytes(doc), before, 'the refused redo leaves the document unchanged')
  assert.equal(result && result.code, 'content-changed')
})

test('the two-field step whose second field conflicts is refused whole', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha" data-due="2026-01-01">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Edit card', () => {
    card.setAttribute('data-title', 'Local title')
    card.setAttribute('data-due', '2026-02-02')
  })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.setAttribute('data-due', '2026-03-03') })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(bytes(doc), before, 'the unchanged first field must not be reverted when the second field conflicts')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('replacing the target node with a new node of the same data-id refuses the undo', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>')
  const list = doc.querySelector('#list')
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  const entryId = ids(scope).at(-1)

  peer(scope, () => {
    const replacement = doc.createElement('li')
    replacement.className = 'card'
    replacement.setAttribute('data-id', 'card-1')
    replacement.setAttribute('data-title', 'Local title')
    replacement.textContent = 'Peer relabelled'
    card.replaceWith(replacement)
  })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.ok(list.querySelector('[data-id="card-1"]'), 'the peer node stays')
  assert.equal(bytes(doc), before, 'the same data-id is not permission to redirect an old operation onto a replacement node')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('probe 4: undo of a delete refuses while a peer node holds the same data-id', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="card-2">Beta</li></ul><ul id="archive" data-id="archive"></ul>')
  const archive = doc.querySelector('#archive')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => {
    const restoredByPeer = doc.createElement('li')
    restoredByPeer.className = 'card'
    restoredByPeer.setAttribute('data-id', 'card-2')
    restoredByPeer.textContent = 'Beta (peer copy)'
    archive.appendChild(restoredByPeer)
  })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(result && result.code, 'duplicate-id', 'the peer copy lives elsewhere in the document, so only the duplicate-id guard can refuse this restore')
  assert.equal(doc.querySelectorAll('[data-id="card-2"]').length, 1, 'undo must not create a second live card with the same data-id')
  assert.equal(bytes(doc), before, 'a refused restore leaves the peer copy as the only card-2')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('probe 4: redo of an add refuses while a peer node holds the same data-id', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul><ul id="archive" data-id="archive"></ul>')
  const list = doc.querySelector('#list')
  const archive = doc.querySelector('#archive')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })
  const entryId = ids(scope).at(-1)
  assert.equal(scope.undo()?.ok, true, 'the add undoes cleanly, so the entry sits on the redo stack')

  peer(scope, () => {
    const restoredByPeer = doc.createElement('li')
    restoredByPeer.className = 'card'
    restoredByPeer.setAttribute('data-id', 'card-2')
    restoredByPeer.textContent = 'Beta (peer copy)'
    archive.appendChild(restoredByPeer)
  })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.redo()

  assert.equal(result && result.code, 'duplicate-id', 'the peer copy lives elsewhere in the document, so only the duplicate-id guard can refuse this insert')
  assert.equal(doc.querySelectorAll('[data-id="card-2"]').length, 1, 'redo must not insert a second live card with the same data-id')
  assert.equal(bytes(doc), before, 'a refused redo leaves the document unchanged')
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the redo stack untouched')
  assert.equal(scope.canUndo, false, 'a refused redo does not move the entry back to the undo stack')
  assertRefused(result, { entryId, direction: 'redo' })
})

test('undo of a delete refuses when the peer deleted the destination parent', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="card-2">Beta</li></ul>')
  const list = doc.querySelector('#list')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { list.remove() })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(doc.querySelector('#list'), null, 'the peer-deleted list must not come back')
  assert.equal(doc.querySelector('[data-id="card-2"]'), null, 'and the card is not reinserted anywhere else')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('undo of a delete refuses when the peer deleted the recorded anchor', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="card-2">Beta</li><li class="card" data-id="card-3">Gamma</li></ul>')
  const list = doc.querySelector('#list')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { doc.querySelector('[data-id="card-3"]').remove() })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(doc.querySelector('[data-id="card-2"]'), null, 'a vanished anchor refuses the restore instead of falling back to an append')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('undo of a delete refuses after a peer inserted a sibling in the same list', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="card-2">Beta</li><li class="card" data-id="card-3">Gamma</li></ul>')
  const list = doc.querySelector('#list')
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  peer(scope, () => {
    const inserted = doc.createElement('li')
    inserted.className = 'card'
    inserted.setAttribute('data-id', 'card-peer')
    inserted.textContent = 'Peer card'
    list.insertBefore(inserted, doc.querySelector('[data-id="card-3"]'))
  })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.equal(doc.querySelector('[data-id="card-2"]'), null, 'a changed child sequence refuses the restore even though a slot still looks free')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('undo of an add refuses when the peer changed an unknown authored attribute', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => {
    card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.setAttribute('data-peer-note', 'checked by a peer') })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo()

  assert.ok(doc.querySelector('[data-id="card-2"]'), 'not recorded by undo does not mean safe to erase')
  assert.equal(doc.querySelector('[data-id="card-2"]').getAttribute('data-peer-note'), 'checked by a peer')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), beforeIds, 'a refusal leaves the undo stack untouched')
  assert.equal(scope.canRedo, false, 'a refusal does not move the entry to the redo stack')
  assertRefused(result, { entryId, direction: 'undo' })
})

test('a peer change to an unrelated card does not block the undo', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li><li class="card" data-id="card-2" data-title="Gamma">Gamma</li></ul>')
  const card1 = doc.querySelector('[data-id="card-1"]')
  const card2 = doc.querySelector('[data-id="card-2"]')
  scope.commit('Rename card', () => { card1.setAttribute('data-title', 'Local title') })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card2.setAttribute('data-title', 'Peer title') })

  const beforeIds = ids(scope)
  scope.undo()

  assert.equal(card1.getAttribute('data-title'), 'Alpha', 'the guarded undo still applies')
  assert.equal(card2.getAttribute('data-title'), 'Peer title', 'and leaves the peer card alone')
  assert.equal(doc.body.outerHTML.includes('data-title="Alpha"'), true)
  assert.deepEqual(ids(scope), beforeIds.slice(0, -1), 'a successful undo does move its own entry')
  assert.equal(scope.canRedo, true)
  assert.equal(scope.history.some(e => e.id === entryId) && entryId !== undefined, false)
})

test('repeated writes to the same field are one entry and undo restores the first value', async () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>', { idleWindowMs: 200 })
  const card = doc.querySelector('[data-id="card-1"]')
  const committed = nextCommit(scope, 2000)

  card.setAttribute('data-title', 'Second')
  await tick(30)
  card.setAttribute('data-title', 'Third')
  await tick(30)

  assert.equal(await committed, true, 'both writes belong to one idle entry')
  assert.equal(scope.history.length, 1)
  const entryId = ids(scope).at(-1)

  scope.undo()
  assert.equal(card.getAttribute('data-title'), 'Alpha', 'undo restores the value before the first write, not an intermediate one')
  assert.equal(scope.history.length, 0)
  assert.equal(scope.canRedo, true)
  assert.ok(entryId === undefined || typeof entryId === 'string')
})

test('a command with no net change creates no entry and undo changes nothing', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>')
  const card = doc.querySelector('[data-id="card-1"]')
  const before = bytes(doc)

  scope.commit('Rename card', () => {
    card.setAttribute('data-title', 'Alpha')
    card.firstChild.data = 'Alpha'
  })

  assert.equal(scope.history.length, 0, 'a successful no-op command creates no entry')
  scope.undo()
  assert.equal(bytes(doc), before)
  assert.equal(scope.canUndo, false)
  assert.equal(scope.canRedo, false)
})

test('a refused top entry can be dismissed explicitly without touching the document', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>')
  const list = doc.querySelector('#list')
  const card1 = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card1.setAttribute('data-title', 'Local title') })
  let card2 = null
  scope.commit('Add card', () => {
    card2 = doc.createElement('li')
    card2.className = 'card'
    card2.setAttribute('data-id', 'card-2')
    card2.textContent = 'Beta'
    list.appendChild(card2)
  })
  const refusedId = ids(scope).at(-1)
  const olderId = ids(scope).at(-2)

  peer(scope, () => { card2.firstChild.data = 'Peer text' })
  const refused = scope.undo()
  assertRefused(refused, { entryId: refusedId, direction: 'undo' })

  const before = bytes(doc)
  const result = scope.discard(refusedId)

  assert.notEqual(result, false, 'dismissing a refused entry succeeds')
  assert.equal(bytes(doc), before, 'dismissal never edits the document')
  assert.deepEqual(ids(scope), [olderId], 'dismissal discards only the blocked entry, leaving older history reachable')

  const undone = scope.undo()
  assert.equal(undone?.ok, true, 'the older entry is now the top entry')
  assert.equal(card1.getAttribute('data-title'), 'Alpha')
  assert.equal(card2.firstChild.data, 'Peer text', 'and the kept peer text is untouched')
})

test('an entryId that is not the top entry is refused as stale', () => {
  const { doc, scope } = board('<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li><li class="card" data-id="card-2" data-title="Gamma">Gamma</li></ul>')
  const card1 = doc.querySelector('[data-id="card-1"]')
  const card2 = doc.querySelector('[data-id="card-2"]')
  scope.commit('Rename card 1', () => { card1.setAttribute('data-title', 'Local one') })
  const olderId = ids(scope).at(-1)
  scope.commit('Rename card 2', () => { card2.setAttribute('data-title', 'Local two') })

  const before = bytes(doc)
  const beforeIds = ids(scope)
  const result = scope.undo({ entryId: olderId })

  assert.equal(bytes(doc), before, 'a toast for an older action must not undo a newer one')
  assert.deepEqual(ids(scope), beforeIds, 'a stale entryId touches neither stack')
  assert.equal(scope.canRedo, false)
  assert.ok(result && typeof result === 'object', 'undo({ entryId }) must return a result object')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stale-entry')
  assert.equal(result.entryId, olderId)
})
