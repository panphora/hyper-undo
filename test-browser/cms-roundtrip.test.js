import { expect, fixture, html } from '@open-wc/testing'
import { open, close, api } from '../../hypercms/src/hypercms.js'
import Mutation from '../../hyperclayjs/src/utilities/mutation.js'
import { undo } from '../src/index.js'

// Full-stack roundtrip in a real browser: hypercms drives a structural edit,
// window.hyperclay.undo records it via commitWithUndo, undo reverts the page,
// and the CMS refresh mechanism re-syncs the form.
//
// Requires the workspace's sibling packages (hyper-html-api, hyper-morph) to be
// resolvable, plus the hyperclayjs Mutation utility that hypercms's refresh
// observer depends on (window.hyperclay.Mutation). See ./README.md for how to run.

const FIXTURE = html`
  <div id="page">
    <script id="hyper-html-api" data-rules-name="cms" data-rules-version="1" type="application/json">
      { "products": [".product", { "name": ".product-name" }] }
    </script>
    <div id="products">
      <div class="product"><span class="product-name">P1</span></div>
      <div class="product"><span class="product-name">P2</span></div>
    </div>
  </div>`

describe('CMS undo roundtrip', () => {
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

  it('undo of an Add reverts the page and the form re-syncs', async () => {
    open({ pageRoot: page })
    undo.start({ scope: page, bindKeys: false, idleWindowMs: 50 })

    expect(page.querySelectorAll('#products .product').length).to.equal(2)
    api.addItem('products')
    expect(page.querySelectorAll('#products .product').length).to.equal(3)
    expect(undo.history.map((c) => c.label)).to.deep.equal(['Add products'])

    undo.undo()
    expect(page.querySelectorAll('#products .product').length).to.equal(2)
    // The CMS page observer auto-fires cms.refresh() on the undo's page
    // mutation; the form's product cards drop back to two. Wait past the
    // refresh observer's 100ms debounce (installObserver default).
    await new Promise((r) => setTimeout(r, 250))
    expect(document.querySelectorAll('[data-hcms-card]').length).to.equal(2)
  })
})
