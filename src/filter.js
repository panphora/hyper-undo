// Decides whether a mutation should be ignored for undo. Mirrors hyperclayjs's
// region capability model: a mutation is ignored when its node sits in a region
// the resolver marks NOT undoable (no-undo / no-watch / the legacy markers /
// browser-extension content), when the record is an extension marker attribute,
// or when the caller's ignoreAttributePredicate rejects it.
//
// When paired with hyperclayjs we delegate the region decision to the SAME
// resolver the platform ships (window.hyperclay.region.resolveRegionPolicy), so
// undo and the platform can never drift. Standalone (no hyperclay on window) we
// fall back to a local marker walk that mirrors the resolver's `undoable` axis.

import { EXTENSION_NODE_SELECTOR, EXTENSION_ATTR_PATTERN } from './extension-noise.js'

// Local fallback: attributes whose region is NOT undoable. The new no-save /
// no-trigger-autosave / freeze are deliberately ABSENT — those regions ARE
// undoable in the capability model; only no-undo / no-watch (and the legacy
// markers, which all imply no-undo) suppress recording.
const IGNORE_ATTRS = ['mutations-ignore', 'save-remove', 'save-ignore', 'save-freeze', 'no-undo', 'no-watch']

function sharedResolver() {
  return (typeof window !== 'undefined' && window.hyperclay && window.hyperclay.region &&
    typeof window.hyperclay.region.resolveRegionPolicy === 'function')
    ? window.hyperclay.region.resolveRegionPolicy
    : null
}

// Is the node in a region that should not be recorded by undo?
function regionNotUndoable(node) {
  const resolve = sharedResolver()
  if (resolve) {
    try { return !resolve(node).undoable }
    catch (_) { /* fall through to the local walk */ }
  }
  let el = (node && node.nodeType !== 1) ? node.parentElement : node
  // Browser-extension injected elements (and their descendants) are not page content.
  if (el && el.closest && el.closest(EXTENSION_NODE_SELECTOR)) return true
  while (el && el.nodeType === 1) {
    for (const attr of IGNORE_ATTRS) {
      if (el.hasAttribute && el.hasAttribute(attr)) return true
    }
    el = el.parentElement
  }
  return false
}

export function shouldIgnore(node, ignoreAttributePredicate, record) {
  if (regionNotUndoable(node)) return true

  if (record && record.type === 'attributes') {
    // Extension marker attributes on a real element (password-manager field tags) are noise.
    if (record.attributeName && EXTENSION_ATTR_PATTERN.test(record.attributeName.toLowerCase())) return true
    if (ignoreAttributePredicate) {
      try {
        if (ignoreAttributePredicate(record.attributeName, record.target)) return true
      } catch (_) {}
    }
  }
  return false
}
