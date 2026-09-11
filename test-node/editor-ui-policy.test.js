import assert from 'node:assert/strict'
import test from 'node:test'
import { makeDom } from './_setup.js'
import { shouldIgnore } from '../src/filter.js'

test('standalone filtering recognizes editor-ui and clay token spellings', () => {
  const dom = makeDom('<main><section id="bare" editor-ui><span id="a"></span></section><section clay="editor-ui"><span id="b"></span></section></main>')
  try {
    assert.equal(shouldIgnore(document.getElementById('a')), true)
    assert.equal(shouldIgnore(document.getElementById('b')), true)
  } finally { dom.window.close() }
})

test('policy attribute transitions are delivered even when the final state is excluded', () => {
  const dom = makeDom('<main><section id="target" editor-ui></section></main>')
  try {
    const target = document.getElementById('target')
    assert.equal(shouldIgnore(target, null, { type: 'attributes', attributeName: 'editor-ui', target, oldValue: null }), false)
  } finally { dom.window.close() }
})

test('policy attribute churn wholly inside editor-ui stays ignored', () => {
  const dom = makeDom('<main><section editor-ui><span id="target" no-data></span></section></main>')
  try {
    const target = document.getElementById('target')
    assert.equal(shouldIgnore(target, null, { type: 'attributes', attributeName: 'no-data', target, oldValue: null }), true)
  } finally { dom.window.close() }
})
