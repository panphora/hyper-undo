// Mirrors hyperclayjs/src/utilities/mutation.js _shouldIgnore exactly.
// Walks the parent chain from `node` and returns true if any ancestor has
// one of the four ignore attributes. `ignoreAttributePredicate` is an optional
// caller-supplied predicate for additional filtering on attribute records.

const IGNORE_ATTRS = ['mutations-ignore', 'save-remove', 'save-ignore', 'save-freeze']

export function shouldIgnore(node, ignoreAttributePredicate, record) {
  // For non-element nodes (like text nodes), start from parent.
  let el = (node && node.nodeType !== 1) ? node.parentElement : node
  while (el && el.nodeType === 1) {
    for (const attr of IGNORE_ATTRS) {
      if (el.hasAttribute && el.hasAttribute(attr)) return true
    }
    el = el.parentElement
  }
  if (ignoreAttributePredicate && record && record.type === 'attributes') {
    try {
      if (ignoreAttributePredicate(record.attributeName, record.target)) return true
    } catch (_) {}
  }
  return false
}
