import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { recordToPrimitives, recordsToPrimitives, replayForward, replayReverse } from '../src/primitives.js'

function doc(html = '<!DOCTYPE html><body></body>') {
  return new JSDOM(html).window.document
}

// ----- replay: value (property write, observer-invisible) -----

test('value: reverse restores oldValue, forward re-applies newValue (input.value)', () => {
  const d = doc('<!DOCTYPE html><input id="x" />')
  const el = d.getElementById('x')
  el.value = 'new'
  const p = { kind: 'value', target: el, prop: 'value', oldValue: 'old', newValue: 'new' }
  replayReverse(p)
  assert.equal(el.value, 'old')
  replayForward(p)
  assert.equal(el.value, 'new')
})

test('value: works on a non-default prop (checkbox.checked)', () => {
  const d = doc('<!DOCTYPE html><input id="x" type="checkbox" />')
  const el = d.getElementById('x')
  el.checked = true
  const p = { kind: 'value', target: el, prop: 'checked', oldValue: false, newValue: true }
  replayReverse(p)
  assert.equal(el.checked, false)
  replayForward(p)
  assert.equal(el.checked, true)
})

// ----- replay: attributes -----

test('attr-set: reverse restores oldValue, forward re-applies newValue', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-foo="old"></div>')
  const el = d.getElementById('x')
  el.setAttribute('data-foo', 'new')
  const p = { kind: 'attr-set', target: el, name: 'data-foo', oldValue: 'old', newValue: 'new' }
  replayReverse(p)
  assert.equal(el.getAttribute('data-foo'), 'old')
  replayForward(p)
  assert.equal(el.getAttribute('data-foo'), 'new')
})

test('attr-add: reverse removes the attribute, forward re-adds', () => {
  const d = doc('<!DOCTYPE html><div id="x"></div>')
  const el = d.getElementById('x')
  el.setAttribute('data-new', 'v')
  const p = { kind: 'attr-add', target: el, name: 'data-new', newValue: 'v' }
  replayReverse(p)
  assert.equal(el.hasAttribute('data-new'), false)
  replayForward(p)
  assert.equal(el.getAttribute('data-new'), 'v')
})

test('attr-remove: reverse restores the attribute, forward removes it', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-gone="v"></div>')
  const el = d.getElementById('x')
  el.removeAttribute('data-gone')
  const p = { kind: 'attr-remove', target: el, name: 'data-gone', oldValue: 'v' }
  replayReverse(p)
  assert.equal(el.getAttribute('data-gone'), 'v')
  replayForward(p)
  assert.equal(el.hasAttribute('data-gone'), false)
})

// ----- replay: characterData -----

test('text: reverse restores old text, forward re-applies new text', () => {
  const d = doc('<!DOCTYPE html><p id="x">old</p>')
  const node = d.getElementById('x').firstChild
  node.data = 'new'
  const p = { kind: 'text', target: node, oldValue: 'old', newValue: 'new' }
  replayReverse(p)
  assert.equal(node.data, 'old')
  replayForward(p)
  assert.equal(node.data, 'new')
})

// ----- replay: childList add -----

test('add: reverse removes the node, forward re-inserts before the slot', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  const added = d.createElement('li')
  added.id = 'b'
  list.insertBefore(added, a)            // <b><a>
  const p = { kind: 'add', parent: list, nodes: [added], before: a }
  replayReverse(p)                       // removes b
  assert.equal(d.getElementById('b'), null)
  assert.equal(list.children.length, 1)
  replayForward(p)                       // re-inserts b before a
  assert.equal(list.firstElementChild.id, 'b')
  assert.equal(list.children[1].id, 'a')
})

test('add: forward falls back to appendChild when the slot is gone', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  const added = d.createElement('li')
  added.id = 'b'
  const p = { kind: 'add', parent: list, nodes: [added], before: a }
  a.remove()                             // slot reference no longer a child
  replayForward(p)
  assert.equal(list.lastElementChild.id, 'b')   // appended
})

// ----- replay: childList remove -----

test('remove: reverse re-inserts before the slot, forward removes', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a"></li><li id="b"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  const b = d.getElementById('b')
  a.remove()                             // removed; b is the next sibling slot
  const p = { kind: 'remove', parent: list, nodes: [a], before: b }
  replayReverse(p)                       // re-insert a before b
  assert.equal(list.firstElementChild.id, 'a')
  assert.equal(list.children[1].id, 'b')
  replayForward(p)                       // remove a again
  assert.equal(d.getElementById('a'), null)
})

test('remove: reverse restores the SAME node reference (identity preserved)', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  a.dataset.marker = 'live'              // mutate the live node
  a.remove()
  const p = { kind: 'remove', parent: list, nodes: [a], before: null }
  replayReverse(p)
  assert.equal(list.firstElementChild, a)          // same object back
  assert.equal(list.firstElementChild.dataset.marker, 'live')
})

// ----- recordToPrimitives -----

test('recordToPrimitives: attribute add (oldValue null) → attr-add', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-foo="v"></div>')
  const el = d.getElementById('x')
  const out = recordToPrimitives({ type: 'attributes', target: el, attributeName: 'data-foo', oldValue: null })
  assert.deepEqual(out, [{ kind: 'attr-add', target: el, name: 'data-foo', newValue: 'v' }])
})

