import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'
import { undo } from '../src/index.js'

// The certificate's durable projection has to answer to the same scope options
// the recorder does: an attribute the scope ignores may change without refusing
// an unrelated undo, and a node the scope protects may never be erased by a
// parent's undo or redo.

function board(html, opts = {}) {
  const dom = makeDom(`<!DOCTYPE html><html><head><title>Board</title></head><body>${html}</body></html>`)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope }
}

const bytes = (doc) => doc.body.outerHTML
const ids = (scope) => scope.history.map(e => e.id)

function peer(scope, fn) {
  scope.pause()
  try { fn() } finally { scope.resume() }
}

const derivedAttribute = (name) => name === 'data-derived'
const noUndo = (node) => node.nodeType === 1 && node.hasAttribute('data-no-undo')

function addDerivedCard(doc, list) {
  const card = doc.createElement('li')
  card.className = 'card'
  card.setAttribute('data-id', 'card-2')
  card.setAttribute('data-derived', 'v1')
  card.textContent = 'Beta'
  list.appendChild(card)
  return card
}

// before/after pair: identical scenario, only the ignoreAttribute option differs.
test('before: undo of an add refuses when an unignored attribute of the card changed', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { ignoreAttribute: derivedAttribute })
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => { card = addDerivedCard(doc, list) })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.setAttribute('data-peer-note', 'checked') })

  const before = bytes(doc)
  const result = scope.undo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'content-changed', 'an attribute the scope does not ignore still refuses the undo')
  assert.equal(bytes(doc), before)
  assert.deepEqual(ids(scope), [entryId])
})

test('after: an ignored attribute changed on the added card does not refuse its undo', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { ignoreAttribute: derivedAttribute })
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => { card = addDerivedCard(doc, list) })
  const entryId = ids(scope).at(-1)

  peer(scope, () => { card.setAttribute('data-derived', 'v2') })

  const undone = scope.undo()

  assert.equal(undone.ok, true, 'a value the scope never records must not block the undo that removes the card')
  assert.equal(undone.entryId, entryId)
  assert.equal(doc.querySelector('[data-id="card-2"]'), null, 'the subtree is gone')
  assert.equal(scope.history.length, 0)
  assert.equal(scope.canRedo, true)
})

test('an ignored attribute on a nested descendant does not refuse the undo', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { ignoreAttribute: derivedAttribute })
  const list = doc.querySelector('#list')
  let badge = null
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    const meta = doc.createElement('div')
    meta.className = 'meta'
    badge = doc.createElement('span')
    badge.setAttribute('data-derived', 'v1')
    badge.textContent = 'new'
    meta.appendChild(badge)
    card.appendChild(meta)
    list.appendChild(card)
  })

  peer(scope, () => { badge.setAttribute('data-derived', 'v2') })

  const undone = scope.undo()

  assert.equal(undone.ok, true, 'the filter applies to every node of the projected subtree, not only its root')
  assert.equal(doc.querySelector('[data-id="card-2"]'), null)
})

test('a text change inside the added subtree still refuses the undo', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { ignoreAttribute: derivedAttribute })
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => { card = addDerivedCard(doc, list) })

  peer(scope, () => { card.firstChild.data = 'Peer text' })

  const before = bytes(doc)
  const result = scope.undo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'content-changed')
  assert.equal(bytes(doc), before)
  assert.ok(doc.querySelector('[data-id="card-2"]'), 'the peer text is not erased')
})

// before/after pair: identical scenario, only the isProtected option differs.
test('before: without isProtected a parent undo erases a no-undo descendant', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>')
  const list = doc.querySelector('#list')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    const locked = doc.createElement('div')
    locked.setAttribute('data-id', 'locked')
    locked.setAttribute('data-no-undo', '')
    locked.textContent = 'draft in progress'
    card.appendChild(locked)
    list.appendChild(card)
  })

  const undone = scope.undo()

  assert.equal(undone.ok, true)
  assert.equal(doc.querySelector('[data-id="locked"]'), null, 'today the protected descendant goes with the parent')
})

test('after: a parent undo that would erase a protected descendant is refused as protected', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { isProtected: noUndo })
  const list = doc.querySelector('#list')
  let card = null
  scope.commit('Add card', () => {
    card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    const locked = doc.createElement('div')
    locked.setAttribute('data-id', 'locked')
    locked.setAttribute('data-no-undo', '')
    locked.textContent = 'draft in progress'
    card.appendChild(locked)
    list.appendChild(card)
  })
  const entryId = ids(scope).at(-1)

  let refusals = 0
  const off = scope.on('refused', () => { refusals += 1 })
  const before = bytes(doc)
  const result = scope.undo()
  off()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'protected', 'a new refusal code names the protection rule')
  assert.equal(result.entryId, entryId)
  assert.equal(result.targets, undefined, 'the receipt shape is unchanged; targets travel on the refused event')
  assert.equal(bytes(doc), before, 'the DOM is untouched')
  assert.ok(doc.querySelector('[data-id="locked"]'), 'the protected content survives')
  assert.deepEqual(ids(scope), [entryId], 'the entry is still on the stack')
  assert.equal(scope.canRedo, false)
  assert.equal(refusals, 1, 'the refused event fired once')
})

