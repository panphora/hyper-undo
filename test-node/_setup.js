import { JSDOM } from 'jsdom'

// scope.js uses bare `new MutationObserver(...)` and keys.js uses bare `window`.
// Wire the JSDOM realm's classes onto the Node globals so those resolve.
//
// SHIMMED MODE (HYPER_UNDO_SHIMMED=1): run the ENTIRE suite sourcing records
// from hyperclayjs's real single shared observer (window.hyperclay.Mutation)
// instead of a private MutationObserver, exercising the Stage-1 raw lane against
// every existing spec. The specs are byte-identical; only the record source for
// document.body scopes differs (sub-element / created shadow scopes keep a real
// observer either way, matching production). Any divergence between the two
// passes is a drain-semantics bug in mutation.js, never a spec to "fix".
const SHIMMED = !!process.env.HYPER_UNDO_SHIMMED

let hub = null
let region = null
if (SHIMMED) {
  // The hyperclayjs hub module reads document/window at module-eval time, so
  // bootstrap a throwaway realm and suppress its window auto-export before
  // importing it. (We attach it per-realm in makeDom instead.)
  const boot = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { runScripts: 'outside-only' })
  global.MutationObserver = boot.window.MutationObserver
  global.document = boot.window.document
  global.window = boot.window
  global.Node = boot.window.Node
  boot.window.__hyperclayNoAutoExport = true
  const mutationMod = await import('../../hyperclayjs/src/utilities/mutation.js')
  const regionMod = await import('../../hyperclayjs/src/utilities/region-policy.js')
  hub = mutationMod.default
  region = regionMod
}

// Repoint the singleton hub at THIS realm: disconnect its old observer and clear
// per-realm state so the next subscribeRaw (via scope.start()) re-observes here,
// then expose it (and the region resolver, for filter.js's C delegation) on the
// realm's window exactly as the platform does in the browser.
function installHubOnRealm(dom) {
  if (hub._observer) { try { hub._observer.disconnect() } catch (_) {} }
  hub._observer = null
  hub._observing = false
  hub._rawSubscribers.length = 0
  for (const k of Object.keys(hub._callbacks)) hub._callbacks[k].length = 0
  hub._recomputeHasNonPausable()
  hub._pauseDepth = 0
  hub._deferredChangeRecords = null
  hub._deferredChangeScheduled = false
  dom.window.hyperclay = {
    Mutation: hub,
    region: {
      resolveRegionPolicy: region.resolveRegionPolicy,
      isInert: region.isInert,
      skipForPolicy: region.skipForPolicy,
      strictestPolicy: region.strictestPolicy,
      PERSIST: region.PERSIST,
    },
  }
}

export function makeDom(html = '<!DOCTYPE html><html><head></head><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  global.MutationObserver = dom.window.MutationObserver
  global.document = dom.window.document
  global.window = dom.window
  global.Node = dom.window.Node
  if (SHIMMED) installHubOnRealm(dom)
  return dom
}

export function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
