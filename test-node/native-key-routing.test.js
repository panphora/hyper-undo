import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { installKeys } from '../src/keys.js'
import { createScope } from '../src/scope.js'
import undo from '../src/index.js'

// The page stack owns Cmd+Z globally, but a key pressed inside a plain form
// control belongs to the control: the browser's own text undo must run and the
// page stack must not move. Same rule for Cmd+Shift+Z. These are the native
// undo cases of Kanban 08 Step 1, expected red against the current key owner.

function fakeScope() {
  const calls = []
  return {
    calls,
    _config: { shadowKeydownIn: undo.defaults.shadowKeydownIn },
    undo() { calls.push('undo') },
    redo() { calls.push('redo') },
  }
}

function press(dom, targetEl, init) {
  const ev = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  targetEl.dispatchEvent(ev)
  return ev
}

test('Ctrl+Z inside an ordinary text input is left to the browser', () => {
  const dom = makeDom('<!DOCTYPE html><body><input id="title" value="Alpha"></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('title'), { key: 'z', ctrlKey: true })
  assert.deepEqual(scope.calls, [], 'the page stack must not undo while the input owns the key')
  assert.equal(ev.defaultPrevented, false, 'the browser native undo must still run in the input')
  cleanup()
})

test('Cmd+Z inside a textarea is left to the browser', () => {
  const dom = makeDom('<!DOCTYPE html><body><textarea id="description">Alpha</textarea></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('description'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [], 'the page stack must not undo while the textarea owns the key')
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('Cmd+Shift+Z inside a select is left to the browser', () => {
  const dom = makeDom('<!DOCTYPE html><body><select id="due"><option>Today</option></select></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('due'), { key: 'z', metaKey: true, shiftKey: true })
  assert.deepEqual(scope.calls, [], 'redo is not claimed inside a select either')
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('Cmd+Z inside a contenteditable subtree is left to the browser', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="note" contenteditable="true"><span id="caret">Alpha</span></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('caret'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [], 'an editable ancestor owns its own text undo')
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('a Cmd+Z the page already handled is not claimed', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const handler = (event) => { event.preventDefault() }
  dom.window.addEventListener('keydown', handler, true)
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [], 'a defaultPrevented key belongs to whoever handled it')
  assert.equal(ev.defaultPrevented, true)
  dom.window.removeEventListener('keydown', handler, true)
  cleanup()
})

test('a Cmd+Z during IME composition is not claimed', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true, isComposing: true })
  assert.deepEqual(scope.calls, [], 'the IME owns the key while composing')
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('a keydown carrying keyCode 229 is not claimed', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true, keyCode: 229 })
  assert.deepEqual(scope.calls, [], 'keyCode 229 is the IME processing marker')
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('a plain non-editable target still claims Cmd+Z', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, ['undo'], 'page-level undo keeps working outside form controls')
  assert.equal(ev.defaultPrevented, true)
  cleanup()
})

test('the page stack does not undo while the caret is in an ordinary input', () => {
  const dom = makeDom('<!DOCTYPE html><body><input id="title" value="Alpha"><ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul></body>')
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const cleanup = installKeys(scope)
  const card = doc.querySelector('[data-id="card-1"]')
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Local title') })

  const before = doc.body.outerHTML
  const ev = press(dom, doc.getElementById('title'), { key: 'z', metaKey: true })

  assert.equal(ev.defaultPrevented, false, 'the input keeps its native undo')
  assert.equal(doc.body.outerHTML, before, 'the page stack must not replay while the input owns the key')
  assert.equal(scope.history.length, 1)
  assert.equal(scope.canRedo, false)

  cleanup()
  scope.stop()
})

test('body keys undo exactly one page command and redo it once', () => {
  const dom = makeDom('<!DOCTYPE html><html><head><title>Board</title></head><body><ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul></body></html>')
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  scope.setRecording('commands')
  const cleanup = installKeys(scope)
  const card = doc.querySelector('[data-id="card-1"]')
  scope.command('Rename card', () => { card.setAttribute('data-title', 'First') })
  scope.command('Rename card again', () => { card.setAttribute('data-title', 'Second') })

  const undoKey = press(dom, doc.body, { key: 'z', metaKey: true })
  assert.equal(undoKey.defaultPrevented, true, 'a body key is the page stack\u2019s to handle')
  assert.equal(card.getAttribute('data-title'), 'First', 'one keydown moves exactly one entry')
  assert.equal(scope.canRedo, true)

  const redoKey = press(dom, doc.body, { key: 'z', metaKey: true, shiftKey: true })
  assert.equal(redoKey.defaultPrevented, true)
  assert.equal(card.getAttribute('data-title'), 'Second', 'one redo keydown moves exactly one entry')

  const ctrlKey = press(dom, doc.body, { key: 'z', ctrlKey: true })
  assert.equal(ctrlKey.defaultPrevented, true)
  assert.equal(card.getAttribute('data-title'), 'First')

  cleanup()
  scope.stop()
})