test('the refused event names the protected nodes as targets', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li></ul>', { isProtected: noUndo })
  const list = doc.querySelector('#list')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.setAttribute('data-id', 'card-2')
    card.innerHTML = '<div data-id="locked" data-no-undo>draft in progress</div>'
    list.appendChild(card)
  })

  let detail = null
  const off = scope.on('refused', (receipt) => { detail = receipt })
  scope.undo()
  off()

  assert.equal(detail.code, 'protected')
  assert.deepEqual(detail.targets, [{ id: 'locked', kind: 'protected' }])
})

test('a protected node outside the removed subtree does not block the undo', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="pinned"><div data-id="locked" data-no-undo>pinned draft</div></li></ul>', { isProtected: noUndo })
  const list = doc.querySelector('#list')
  scope.commit('Add card', () => {
    const card = doc.createElement('li')
    card.className = 'card'
    card.setAttribute('data-id', 'card-2')
    card.textContent = 'Beta'
    list.appendChild(card)
  })

  const undone = scope.undo()

  assert.equal(undone.ok, true)
  assert.equal(doc.querySelector('[data-id="card-2"]'), null)
  assert.ok(doc.querySelector('[data-id="locked"]'), 'an unrelated protected node neither blocks nor moves')
})

test('redo of a removal that would erase a protected descendant is refused as protected', () => {
  const { doc, scope } = board('<ul id="list" data-id="list"><li class="card" data-id="card-1">Alpha</li><li class="card" data-id="card-2"><div data-id="locked" data-no-undo>draft in progress</div></li></ul>', { isProtected: noUndo })
  scope.commit('Delete card', () => { doc.querySelector('[data-id="card-2"]').remove() })
  const entryId = ids(scope).at(-1)

  const restored = scope.undo()
  assert.equal(restored.ok, true, 'undoing the delete puts the subtree back, which erases nothing')
  assert.ok(doc.querySelector('[data-id="locked"]'))

  const before = bytes(doc)
  const result = scope.redo()

  assert.equal(result.ok, false)
  assert.equal(result.code, 'protected')
  assert.equal(result.entryId, entryId)
  assert.equal(bytes(doc), before)
  assert.ok(doc.querySelector('[data-id="locked"]'), 'redo leaves the protected content in place')
  assert.equal(scope.canRedo, true)
  assert.equal(scope.canUndo, false, 'the entry stays on the redo stack it was refused from')
})

test('create() forwards the isProtected option like the other scope options', () => {
  const dom = makeDom('<!DOCTYPE html><html><head></head><body><ul id="list" data-id="list"></ul></body></html>')
  const doc = dom.window.document
  const scope = undo.create({ scope: doc.body, idleWindowMs: 20, isProtected: noUndo })
  scope.start()
  try {
    const list = doc.querySelector('#list')
    scope.commit('Add card', () => {
      const card = doc.createElement('li')
      card.setAttribute('data-id', 'card-1')
      card.innerHTML = '<div data-id="locked" data-no-undo>draft in progress</div>'
      list.appendChild(card)
    })

    const result = scope.undo()

    assert.equal(result.ok, false)
    assert.equal(result.code, 'protected')
    assert.ok(doc.querySelector('[data-id="locked"]'))
  } finally {
    scope.stop()
  }
})

// A predicate that reads a node's ancestors (an app's painted attribute) cannot
// ask a detached subtree; the engine passes the parent it belongs under, so a
// removal's projection is the same while detached as after it is restored, and
// redo of a deleted list is not refused for content the app painted.
test('a removed subtree is projected with its host, so redo of a deletion is not refused for a painted attribute', async () => {
  const dom = makeDom('<!DOCTYPE html><html><head></head><body><main app><ul id="board"><li id="list" data-id="list-1" painted="x">List<b data-id="c1" painted="y">Card</b></li></ul></main></body></html>')
  const doc = dom.window.document
  const insideApp = (el, host) => {
    for (let cur = el; cur; cur = cur.parentElement) if (cur.hasAttribute('app')) return true
    return !!host && !el.isConnected && insideApp(host)
  }
  const scope = createScope({
    scope: doc.body,
    idleWindowMs: 20,
    ignoreAttribute: (name, node, host) => name === 'painted' && insideApp(node, host),
  })
  scope.start()
  scope.setRecording('commands')
  const list = doc.querySelector('#list')
  scope.command('Delete list', () => list.remove())
  const undone = scope.undo()
  assert.equal(undone.ok, true, JSON.stringify(undone))
  list.setAttribute('painted', 'repainted')
  const redone = scope.redo()
  assert.equal(redone.ok, true, JSON.stringify(redone))
  assert.equal(doc.querySelector('#list'), null)
})
