import { expect, fixture, html } from '@open-wc/testing'
import { undo } from '../src/index.js'

// Real-browser keyboard routing: a synthetic KeyboardEvent dispatched in JSDOM
// can't prove preventDefault swallows the native browser undo. Here we use a
// real Chromium via @web/test-runner.

describe('global Cmd+Z handler', () => {
  afterEach(() => undo.stop())

  it('Cmd+Z undoes and preventDefaults the native browser undo', async () => {
    const root = await fixture(html`<div><h1>Hi</h1></div>`)
    undo.start({ scope: root, bindKeys: true })
    undo.commit('Rename', () => { root.querySelector('h1').textContent = 'Bye' })

    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)

    expect(ev.defaultPrevented).to.equal(true)
    expect(root.querySelector('h1').textContent).to.equal('Hi')
    expect(undo.canRedo).to.equal(true)
  })

  it('Cmd+Z inside a .CodeMirror editor is NOT intercepted', async () => {
    const root = await fixture(html`
      <div>
        <h1>Hi</h1>
        <div class="CodeMirror"><textarea id="cm">code</textarea></div>
      </div>`)
    undo.start({ scope: root, bindKeys: true })
    undo.commit('Rename', () => { root.querySelector('h1').textContent = 'Bye' })

    const cm = root.querySelector('#cm')
    cm.focus()
    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    cm.dispatchEvent(ev)

    expect(ev.defaultPrevented).to.equal(false)            // editor keeps the key
    expect(root.querySelector('h1').textContent).to.equal('Bye')   // page undo did NOT run
  })

  it('Cmd+Shift+Z redoes', async () => {
    const root = await fixture(html`<div><h1>Hi</h1></div>`)
    undo.start({ scope: root, bindKeys: true })
    undo.commit('Rename', () => { root.querySelector('h1').textContent = 'Bye' })
    undo.undo()
    expect(root.querySelector('h1').textContent).to.equal('Hi')

    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)
    expect(root.querySelector('h1').textContent).to.equal('Bye')
  })
})
