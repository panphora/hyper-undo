# hyper-undo

DOM-state undo/redo for self-editing HTML pages. A single `MutationObserver`
records primitive DOM mutations with computable inverses, batches them into
labelled commits, and replays them backward (undo) or forward (redo). Removed
subtrees are kept **by reference**, so undo restores the same live nodes:
event listeners, focus, scroll position, and custom-attribute wiring all
survive.

Works standalone, or auto-wired into [hyperclayjs](https://github.com/panphora/hyperclayjs)
as `window.hyperclay.undo`.

## Mental model

**The DOM is the state. Undo navigates between DOM states.** Each undoable
operation is a transition recorded as inverse-able primitives, not a full
snapshot. Snapshot-based undo re-clones from serialized HTML and loses live
node identity; mutation-based replay keeps it.

## Install

```bash
npm install hyper-undo
```

```js
import { undo } from 'hyper-undo'

undo.start({ scope: document.body, maxHistory: 100, bindKeys: true })

undo.commit('User edited title', () => {
  document.querySelector('h1').textContent = 'New title'
})

undo.undo()   // restores prior state
undo.redo()   // re-applies the undone state
```

Or load the IIFE bundle directly (auto-attaches to `window.hyperclay.undo`):

```html
<script src="https://cdn.jsdelivr.net/npm/hyper-undo/dist/hyper-undo.min.js"></script>
```

## Via hyperclayjs

The `smooth-sailing` preset includes hyper-undo and auto-starts the singleton on
`document.body` (in edit mode only, with `bindKeys: true`). Cmd+Z works out of
the box.

```html
<script type="module">
  await import('https://cdn.jsdelivr.net/npm/hyperclayjs@1/src/hyperclay.js?preset=smooth-sailing')
  hyperclay.undo.commit('Add product', () => addProduct())
</script>
```

## API

| Call | Effect |
|---|---|
| `undo.start(opts)` | start the singleton on `opts.scope` (default `document.body`) |
| `undo.stop()` | disconnect observer, remove key bindings, clear stacks |
| `undo.commit(label, fn)` | run a synchronous `fn`, push its mutations as one labelled commit |
| `undo.commitCaptured(label)` | drain `observer.takeRecords()` and push as one commit (pause-before / commit-on-success pattern) |
| `undo.discardCaptured()` | drain and throw away the captured records (failure path companion) |
| `undo.flush()` | force-close the current idle batch as its own commit |
| `undo.undo()` / `undo.redo()` | navigate history |
| `undo.clear()` | clear both stacks |
| `undo.pause()` / `undo.resume()` | recorder skips while paused |
| `undo.on('change', fn)` / `undo.off('change', fn)` | subscribe to change events (fires after commit, undo, redo, clear) |
| `undo.canUndo` / `undo.canRedo` | booleans (getters) |
| `undo.history` | `[{ label, timestamp }, ...]`, oldest first; `timestamp` is `Date.now()` millis |
| `undo.isPaused` | boolean (getter) |
| `undo.defaults` | `{ shadowKeydownIn: [...] }` |
| `undo.create(opts)` | a separate scope for advanced multi-scope use |

### Options

| Option | Default | Notes |
|---|---|---|
| `scope` | `document.body` | element to observe |
| `maxHistory` | `100` | older commits drop off the back; dropped commits release their removed-node references |
| `idleWindowMs` | `500` | how long to wait before auto-closing a batch |
| `idleLabel` | `'Edit'` | label for auto-closed batches |
| `bindKeys` | `true` (singleton), `false` (`create`) | install the global Cmd+Z handler |
| `shadowKeydownIn` | code-editor selectors (see below) | when `event.target.closest(selector)` matches, the global handler bails without `preventDefault` |
| `ignoreAttribute` | `null` | predicate `(attrName, element) => boolean`; return true to skip recording that attribute mutation |
| `debug` | `false` | console.log internal state transitions |

## Batching

Raw mutation records are too fine-grained (typing "hello" is five
`characterData` records). Two batching modes share one collector:

- **Explicit commit** — `undo.commit(label, fn)` wraps a synchronous chunk into
  one labelled commit. Throws if `fn()` returns a Promise (mutations after the
  first `await` would silently land in a different commit).
- **Idle auto-batch** — mutations made outside an explicit commit collect until
  the scope is idle for `idleWindowMs`, then close into one `Edit` commit.

## Keyboard shortcuts

`bindKeys: true` installs a `window` keydown capture-phase listener:

| Combo | Action |
|---|---|
| Cmd+Z / Ctrl+Z | undo |
| Cmd+Shift+Z / Ctrl+Shift+Z | redo |
| Cmd+Y / Ctrl+Y | redo (Windows convention) |

### In-page editors

The handler short-circuits (without `preventDefault`) when `event.target` is
inside any selector in `shadowKeydownIn`, so an embedded editor's own keymap
handles the key. The default list covers CodeMirror v5/v6, Monaco, Ace, Quill,
Tiptap, and ProseMirror:

```js
['.CodeMirror', '.cm-editor', '.monaco-editor', '.ace_editor', '.ql-editor', '.tiptap', '.ProseMirror']
```

Extend it for your own editor:

```js
undo.start({ shadowKeydownIn: [...undo.defaults.shadowKeydownIn, '.my-editor'] })
```

Outside the shadow list, the global Cmd+Z intercepts even inside plain
`<input>`/`<textarea>`, so native char-level input-undo no longer fires there.
That's intentional: page-state undo is what users expect for Cmd+Z on a
self-editing page. Pass `bindKeys: false` to opt out entirely and bind your own
handler.

## Filter attributes

A mutation is excluded from recording when its target's ancestor chain contains
any of: `mutations-ignore`, `save-remove`, `save-ignore`, `save-freeze`. These
mirror hyperclayjs's `_shouldIgnore` semantics; no new attribute is introduced.

## Multi-scope (advanced)

```js
const pageUndo = undo.start()                                  // singleton on document.body, owns Cmd+Z
const editorUndo = undo.create({ scope: editorRoot, bindKeys: false })
editorUndo.start()
// editorUndo.undo() / .redo() called manually; Cmd+Z still routes to pageUndo
```

Only one scope can own the global Cmd+Z binding at a time. Calling `start()`
again with a *different* scope throws (use `create` for additional scopes);
calling it again with the *same* scope warns and keeps the original config.

## Form input typing (known gap)

Pure-property `<input>`/`<textarea>` value changes are not `MutationRecord`s, so
raw typing into a field isn't directly observable. Coverage:

- **CMS form fields** flow through the engine, which mutates the page DOM — the
  recorder sees the page mutation. ✓
- **`[persist]` inputs** on a Hyperclay page mirror `el.value` to the `value`
  attribute; **`[persist]` textareas** mirror to `data-value`. The recorder sees
  the attribute mutation. ✓
- **Plain `<input>`/`<textarea>` without `[persist]`** do NOT mirror; their
  typing is invisible to the recorder. ✗

For an unmirrored field, do one of: add `[persist]`, wrap the input handler in
`undo.commit(label, fn)`, or accept that raw typing isn't undoable for that
field.

## What this does NOT do (v1)

No persistence across reloads, no cross-tab sync, no semantic diffs (it records
DOM ops, the label is the only semantic), no collaborative/OT undo, no tracking
of non-DOM state, no "revert to saved" checkpoint.

## License

MIT