test('recordToPrimitives: attribute change → attr-set', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-foo="new"></div>')
  const el = d.getElementById('x')
  const out = recordToPrimitives({ type: 'attributes', target: el, attributeName: 'data-foo', oldValue: 'old' })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'attr-set')
  assert.equal(out[0].oldValue, 'old')
  assert.equal(out[0].newValue, 'new')
})

test('recordToPrimitives: attribute removal (newValue null) → attr-remove', () => {
  const d = doc('<!DOCTYPE html><div id="x"></div>')
  const el = d.getElementById('x')   // data-foo already absent
  const out = recordToPrimitives({ type: 'attributes', target: el, attributeName: 'data-foo', oldValue: 'old' })
  assert.deepEqual(out, [{ kind: 'attr-remove', target: el, name: 'data-foo', oldValue: 'old' }])
})

test('recordToPrimitives: unchanged attribute (old === new) → no primitive', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-foo="same"></div>')
  const el = d.getElementById('x')
  const out = recordToPrimitives({ type: 'attributes', target: el, attributeName: 'data-foo', oldValue: 'same' })
  assert.deepEqual(out, [])
})

test('recordToPrimitives: characterData → text', () => {
  const d = doc('<!DOCTYPE html><p id="x">new</p>')
  const node = d.getElementById('x').firstChild
  const out = recordToPrimitives({ type: 'characterData', target: node, oldValue: 'old' })
  assert.deepEqual(out, [{ kind: 'text', target: node, oldValue: 'old', newValue: 'new' }])
})

test('remove: reverse falls back to appendChild when the before-slot is gone', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a"></li><li id="b"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  const b = d.getElementById('b')
  a.remove()                               // captured before = b
  const p = { kind: 'remove', parent: list, nodes: [a], before: b }
  b.remove()                               // the slot is now gone
  replayReverse(p)                         // before.parentNode !== parent → appendChild
  assert.equal(list.lastElementChild, a)
})

// ----- recordsToPrimitives: batch-level attribute coalescing -----

test('recordsToPrimitives: add-then-remove of an absent attr in one batch → no primitive', () => {
  const d = doc('<!DOCTYPE html><div id="x"></div>')   // data-flag absent = final state
  const el = d.getElementById('x')
  const out = recordsToPrimitives([
    { type: 'attributes', target: el, attributeName: 'data-flag', oldValue: null },   // add
    { type: 'attributes', target: el, attributeName: 'data-flag', oldValue: 'on' },   // remove
  ])
  assert.deepEqual(out, [])               // net no-op within the batch
})

test('recordsToPrimitives: remove-then-readd-same-value in one batch → no primitive', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-x="orig"></div>')   // 'orig' = final state
  const el = d.getElementById('x')
  const out = recordsToPrimitives([
    { type: 'attributes', target: el, attributeName: 'data-x', oldValue: 'orig' },   // remove
    { type: 'attributes', target: el, attributeName: 'data-x', oldValue: null },     // readd
  ])
  assert.deepEqual(out, [])
})

test('recordsToPrimitives: set-then-set in one batch → one attr-set (first old + final value)', () => {
  const d = doc('<!DOCTYPE html><div id="x" data-x="c"></div>')   // 'c' = final state
  const el = d.getElementById('x')
  const out = recordsToPrimitives([
    { type: 'attributes', target: el, attributeName: 'data-x', oldValue: 'a' },   // a→b
    { type: 'attributes', target: el, attributeName: 'data-x', oldValue: 'b' },   // b→c
  ])
  assert.deepEqual(out, [{ kind: 'attr-set', target: el, name: 'data-x', oldValue: 'a', newValue: 'c' }])
})

test('recordsToPrimitives: preserves order of attribute and childList primitives', () => {
  const d = doc('<!DOCTYPE html><ul id="list"><li id="a" data-x="new"></li></ul>')
  const list = d.getElementById('list')
  const a = d.getElementById('a')
  const li = d.createElement('li')
  const out = recordsToPrimitives([
    { type: 'attributes', target: a, attributeName: 'data-x', oldValue: 'old' },
    { type: 'childList', target: list, addedNodes: [li], removedNodes: [], nextSibling: null },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].kind, 'attr-set')   // attribute primitive lands at its first occurrence
  assert.equal(out[1].kind, 'add')
})

test('recordToPrimitives: childList with both added and removed → two primitives', () => {
  const d = doc('<!DOCTYPE html><ul id="list"></ul>')
  const list = d.getElementById('list')
  const added = d.createElement('li')
  const removed = d.createElement('li')
  const slot = d.createElement('li')
  const out = recordToPrimitives({
    type: 'childList',
    target: list,
    addedNodes: [added],
    removedNodes: [removed],
    nextSibling: slot,
  })
  assert.equal(out.length, 2)
  assert.equal(out[0].kind, 'add')
  assert.deepEqual(out[0].nodes, [added])
  assert.equal(out[0].before, slot)
  assert.equal(out[1].kind, 'remove')
  assert.deepEqual(out[1].nodes, [removed])
})
