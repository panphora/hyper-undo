import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom } from './_setup.js'
import { installKeys } from '../src/keys.js'

const DEFAULT_SHADOW = ['.CodeMirror', '.cm-editor', '.monaco-editor', '.ace_editor', '.ql-editor', '.tiptap', '.ProseMirror']

function fakeScope() {
  const calls = []
  return {
    calls,
    _config: { shadowKeydownIn: DEFAULT_SHADOW },
    undo() { calls.push('undo') },
    redo() { calls.push('redo') },
  }
}

function press(dom, targetEl, init) {
  const ev = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  targetEl.dispatchEvent(ev)
  return ev
}

test('Cmd+Z calls undo and preventDefaults', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, ['undo'])
  assert.equal(ev.defaultPrevented, true)
  cleanup()
})

test('Ctrl+Z calls undo (non-mac)', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('t'), { key: 'z', ctrlKey: true })
  assert.deepEqual(scope.calls, ['undo'])
  cleanup()
})

test('Cmd+Shift+Z calls redo', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true, shiftKey: true })
  assert.deepEqual(scope.calls, ['redo'])
  cleanup()
})

test('Cmd+Y calls redo (Windows convention)', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('t'), { key: 'y', metaKey: true })
  assert.deepEqual(scope.calls, ['redo'])
  cleanup()
})

test('plain z (no modifier) is ignored', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('t'), { key: 'z' })
  assert.deepEqual(scope.calls, [])
  assert.equal(ev.defaultPrevented, false)
  cleanup()
})

test('target inside .CodeMirror (v5) bypasses the handler', () => {
  const dom = makeDom('<!DOCTYPE html><body><div class="CodeMirror"><input id="cm"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  const ev = press(dom, dom.window.document.getElementById('cm'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [])
  assert.equal(ev.defaultPrevented, false)   // editor's own keymap handles it
  cleanup()
})

test('target inside .cm-editor (CodeMirror v6) bypasses', () => {
  const dom = makeDom('<!DOCTYPE html><body><div class="cm-editor"><span id="cm"></span></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('cm'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [])
  cleanup()
})

test('target inside .ProseMirror bypasses', () => {
  const dom = makeDom('<!DOCTYPE html><body><div class="ProseMirror"><p id="cm">x</p></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('cm'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [])
  cleanup()
})

test('custom selector added to shadowKeydownIn bypasses', () => {
  const dom = makeDom('<!DOCTYPE html><body><div class="my-editor"><input id="cm"></div></body>')
  const scope = fakeScope()
  scope._config.shadowKeydownIn = [...DEFAULT_SHADOW, '.my-editor']
  const cleanup = installKeys(scope)
  press(dom, dom.window.document.getElementById('cm'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [])
  cleanup()
})

test('cleanup removes the listener', () => {
  const dom = makeDom('<!DOCTYPE html><body><div id="t"></div></body>')
  const scope = fakeScope()
  const cleanup = installKeys(scope)
  cleanup()
  press(dom, dom.window.document.getElementById('t'), { key: 'z', metaKey: true })
  assert.deepEqual(scope.calls, [])
})
