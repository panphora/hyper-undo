# Browser tests

These specs cover the handful of behaviors JSDOM can't simulate honestly: real
`KeyboardEvent` `preventDefault`, real `MutationObserver` timing, focus
restoration on undo, and the livesync two-tab case.

They are written for [`@web/test-runner`](https://modern-web.dev/docs/test-runner/overview/)
with [`@open-wc/testing`](https://open-wc.org/docs/testing/testing-package/), both
now in `devDependencies`. Run them with:

```bash
npm run test:browser        # this suite only
npm run test:all            # node suite + this suite
```

Config lives in `web-test-runner.config.mjs`. Notes on why it's set up that way:

- **Default Chromium launcher** (`@web/test-runner-chrome`) drives the system
  Chrome via puppeteer-core — no browser download, no `--playwright` flag needed.
- **`rootDir` is the workspace root** so `cms-roundtrip.test.js` can import the
  sibling `../../hypercms` and `../../hyperclayjs` packages, and `node-resolve`
  can resolve hypercms's own bare deps (`hyper-html-api`, `hyper-morph`) from
  `hypercms/node_modules`.
- **`concurrency: 1`** because these specs install a single global window-level
  Cmd+Z listener and claim the module-level key-owner singleton; running files
  in parallel makes them race on that one global resource.

`cms-roundtrip.test.js` is a real integration: it loads hypercms + the
hyperclayjs `Mutation` utility (`window.hyperclay.Mutation`, which hypercms's
refresh observer requires) and proves an `Add` → undo round-trips the page and
re-syncs the form.

The node suite (`npm test`) already exercises the recorder against a real
JSDOM `MutationObserver` and the full keyboard matrix. The primary end-to-end
browser verification for this repo is the agent-browser flow against
`LOCAL_APPS/test-apps/hyper-undo-standalone.html` (real Chrome): explicit
commits, multi-step undo/redo, real Cmd+Z / Cmd+Shift+Z, the `.CodeMirror`
bypass, and idle batching were all confirmed there.
