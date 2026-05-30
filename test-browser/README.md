# Browser tests

These specs cover the handful of behaviors JSDOM can't simulate honestly: real
`KeyboardEvent` `preventDefault`, real `MutationObserver` timing, focus
restoration on undo, and the livesync two-tab case.

They are written for [`@web/test-runner`](https://modern-web.dev/docs/test-runner/overview/)
with [`@open-wc/testing`](https://open-wc.org/docs/testing/testing-package/).
Those are NOT in `devDependencies` (they pull a full browser launcher), so
install them on demand:

```bash
npm i -D @web/test-runner @open-wc/testing
npx web-test-runner "test-browser/**/*.test.js" --node-resolve --playwright --browsers chromium
```

The node suite (`npm test`) already exercises the recorder against a real
JSDOM `MutationObserver` and the full keyboard matrix. The primary end-to-end
browser verification for this repo is the agent-browser flow against
`LOCAL_APPS/test-apps/hyper-undo-standalone.html` (real Chrome): explicit
commits, multi-step undo/redo, real Cmd+Z / Cmd+Shift+Z, the `.CodeMirror`
bypass, and idle batching were all confirmed there.
