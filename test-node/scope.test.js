import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

function mkScope(html = '<!DOCTYPE html><body><h1>Hi</h1></body>', opts = {}) {
  const dom = makeDom(html)
  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20, ...opts })
  return { dom, doc: dom.window.document, scope }
}

test('idle auto-batch produces one Edit commit per pause', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  doc.querySelector('h1').textContent = 'Hello'
  await tick(40)
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].label, 'Edit')
  assert.equal(typeof scope.history[0].timestamp, 'number')
})

test('undo restores prior text, redo re-applies', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  const h1 = doc.querySelector('h1')
  h1.textContent = 'Hello'
  await tick(40)
  scope.undo()
  assert.equal(h1.textContent, 'Hi')
  assert.equal(scope.canUndo, false)
  assert.equal(scope.canRedo, true)
  scope.redo()
  assert.equal(h1.textContent, 'Hello')
  assert.equal(scope.canUndo, true)
})

test('explicit commit produces one labelled commit', () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.commit('Rename', () => { doc.querySelector('h1').textContent = 'X' })
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].label, 'Rename')
})

test('max-history evicts oldest commit', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="x"></div></body>', { maxHistory: 2 })
  scope.start()
  const x = doc.getElementById('x')
  scope.commit('A', () => x.setAttribute('data-a', '1'))
  scope.commit('B', () => x.setAttribute('data-b', '1'))
  scope.commit('C', () => x.setAttribute('data-c', '1'))
  assert.equal(scope.history.length, 2)
  assert.deepEqual(scope.history.map(c => c.label), ['B', 'C'])
})

test('commitCaptured pushes drained records as one commit', () => {
  const { doc, scope } = mkScope()
  scope.start()
  const h1 = doc.querySelector('h1')
  scope.pause()
  h1.textContent = 'Hello'
  scope.commitCaptured('Test apply')
  scope.resume()
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].label, 'Test apply')
  scope.undo()
  assert.equal(h1.textContent, 'Hi')
})

test('discardCaptured drops drained records', () => {
  const { doc, scope } = mkScope()
  scope.start()
  const h1 = doc.querySelector('h1')
  scope.pause()
  h1.textContent = 'Hello'
  scope.discardCaptured()
  scope.resume()
  assert.equal(scope.history.length, 0)
})

test('commitCaptured flushes a pending idle batch FIRST (ordering preserved)', async () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><h1>Hi</h1></body>')
  scope.start()
  const h1 = doc.querySelector('h1')
  // 1) "typing" lands in the idle buffer and is processed (but not yet closed).
  h1.textContent = 'Typed'
  await tick(5)   // < idleWindowMs (20): observer callback ran, idle timer pending
  // 2) a structural op captured via the pause-before pattern
  scope.pause()
  const added = doc.createElement('p')
  added.id = 'added'
  doc.body.appendChild(added)
  scope.commitCaptured('Add p')
  scope.resume()
  // The typing must close as 'Edit' BEFORE 'Add p' so undo order is correct.
  assert.deepEqual(scope.history.map(c => c.label), ['Edit', 'Add p'])
  scope.undo()                                    // undoes 'Add p' first
  assert.equal(doc.getElementById('added'), null)
  assert.equal(h1.textContent, 'Typed')           // typing still intact
  scope.undo()                                    // then undoes the typing
  assert.equal(h1.textContent, 'Hi')
})

test('mutations while paused are not recorded', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.pause()
  doc.querySelector('h1').textContent = 'Hidden'
  await tick(40)
  assert.equal(scope.history.length, 0)
  scope.resume()
  doc.querySelector('h1').textContent = 'Seen'
  await tick(40)
  assert.equal(scope.history.length, 1)
})

test('mutations inside a save-ignore subtree are skipped', async () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div save-ignore><span id="s">x</span></div><h1>Hi</h1></body>')
  scope.start()
  doc.getElementById('s').textContent = 'changed'
  await tick(40)
  assert.equal(scope.history.length, 0)
  doc.querySelector('h1').textContent = 'changed'
  await tick(40)
  assert.equal(scope.history.length, 1)
})

test('ignoreAttribute predicate skips matching attribute mutations', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="x"></div></body>', {
    ignoreAttribute: (name) => name === 'data-skip',
  })
  scope.start()
  const x = doc.getElementById('x')
  scope.commit('skip', () => x.setAttribute('data-skip', '1'))
  assert.equal(scope.history.length, 0)
  scope.commit('keep', () => x.setAttribute('data-keep', '1'))
  assert.equal(scope.history.length, 1)
})

test('start() twice is a no-op and recording still works once', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.start()
  doc.querySelector('h1').textContent = 'Hello'
  await tick(40)
  assert.equal(scope.history.length, 1)
})

test('stop() disconnects and clears stacks', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  assert.equal(scope.history.length, 1)
  scope.stop()
  assert.equal(scope.history.length, 0)
  assert.equal(scope.canUndo, false)
  doc.querySelector('h1').textContent = 'after stop'
  await tick(40)
  assert.equal(scope.history.length, 0)   // observer disconnected
})

