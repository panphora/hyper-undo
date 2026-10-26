import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

// A platform hub observes the whole document and hands every record to the body
// scope. A head write, such as document.title replacing <title>'s text, is not a
// change inside the body: it never joins a command's entry or an idle batch. The
// title an entry owns is recorded explicitly with recordValue.

function documentWideHub(win) {
  return {
    createObserver(handler) {
      const observer = new win.MutationObserver(handler)
      return {
        observe() {
          observer.observe(win.document.documentElement, {
            subtree: true, childList: true, attributes: true, characterData: true,
            attributeOldValue: true, characterDataOldValue: true,
          })
        },
        disconnect: () => observer.disconnect(),
        takeRecords: () => observer.takeRecords(),
      }
    },
  }
}

function page() {
  const dom = makeDom('<!DOCTYPE html><html><head><title>Board</title></head><body><h1 id="name">Board</h1></body></html>')
  dom.window.clay = { Mutation: documentWideHub(dom.window) }
  dom.window.hyperclay = undefined
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()
  return { dom, doc, scope }
}

test('a title write inside a command is one value step, and undo and redo restore it', async () => {
  const { doc, scope } = page()
  const name = doc.querySelector('#name')

  scope.command('Rename board', () => {
    const before = doc.title
    name.textContent = 'Roadmap'
    doc.title = 'Roadmap'
    scope.recordValue(doc, { prop: 'title', oldValue: before, newValue: 'Roadmap' })
  })

  assert.deepEqual(scope.history.map((e) => e.label), ['Rename board'])
  const undone = scope.undo()
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(name.textContent, 'Board')
  assert.equal(doc.title, 'Board')
  const redone = scope.redo()
  assert.equal(redone.ok, true, JSON.stringify(redone))
  assert.equal(name.textContent, 'Roadmap')
  assert.equal(doc.title, 'Roadmap')
})

test('a head write alone, in automatic mode, makes no entry', async () => {
  const { doc, scope } = page()
  doc.title = 'Elsewhere'
  const meta = doc.createElement('meta')
  meta.name = 'x'
  doc.head.appendChild(meta)
  await tick(60)
  scope.flush()
  assert.deepEqual(scope.history, [])
})
