import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

function mkScope(html = '<!DOCTYPE html><body><h1>Hi</h1></body>', opts = {}) {
  const dom = makeDom(html)
  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20, ...opts })
  return { doc: dom.window.document, scope }
}

test('explicit commit flushes a pending idle batch first → [Edit, X]', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  doc.querySelector('h1').textContent = 'typed'
  await tick(5)   // processed into idle buffer, not yet closed
  scope.commit('X', () => doc.querySelector('h1').setAttribute('data-x', '1'))
  assert.deepEqual(scope.history.map(c => c.label), ['Edit', 'X'])
})

test('explicit commit on a no-op fn does not push', () => {
  const { scope } = mkScope()
  scope.start()
  scope.commit('noop', () => {})
  assert.equal(scope.history.length, 0)
})

test('a new commit clears the redo stack', () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  scope.undo()
  assert.equal(scope.canRedo, true)
  scope.commit('B', () => doc.querySelector('h1').setAttribute('data-b', '1'))
  assert.equal(scope.canRedo, false)
})

test('an idle batch closing after an undo clears the redo stack', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  scope.commit('A', () => doc.querySelector('h1').setAttribute('data-a', '1'))
  scope.undo()
  assert.equal(scope.canRedo, true)
  doc.querySelector('h1').textContent = 'newtyping'
  await tick(40)
  assert.equal(scope.canRedo, false)
})

test('multiple explicit commits each push one entry, oldest first', () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="x"></div></body>')
  scope.start()
  const x = doc.getElementById('x')
  scope.commit('A', () => x.setAttribute('data-a', '1'))
  scope.commit('B', () => x.setAttribute('data-b', '1'))
  scope.commit('C', () => x.setAttribute('data-c', '1'))
  assert.deepEqual(scope.history.map(c => c.label), ['A', 'B', 'C'])
})

test('typing several characters coalesces into one Edit commit', async () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><p id="p">a</p></body>')
  scope.start()
  const node = doc.getElementById('p').firstChild
  for (const s of ['ab', 'abc', 'abcd', 'abcde']) {
    node.data = s
    await tick(2)   // faster than idleWindowMs so they batch together
  }
  await tick(40)
  assert.equal(scope.history.length, 1)
  assert.equal(scope.history[0].label, 'Edit')
  scope.undo()
  assert.equal(node.data, 'a')   // reverse-replay chains oldValue back to start
})
