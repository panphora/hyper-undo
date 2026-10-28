// Is the key being pressed inside a native editable control (or an editable
// subtree)? The browser's own undo belongs there, not the page stack's.
const NO_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'])

function ownsNativeUndo(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  const nodes = path.length > 0 ? path : chainFromTarget(event.target)
  for (const node of nodes) {
    if (!node || node.nodeType !== 1) continue
    const tag = String(node.tagName || '').toUpperCase()
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true
    // An input that takes no typed text has no native undo of its own: a checkbox,
    // a radio or a button leaves the key to the page stack.
    if (tag === 'INPUT' && !NO_TEXT_INPUTS.has(String(node.type || node.getAttribute?.('type') || 'text').toLowerCase())) return true
    if (node.isContentEditable === true) return true
    // jsdom (and older engines) do not resolve isContentEditable, so read the
    // declaration itself; an unset or explicit "false" is not editable.
    const declared = node.getAttribute && node.getAttribute('contenteditable')
    if (declared != null && String(declared).toLowerCase() !== 'false') return true
  }
  return false
}

function chainFromTarget(target) {
  const out = []
  for (let node = target; node; node = node.parentNode || (node.host ?? null)) out.push(node)
  return out
}

// Installs a single window-level keydown listener in capture phase.
// Returns a cleanup function.

export function installKeys(scope, onDetached) {
  const handler = (event) => {
    // If the scope root was removed from the document, release the global
    // binding and let native Cmd+Z through instead of undoing a detached tree.
    const scopeEl = scope.scope
    if (scopeEl && scopeEl.nodeType === 1 && scopeEl.isConnected === false) {
      if (onDetached) onDetached()
      return
    }

    // A key the page already handled belongs to whoever handled it.
    if (event.defaultPrevented) return
    // The IME owns keys while it composes.
    if (event.isComposing || event.keyCode === 229) return
    // A plain form control keeps the browser's own text undo. Only the unsent
    // control changes; Save/Enter later commits that text as a page command.
    if (ownsNativeUndo(event)) return

    // Bypass for in-page editors (CodeMirror, Monaco, etc.)
    const target = event.target
    const shadow = scope._config.shadowKeydownIn
    if (target && target.closest && Array.isArray(shadow)) {
      for (const selector of shadow) {
        try { if (target.closest(selector)) return }
        catch (_) { /* invalid selector, skip */ }
      }
    }

    const mod = event.metaKey || event.ctrlKey
    if (!mod) return

    const key = (event.key || '').toLowerCase()

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.undo()
      return
    }
    if (key === 'z' && event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
    if (key === 'y' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation()
      scope.redo()
      return
    }
  }

  window.addEventListener('keydown', handler, true)
  return () => window.removeEventListener('keydown', handler, true)
}
