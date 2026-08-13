// hyper-undo runs under two clients. hyperclayjs publishes window.hyperclay;
// clayjs publishes window.clay. Both reads are dual, clay first, because losing
// either arm is silent: the region delegation falls back to the local marker walk
// and the hub falls back to a private MutationObserver, so nothing throws and
// nothing logs while undo quietly drifts from the platform.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

test('the region resolver is read off window.clay', async () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="off"><span id="s">x</span></div><h1>Hi</h1></body>')
  const doc = dom.window.document
  dom.window.clay = {
    region: {
      resolveRegionPolicy(node) {
        const el = node.nodeType === 1 ? node : node.parentElement
        return { undoable: !(el && el.closest('#off')) }
      },
    },
  }

  const scope = createScope({ scope: doc.body, idleWindowMs: 20 })
  scope.start()

  // #off carries no marker attribute at all, so only the delegated resolver can
  // decide this: the local fallback walk would record it.
  doc.getElementById('s').textContent = 'changed'
  await tick(40)
  assert.equal(scope.history.length, 0)

  doc.querySelector('h1').textContent = 'changed'
  await tick(40)
  assert.equal(scope.history.length, 1)
})

test('the shared-observer hub is read off window.clay', () => {
  const dom = makeDom()
  let created = 0
  dom.window.clay = {
    Mutation: {
      createObserver(handler) {
        created += 1
        return new dom.window.MutationObserver(handler)
      },
    },
  }

  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20 })
  scope.start()

  assert.equal(created, 1)
  scope.stop()
})
