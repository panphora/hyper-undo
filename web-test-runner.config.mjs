import { fileURLToPath } from 'node:url'

// Browser specs run in a real Chromium (default chromeLauncher → system Chrome,
// no download) so they can exercise what JSDOM can't: real KeyboardEvent
// preventDefault routing, real MutationObserver timing, and the cms-roundtrip
// which pulls in the sibling hypercms package.
//
// rootDir is the workspace root so cms-roundtrip.test.js can import
// ../../hypercms/src/hypercms.js and node-resolve hypercms's own bare deps
// (hyper-html-api, hyper-morph) from hypercms/node_modules.
export default {
  rootDir: fileURLToPath(new URL('..', import.meta.url)),
  files: 'test-browser/**/*.test.js',
  nodeResolve: true,
  // These specs install a single global window-level Cmd+Z listener and claim
  // the module-level key-owner singleton, so they must run one file at a time.
  concurrency: 1,
  testFramework: {
    config: { timeout: '10000' },
  },
}
