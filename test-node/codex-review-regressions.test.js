// Regression tests for the findings in plans/hyperclayjs/undo-redo-codex-review.md.
// Each test fails against the pre-fix code and passes after the fix.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { undo } from '../src/index.js'

// --- C1: childList ignore-filtering must inspect added/removed nodes ---

test('C1: appending an ignored node under an un-ignored parent records nothing', async () => {
  const { document: doc } = makeDom().window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const shell = doc.createElement('div')
  shell.setAttribute('save-ignore', '')
  shell.setAttribute('data-hcms-shell', '')
  doc.body.appendChild(shell)
  await tick(40)
  assert.equal(scope.canUndo, false, 'ignored append must not create a commit')
  scope.undo()
  assert.equal(shell.parentNode, doc.body, 'undo must not remove the ignored subtree')
  scope.stop()
})

test('C1: a normal append under the same parent still records and undoes', async () => {
  const { document: doc } = makeDom().window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const div = doc.createElement('div')
  doc.body.appendChild(div)
  await tick(40)
  assert.equal(scope.canUndo, true)
  scope.undo()
  assert.equal(div.parentNode, null, 'normal append is undoable')
  scope.stop()
})

test('C1: a single childList record with mixed nodes keeps only the un-ignored one', async () => {
  const { document: doc } = makeDom().window
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const keep = doc.createElement('section')
  const ignore = doc.createElement('div')
  ignore.setAttribute('mutations-ignore', '')
  // A fragment append produces ONE childList record with both in addedNodes.
  const frag = doc.createDocumentFragment()
  frag.append(keep, ignore)
  doc.body.appendChild(frag)
  await tick(40)
  assert.equal(scope.canUndo, true)
  scope.undo()
  assert.equal(keep.parentNode, null, 'kept node is undone')
  assert.equal(ignore.parentNode, doc.body, 'ignored node is untouched by undo')
  scope.stop()
})

// --- H1: flush() must drain the observer buffer so a save boundary holds ---

test('H1: flush() bounds the batch; undo after a later edit stops at the save point', async () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><div id="t"></div></body>').window
  const el = doc.getElementById('t')
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  el.setAttribute('data-title', 'saved')   // same tick; observer callback not fired yet
  scope.flush()                            // the snapshot.js save hook calls this
  assert.equal(scope.canUndo, true, 'flush() closes the pre-save mutation as its own commit')
  await tick(5)
  el.setAttribute('data-title', 'after')   // a later edit
  await tick(40)
  scope.undo()
  assert.equal(el.getAttribute('data-title'), 'saved', 'undo stops at the save boundary, not before it')
  scope.stop()
})

// --- H2: a pre-pause same-tick edit must not be swallowed by commitCaptured ---

test('H2: a pre-pause same-tick edit is preserved, not folded into the structural commit', () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><h1 id="h">Hi</h1></body>').window
  const h1 = doc.getElementById('h')
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  h1.textContent = 'Typed'        // same synchronous tick, BEFORE pause
  scope.pause()                   // must drain the pre-pause edit into its own batch
  const p = doc.createElement('p')
  doc.body.appendChild(p)
  scope.commitCaptured('Add p')
  scope.resume()
  assert.deepEqual(scope.history.map((c) => c.label), ['Edit', 'Add p'])
  scope.undo()                    // undo 'Add p' only
  assert.equal(p.parentNode, null, 'paragraph removed')
  assert.equal(h1.textContent, 'Typed', 'prior typing preserved')
  scope.stop()
})

// --- H3: pause is reference-counted ---

test('H3: nested pause needs matching resumes before recording resumes', async () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><h1 id="h">Hi</h1></body>').window
  const h1 = doc.getElementById('h')
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  scope.pause()
  scope.pause()
  scope.resume()                  // still paused (depth 1)
  assert.equal(scope.isPaused, true, 'one resume after two pauses stays paused')
  h1.textContent = 'changed'
  await tick(40)
  assert.equal(scope.canUndo, false, 'a mutation under the remaining pause is not recorded')
  scope.resume()                  // depth 0
  assert.equal(scope.isPaused, false)
  h1.textContent = 'seen'
  await tick(40)
  assert.equal(scope.canUndo, true, 'recording resumes after the outermost release')
  scope.stop()
})

// --- M2: clear() discards same-tick bootstrap mutations ---

test('M2: clear() drops a same-tick buffered mutation so it does not resurface', async () => {
  const { document: doc } = makeDom('<!DOCTYPE html><body><div id="t"></div></body>').window
  const el = doc.getElementById('t')
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  el.setAttribute('data-x', '1')   // same tick
  scope.clear()
  await tick(40)
  assert.equal(scope.canUndo, false, 'cleared bootstrap mutation does not come back as a commit')
  scope.stop()
})

// --- M1: create().start() twice must not double-bind the key listener ---

test('M1: create().start() called twice binds the key listener only once', () => {
  const { document: doc, KeyboardEvent } = makeDom('<!DOCTYPE html><body></body></html>').window
  const inst = undo.create({ scope: doc.body, bindKeys: true, idleWindowMs: 5 })
  inst.start()
  inst.start()
  inst.commit('one', () => doc.body.appendChild(doc.createElement('a')))
  inst.commit('two', () => doc.body.appendChild(doc.createElement('b')))
  assert.equal(inst.history.length, 2)
  const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
  doc.body.dispatchEvent(ev)
  assert.equal(inst.history.length, 1, 'exactly one undo ran, so only one listener was bound')
  inst.stop()
})