test('clear() empties both stacks', () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  scope.undo()
  assert.equal(scope.canRedo, true)
  scope.clear()
  assert.equal(scope.canUndo, false)
  assert.equal(scope.canRedo, false)
})

test('dedicated events fire after commit, undo, redo, clear', () => {
  const { doc, scope } = mkScope()
  scope.start()
  const seen = []
  const offs = [
    scope.on('commit', () => seen.push('commit')),
    scope.on('undo', () => seen.push('undo')),
    scope.on('redo', () => seen.push('redo')),
    scope.on('clear', () => seen.push('clear')),
  ]
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  scope.undo()
  scope.redo()
  scope.clear()
  assert.deepEqual(seen, ['commit', 'undo', 'redo', 'clear'])
  offs.forEach((off) => off())
  scope.commit('B', () => doc.querySelector('h1').setAttribute('data-b', '1'))
  assert.deepEqual(seen, ['commit', 'undo', 'redo', 'clear'])  // unsubscribed
})

test('change event is no longer emitted', () => {
  const { doc, scope } = mkScope()
  scope.start()
  let changed = 0
  scope.on('change', () => { changed++ })
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  scope.undo()
  assert.equal(changed, 0)
})

test('flush() closes a pending idle batch immediately; no-op when empty', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  doc.querySelector('h1').textContent = 'Pending'
  await tick(5)                  // processed, idle timer still pending
  scope.flush()
  assert.equal(scope.history.length, 1)
  scope.flush()                  // nothing pending → no extra commit
  assert.equal(scope.history.length, 1)
})

test('commit() throws on async fn', () => {
  const { scope } = mkScope()
  scope.start()
  assert.throws(() => scope.commit('X', async () => {}), /must be synchronous/)
})

test('empty commit() does not push a commit', () => {
  const { scope } = mkScope()
  scope.start()
  scope.commit('noop', () => {})
  assert.equal(scope.history.length, 0)
})

// --- Attribute coalescing within a batch (replay correctness) ---

test('attribute added-then-removed within a commit is NOT re-added on undo', () => {
  const { doc, scope } = mkScope()
  scope.start()
  const h1 = doc.querySelector('h1')
  scope.commit('multi', () => {
    h1.textContent = 'Bye'
    h1.setAttribute('data-flag', 'on')     // add
    h1.removeAttribute('data-flag')        // remove → net absent in the batch
  })
  scope.undo()
  assert.equal(h1.textContent, 'Hi')
  assert.equal(h1.hasAttribute('data-flag'), false)   // would be wrongly re-added without coalescing
})

test('attribute toggled to the same value within a commit is NOT deleted on undo', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><h1 data-x="orig">Hi</h1></body>')
  scope.start()
  const h1 = doc.querySelector('h1')
  scope.commit('multi', () => {
    h1.textContent = 'Bye'
    h1.removeAttribute('data-x')           // remove
    h1.setAttribute('data-x', 'orig')      // re-add same value → net no-op
  })
  scope.undo()
  assert.equal(h1.textContent, 'Hi')
  assert.equal(h1.getAttribute('data-x'), 'orig')     // would be wrongly deleted without coalescing
})

test('attribute set twice within a commit undoes back to the original value', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="x" data-v="a"></div></body>')
  scope.start()
  const x = doc.getElementById('x')
  scope.commit('multi', () => {
    x.setAttribute('data-v', 'b')
    x.setAttribute('data-v', 'c')
  })
  assert.equal(x.getAttribute('data-v'), 'c')
  scope.undo()
  assert.equal(x.getAttribute('data-v'), 'a')
})

// --- commit() drains a same-tick pending edit first ---

test('commit() closes a same-tick pending edit as its own Edit before the explicit commit', () => {
  const { doc, scope } = mkScope()
  scope.start()
  const h1 = doc.querySelector('h1')
  h1.textContent = 'Typed'                 // same tick: observer callback not fired yet
  scope.commit('Explicit', () => { h1.setAttribute('data-x', '1') })
  assert.deepEqual(scope.history.map(c => c.label), ['Edit', 'Explicit'])
  scope.undo()                             // undo Explicit only
  assert.equal(h1.getAttribute('data-x'), null)
  assert.equal(h1.textContent, 'Typed')    // prior typing preserved as its own step
  scope.undo()
  assert.equal(h1.textContent, 'Hi')
})

// --- every not-undoable region attribute is load-bearing (legacy + new) ---
// no-save / no-trigger-autosave / freeze are intentionally absent: those regions
// ARE undoable in the capability model. This is the standalone fallback path
// (no window.hyperclay here, so filter.js uses its local marker list).

