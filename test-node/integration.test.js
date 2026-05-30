import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { createScope } from '../src/scope.js'
import { undo as undoSingleton } from '../src/index.js'

test('multi-mutation commit: undo reverts all, redo re-applies all', () => {
  const dom = makeDom('<!DOCTYPE html><body><ul id="list"><li id="a" data-n="1">A</li></ul></body>')
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const list = doc.getElementById('list')
  const a = doc.getElementById('a')
  const before = list.outerHTML

  scope.commit('Multi', () => {
    a.setAttribute('data-n', '2')          // attr-set
    a.firstChild.data = 'AA'               // text
    const li = doc.createElement('li')     // add
    li.id = 'b'
    li.textContent = 'B'
    list.appendChild(li)
  })
  const after = list.outerHTML
  assert.notEqual(after, before)

  scope.undo()
  assert.equal(list.outerHTML, before)     // everything reverted

  scope.redo()
  assert.equal(list.outerHTML, after)      // everything re-applied
})

test('removed subtree restored by reference keeps live state (input value)', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="box"><input id="field"></div></body>')
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  const box = doc.getElementById('box')
  const field = doc.getElementById('field')
  field.value = 'typed-by-user'            // live property, NOT an attribute

  scope.commit('Remove box', () => { box.remove() })
  assert.equal(doc.getElementById('box'), null)

  scope.undo()
  const restored = doc.getElementById('box').querySelector('#field')
  assert.equal(restored, field)            // same node object
  assert.equal(restored.value, 'typed-by-user')   // live value survived
})

test('undo.create returns LIVE getters (not a frozen snapshot)', () => {
  const dom = makeDom('<!DOCTYPE html><body><h1>Hi</h1></body>')
  const doc = dom.window.document
  const editor = undoSingleton.create({ scope: doc.body, bindKeys: false, idleWindowMs: 20 })
  editor.start()
  assert.equal(editor.canUndo, false)
  editor.commit('Edit', () => { doc.querySelector('h1').setAttribute('data-x', '1') })
  assert.equal(editor.canUndo, true)       // would be false if getters were spread-frozen
  assert.equal(editor.history.length, 1)
  editor.undo()
  assert.equal(editor.canUndo, false)
  assert.equal(editor.canRedo, true)
  editor.stop()
})

test('undo.start() twice on the same scope warns and returns the same singleton', () => {
  const dom = makeDom('<!DOCTYPE html><body><h1>Hi</h1></body>')
  const first = undoSingleton.start({ scope: dom.window.document.body, bindKeys: false, idleWindowMs: 20 })
  const origWarn = console.warn
  let warned = false
  console.warn = () => { warned = true }
  const second = undoSingleton.start({ scope: dom.window.document.body, bindKeys: false })
  console.warn = origWarn
  assert.equal(second, first)
  assert.equal(warned, true)
  undoSingleton.stop()
})

test('undo.start() with a different scope throws and points at create()', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="other"></div></body>')
  undoSingleton.start({ scope: dom.window.document.body, bindKeys: false })
  assert.throws(
    () => undoSingleton.start({ scope: dom.window.document.getElementById('other'), bindKeys: false }),
    /different scope|create/,
  )
  undoSingleton.stop()
})

test('undo.stop() then start() yields a fresh working singleton', () => {
  const dom = makeDom('<!DOCTYPE html><body><h1>Hi</h1></body>')
  undoSingleton.start({ scope: dom.window.document.body, bindKeys: false, idleWindowMs: 20 })
  undoSingleton.stop()
  assert.equal(undoSingleton.canUndo, false)
  undoSingleton.start({ scope: dom.window.document.body, bindKeys: false, idleWindowMs: 20 })
  undoSingleton.commit('A', () => dom.window.document.querySelector('h1').setAttribute('data-a', '1'))
  assert.equal(undoSingleton.canUndo, true)
  undoSingleton.stop()
})

test('undo.create scopes are independent of each other', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="one">1</div><div id="two">2</div></body>')
  const doc = dom.window.document
  const sOne = undoSingleton.create({ scope: doc.getElementById('one'), bindKeys: false, idleWindowMs: 20 })
  const sTwo = undoSingleton.create({ scope: doc.getElementById('two'), bindKeys: false, idleWindowMs: 20 })
  sOne.start(); sTwo.start()
  sOne.commit('one-edit', () => { doc.getElementById('one').setAttribute('data-x', '1') })
  assert.equal(sOne.canUndo, true)
  assert.equal(sTwo.canUndo, false)        // independent history
  sOne.stop(); sTwo.stop()
})
