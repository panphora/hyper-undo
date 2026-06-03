import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'
import { EXTENSION_NODE_SELECTORS, EXTENSION_ATTR_PATTERN } from '../src/extension-noise.js'

function mkScope(html = '<!DOCTYPE html><body><h1>Hi</h1></body>', opts = {}) {
  const dom = makeDom(html)
  const scope = createScope({ scope: dom.window.document.body, idleWindowMs: 20, ...opts })
  return { dom, doc: dom.window.document, scope }
}

test('an injected extension element records no undo step (childList add + its attr mutations)', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  const ext = doc.createElement('div')
  ext.id = '1p-menu-live-region'        // the exact node A2-2 observed 1Password injecting
  doc.body.appendChild(ext)
  await tick(40)
  ext.setAttribute('aria-live', 'assertive')   // its own attribute churn must also be ignored
  await tick(40)
  assert.equal(scope.history.length, 0)
})

test('a Grammarly custom element is ignored', async () => {
  const { doc, scope } = mkScope()
  scope.start()
  doc.body.appendChild(doc.createElement('grammarly-extension'))
  await tick(40)
  assert.equal(scope.history.length, 0)
})

test('a password-manager marker attribute on a REAL input records nothing, and the input survives', async () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><input id="email"></body>')
  scope.start()
  const input = doc.getElementById('email')
  input.setAttribute('data-bitwarden-watching', '1')   // annotation on the user's real field
  await tick(40)
  assert.equal(scope.history.length, 0)
  assert.ok(doc.getElementById('email'), 'the real input must not be touched')
})

test('control: a normal element insert still records (no over-broadening)', async () => {
  const { doc, scope } = mkScope('<!DOCTYPE html><body><div id="real"></div></body>')
  scope.start()
  doc.getElementById('real').appendChild(doc.createElement('p'))
  await tick(40)
  assert.equal(scope.history.length, 1)
})

test('the attribute boundary matches injected markers but not same-prefix or author-control attributes', () => {
  // `data-lt` (LanguageTool) must not swallow `data-ltr`, a plausible app attribute.
  assert.equal(EXTENSION_ATTR_PATTERN.test('data-lt-foo'), true)
  assert.equal(EXTENSION_ATTR_PATTERN.test('data-lt'), true)
  assert.equal(EXTENSION_ATTR_PATTERN.test('data-ltr'), false)
  // 1Password's runtime fill marker is stripped.
  assert.equal(EXTENSION_ATTR_PATTERN.test('data-com-onepassword-filled'), true)
  // `data-lpignore` is an AUTHOR-set LastPass opt-out — the boundary preserves it.
  assert.equal(EXTENSION_ATTR_PATTERN.test('data-lpignore'), false)
})

test('the node list still carries the load-bearing entries (regression lock)', () => {
  for (const sel of ['[id="1p-menu-live-region"]', 'grammarly-extension', '[src^="chrome-extension://"]']) {
    assert.ok(EXTENSION_NODE_SELECTORS.includes(sel), `missing ${sel}`)
  }
})
