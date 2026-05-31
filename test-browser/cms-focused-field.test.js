import { expect, fixture, html } from '@open-wc/testing'
import { open, close } from '../../hypercms/src/hypercms.js'
import Mutation from '../../hyperclayjs/src/utilities/mutation.js'
import { undo } from '../src/index.js'

// The focused-field re-sync proof (undo-focused-field-resync-plan.md, step 7).
// JSDOM can't honestly model document.activeElement value-protection during a
// morph, so this runs in a real browser: edit a CMS scalar field while it is
// focused, undo, and assert the focused field shows the reverted value (before
// the fix it kept the stale typed value).
//
// Self-contained: wires its own window.hyperclay.Mutation (hypercms's refresh
// observer requires it) and a data-rules-name="cms" tag, so it does not depend
// on the sibling cms-roundtrip fixture.

const FIXTURE = html`
  <div id="page">
    <script data-rules-name="cms" data-rules-version="1" type="application/json">
      { "title": ".title" }
    </script>
    <h1 class="title">Hello</h1>
  </div>`

describe('CMS undo focused-field re-sync', () => {
  let page
  beforeEach(async () => {
    page = await fixture(FIXTURE)
    window.hyperclay = window.hyperclay || {}
    window.hyperclay.undo = undo
    window.hyperclay.Mutation = Mutation
  })
  afterEach(() => {
    try { undo.stop() } catch {}
    try { close() } catch {}
  })

  it('undo while a form field is focused snaps that field to the reverted value', async () => {
    open({ pageRoot: page })
    undo.start({ scope: page, bindKeys: false, idleWindowMs: 50 })

    const sel = '[data-hcms-path="title"] input[data-hcms-field], [data-hcms-path="title"] input'
    const field = document.querySelector(sel)
    expect(field, 'cms scalar field exists').to.exist
    const original = field.value // 'Hello'

    field.focus()
    expect(document.activeElement).to.equal(field)
    field.value = 'EDITED'
    field.dispatchEvent(new Event('input', { bubbles: true })) // commits to the page
    await new Promise((r) => setTimeout(r, 80)) // past idleWindowMs (50)

    // The page DOM reflects the edit, recorded as one undoable Edit commit.
    expect(page.querySelector('.title').textContent).to.equal('EDITED')
    expect(undo.canUndo).to.equal(true)

    undo.undo()
    await new Promise((r) => setTimeout(r, 250)) // past the 100ms observer refresh debounce

    expect(page.querySelector('.title').textContent).to.equal(original) // page reverted
    const after = document.querySelector(sel)
    expect(document.activeElement).to.equal(after) // focus restored
    expect(after.value).to.equal(original) // focused field reverted, not stale
    expect(after.value).to.not.equal('EDITED')
  })
})
