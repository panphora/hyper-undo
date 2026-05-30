import { expect, fixture, html } from '@open-wc/testing'
import { undo } from '../src/index.js'

// Livesync pauses the recorder (via the hyperclayjs Mutation.pause bridge)
// before morphing remote HTML in. This proves the core guarantee that bridge
// relies on: mutations made while paused never enter the local undo stack.

describe('livesync pause exclusion', () => {
  afterEach(() => undo.stop())

  it('mutations applied while paused do not pollute the local undo stack', async () => {
    const root = await fixture(html`<div><h1>Local</h1></div>`)
    undo.start({ scope: root, bindKeys: false, idleWindowMs: 50 })

    // Simulate the livesync gate: pause → morph remote content in → resume.
    undo.pause()
    root.querySelector('h1').textContent = 'Remote edit'
    const incoming = document.createElement('p')
    incoming.textContent = 'from another tab'
    root.appendChild(incoming)
    undo.resume()

    await new Promise((r) => setTimeout(r, 80))   // let any idle timer fire
    expect(undo.history.length).to.equal(0)
    expect(undo.canUndo).to.equal(false)
  })

  it('a local edit after a paused remote edit is still recorded', async () => {
    const root = await fixture(html`<div><h1>Local</h1></div>`)
    undo.start({ scope: root, bindKeys: false, idleWindowMs: 50 })
    undo.pause()
    root.querySelector('h1').textContent = 'Remote'
    undo.resume()
    undo.commit('Local edit', () => { root.querySelector('h1').setAttribute('data-local', '1') })
    expect(undo.history.map((c) => c.label)).to.deep.equal(['Local edit'])
  })
})
