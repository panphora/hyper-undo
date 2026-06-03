// Mirrors hyperclayjs/src/utilities/mutation.js _shouldIgnore. Returns true when
// a mutation should be ignored: the node is (or sits inside) a browser-extension
// injected element, an ancestor carries one of the four ignore attributes, or the
// record is an extension marker attribute (e.g. a password-manager field tag).
// `ignoreAttributePredicate` is an optional caller-supplied predicate for
// additional filtering on attribute records.

import { EXTENSION_NODE_SELECTOR, EXTENSION_ATTR_PATTERN } from './extension-noise.js'

const IGNORE_ATTRS = ['mutations-ignore', 'save-remove', 'save-ignore', 'save-freeze']

export function shouldIgnore(node, ignoreAttributePredicate, record) {
  // For non-element nodes (like text nodes), start from parent.
  let el = (node && node.nodeType !== 1) ? node.parentElement : node

  // Browser-extension injected elements (and their descendants) are not page content.
  if (el && el.closest && el.closest(EXTENSION_NODE_SELECTOR)) return true

  while (el && el.nodeType === 1) {
    for (const attr of IGNORE_ATTRS) {
      if (el.hasAttribute && el.hasAttribute(attr)) return true
    }
    el = el.parentElement
  }

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
