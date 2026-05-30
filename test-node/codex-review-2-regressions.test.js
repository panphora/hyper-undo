// Regression tests for the SECOND-pass review findings
// (plans/hyperclayjs/undo-redo-codex-review-2.md). Each fails on the pre-fix code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { undo } from '../src/index.js'

// --- #2: only one scope may own the global Cmd+Z binding ---

test('#2: a second bindKeys scope throws until the first is stopped', () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><div id="a"></div><div id="b"></div></body>').window
  const a = undo.create({ scope: doc.getElementById('a'), bindKeys: true, idleWindowMs: 5 })
  const b = undo.create({ scope: doc.getElementById('b'), bindKeys: true, idleWindowMs: 5 })
  try {
    a.start()
    assert.throws(() => b.start(), /already owns the global Cmd\+Z binding/)
    a.stop()
    assert.doesNotThrow(() => b.start()) // freed up once the first stops
  } finally {
    a.stop()
    b.stop()
  }
})

// --- #3: commitCaptured must not punch through an outer exclusion pause ---

test('#3: commitCaptured does not record through an active outer pause', () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><h1 id="h">Hi</h1></body>').window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  scope.pause() // outer exclusion window
  scope.pause() // inner commitWithUndo-style capture pause
  doc.body.appendChild(doc.createElement('p'))
  scope.commitCaptured('inner structural')
  scope.resume()
  scope.resume()
  assert.deepEqual(scope.history.map((c) => c.label), [], 'nothing recorded under an outer pause')
  scope.stop()
})

test('#3 control: commitCaptured still records normally with a single pause', () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><h1 id="h">Hi</h1></body>').window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  scope.pause()
  doc.body.appendChild(doc.createElement('p'))
  scope.commitCaptured('structural')
  scope.resume()
  assert.deepEqual(scope.history.map((c) => c.label), ['structural'])
  scope.stop()
})

// --- #4: a removed scope root stops itself; the key binding is released ---

test('#4: undo on a disconnected scope stops it instead of mutating a detached tree', () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><div id="editor"><p id="x">old</p></div></body>').window
  const editor = doc.getElementById('editor')
  const scope = createScope({ scope: editor, idleWindowMs: 20 })
  scope.start()
  scope.commit('edit', () => { doc.getElementById('x').textContent = 'new' })
  assert.equal(scope.canUndo, true)
  editor.remove() // caller forgot to stop()
  scope.undo()
  assert.equal(doc.getElementById('x'), null, 'detached subtree left untouched')
  assert.equal(scope.canUndo, false, 'scope stopped + stack cleared on disconnect')
  scope.stop()
})

test('#4: a disconnected bindKeys scope releases the binding and lets native Cmd+Z through', () => {
  const { document: doc, KeyboardEvent } = makeDom('<!DOCTYPE html><body><div id="editor"></div></body>').window
  const inst = undo.create({ scope: doc.getElementById('editor'), bindKeys: true, idleWindowMs: 5 })
  try {
    inst.start()
    inst.commit('edit', () => doc.getElementById('editor').appendChild(doc.createElement('span')))
    doc.getElementById('editor').remove()
    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    doc.body.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, false, 'native Cmd+Z not swallowed by a detached scope')
    const inst2 = undo.create({ scope: doc.body, bindKeys: true, idleWindowMs: 5 })
    assert.doesNotThrow(() => inst2.start(), 'binding was released, so a new scope can claim it')
    inst2.stop()
  } finally {
    inst.stop()
  }
})

// --- #5: stop() resets pause depth so a reused scope records again ---

test('#5: stop() resets pause depth (a restarted scope is not stuck paused)', async () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><h1 id="h">Hi</h1></body>').window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  scope.pause()
  scope.stop()
  scope.start()
  assert.equal(scope.isPaused, false, 'restart is not stuck paused')
  doc.getElementById('h').textContent = 'After restart'
  await tick(40)
  assert.equal(scope.canUndo, true, 'recording works again after restart')
  scope.stop()
})