for (const attr of ['mutations-ignore', 'save-remove', 'save-ignore', 'save-freeze', 'no-undo', 'no-watch']) {
  test(`mutations inside a [${attr}] subtree are skipped`, async () => {
    const { doc, scope } = mkScope(`<!DOCTYPE html><body><div ${attr}><span id="s">x</span></div><h1>Hi</h1></body>`)
    scope.start()
    doc.getElementById('s').textContent = 'changed'
    await tick(40)
    assert.equal(scope.history.length, 0)
    doc.querySelector('h1').textContent = 'changed'
    await tick(40)
    assert.equal(scope.history.length, 1)
  })
}

// no-save / no-trigger-autosave / freeze regions ARE undoable (model: only
// no-undo/no-watch suppress recording). Guards against them creeping into the list.
for (const attr of ['no-save', 'no-trigger-autosave', 'freeze']) {
  test(`mutations inside a [${attr}] subtree ARE recorded (region stays undoable)`, async () => {
    const { doc, scope } = mkScope(`<!DOCTYPE html><body><div ${attr}><span id="s">x</span></div></body>`)
    scope.start()
    doc.getElementById('s').textContent = 'changed'
    await tick(40)
    assert.equal(scope.history.length, 1)
  })
}

// --- robustness ---

test('undo continues past a primitive that throws (best-effort replay)', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="a" data-x="old"></div><p id="b">t</p></body>')
  scope.start()
  const a = doc.getElementById('a')
  const b = doc.getElementById('b')
  scope.commit('Multi', () => {
    a.setAttribute('data-x', 'new')
    b.firstChild.data = 'changed'
  })
  a.setAttribute = () => { throw new Error('boom') }   // poison the reverse of the attr-set
  scope.undo()
  assert.equal(b.firstChild.data, 't')     // the sibling primitive still reverted
  assert.equal(scope.canRedo, true)        // commit still moved to the redo stack
})

test('a throwing ignoreAttribute predicate does not break recording', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="x"></div></body>', {
    ignoreAttribute: () => { throw new Error('boom') },
  })
  scope.start()
  scope.commit('keep', () => doc.getElementById('x').setAttribute('data-keep', '1'))
  assert.equal(scope.history.length, 1)
})

// ----- recordValue: manual recording of observer-invisible property writes -----

function mkInput(opts = {}) {
  const dom = makeDom('<!DOCTYPE html><body><input id="i" value="A" /></body>')
  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20, ...opts })
  return { dom, doc: dom.window.document, scope, input: dom.window.document.getElementById('i') }
}

test('recordValue records one Edit; undo reverts the value, redo re-applies', async () => {
  const { scope, input } = mkInput()
  scope.start()
  input.value = 'AB'                              // a property write — observer sees nothing
  scope.recordValue(input, { oldValue: 'A', newValue: 'AB' })
  await tick(40)
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].label, 'Edit')
  scope.undo()
  assert.equal(input.value, 'A')
  scope.redo()
  assert.equal(input.value, 'AB')
})

test('rapid recordValue on the same input coalesces into ONE step', async () => {
  const { scope, input } = mkInput()
  scope.start()
  input.value = 'AB'; scope.recordValue(input, { oldValue: 'A', newValue: 'AB' })
  input.value = 'ABC'; scope.recordValue(input, { oldValue: 'AB', newValue: 'ABC' })
  await tick(40)
  assert.equal(scope.history.length, 1)
  scope.undo()                                    // one undo walks the whole batch back
  assert.equal(input.value, 'A')
})

test('recordValue with oldValue === newValue records nothing', async () => {
  const { scope, input } = mkInput()
  scope.start()
  scope.recordValue(input, { oldValue: 'A', newValue: 'A' })
  await tick(40)
  assert.equal(scope.history.length, 0)
})

test('record() is a no-op while paused', async () => {
  const { scope, input } = mkInput()
  scope.start()
  scope.pause()
  scope.recordValue(input, { oldValue: 'A', newValue: 'AB' })
  scope.resume()
  await tick(40)
  assert.equal(scope.history.length, 0)
})

test('a recordValue flushes BEFORE a following commitCaptured (ordering preserved)', async () => {
  const { doc, scope, input } = mkInput()
  scope.start()
  input.value = 'AB'
  scope.recordValue(input, { oldValue: 'A', newValue: 'AB' })   // pending idle batch
  await tick(5)                                                  // < idleWindowMs
  scope.pause()
  const p = doc.createElement('p'); p.id = 'added'; doc.body.appendChild(p)
  scope.commitCaptured('Add p')
  scope.resume()
  assert.deepEqual(scope.history.map(c => c.label), ['Edit', 'Add p'])
})

test('recordValue handles a non-default prop (checkbox.checked)', async () => {
  const dom = makeDom('<!DOCTYPE html><body><input id="c" type="checkbox" /></body>')
  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20 })
  const box = dom.window.document.getElementById('c')
  scope.start()
  box.checked = true
  scope.recordValue(box, { prop: 'checked', oldValue: false, newValue: true })
  await tick(40)
  assert.equal(scope.history.length, 1)
  scope.undo()
  assert.equal(box.checked, false)
})
