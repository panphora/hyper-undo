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
| `undo.command(label, fn)` | run a synchronous `fn` and push only its own writes as one labelled entry; returns `{ id, label }`, or `null` when it wrote nothing |
| `undo.setRecording(mode)` | `'automatic'` (default) or `'commands'`; see [Recording modes](#recording-modes) |
| `undo.undo()` / `undo.redo()` | navigate history; each returns a receipt, `{ ok: true, entryId, label, direction }` or `{ ok: false, code, entryId, label, direction }`. `undo({ entryId })` and `redo({ entryId })` replay only while that entry is the next one, and refuse `stale-entry` otherwise |
| `undo.discard(entryId)` | drop the refused top entry, and only that one: `{ ok: true, entryId, direction }`, or `{ ok: false, code: 'not-refused' }` |
| `undo.clear()` | clear both stacks |
| `undo.pause()` / `undo.resume()` | recorder skips while paused |
| `undo.on('undo'\|'redo'\|'commit'\|'refused'\|'discard'\|'clear', fn)` / `undo.off(...)` | subscribe to lifecycle events; `undo`/`redo` fire after a navigate with the receipt, `refused` with `{ entryId, label, direction, code, targets }`, `commit` after a new commit, `discard` with `{ entryId, label, direction }`, `clear` after a reset. (No generic `change` event.) |
| `undo.canUndo` / `undo.canRedo` | booleans (getters) |
| `undo.history` | `[{ id, label, timestamp }, ...]`, oldest first; `timestamp` is `Date.now()` millis. The entry that was just refused also carries `refused: { direction, code, targets }` |
| `undo.future` | the redo stack in the same shape, next redo first |
| `undo.describe(entryId)` | JSON-safe description of what an entry changes, built from its certificate (`null` for an unknown id or an unreplayable entry); see [Refusals](#refusals) |
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
| `ignoreAttribute` | `null` | predicate `(attrName, element) => boolean`; return true to skip recording that attribute mutation, and the certificate's projection skips it too, so such a change never refuses a later undo or redo. |
| `isProtected` | `null` | predicate `(node) => boolean`; return true for content that no undo or redo may erase, and an operation that would remove or replace a subtree containing such a node is refused with code `"protected"`. |
| `ignoreNode` | `null` | predicate `(node) => boolean`; in automatic mode a `childList` record whose every added and removed node it accepts is not recorded, so a gesture's own repeated moves leave no generic entry beside the one the consumer records with `command`, and such a node is left out of a bracketed entry's added and removed lists too. |
| `debug` | `false` | console.log internal state transitions |

## Batching

Raw mutation records are too fine-grained (typing "hello" is five
`characterData` records). Two batching modes share one collector:

- **Explicit commit** — `undo.commit(label, fn)` wraps a synchronous chunk into
  one labelled commit. Throws if `fn()` returns a Promise (mutations after the
  first `await` would silently land in a different commit).
- **Idle auto-batch** — mutations made outside an explicit commit collect until
  the scope is idle for `idleWindowMs`, then close into one `Edit` commit.

## Recording modes

`automatic`, the default, records every observed mutation and closes an idle batch into one `Edit` entry. `commands` records nothing on its own: only the writes a `command(label, fn)` (or `commit`) brackets become entries, so a merge, a derived repaint, a local command's own bookkeeping, or a callback that writes after its `await` never appears in the history. The document still changes for all of them, and a later undo sees those changes.

```js
undo.setRecording('commands')
const entry = undo.command('Add card', () => list.append(card))   // { id, label } | null
undo.setRecording('automatic')
```

`setRecording` accepts only `'automatic'` and `'commands'` and throws for anything else; it also throws while a command is running. The switch is a commit boundary, never a merge: work already recorded keeps its own entry, and nothing recorded after the switch joins it. A `command` is synchronous, never runs inside another command, and refuses a callback declared `async` or one that returns a promise.

## Refusals

Undo and redo preflight the whole entry against the live DOM without writing, and apply it only when every step still matches, so a refusal changes neither the document nor either stack:

```js
undo.undo()   // { ok: true, entryId, label, direction }
              // { ok: false, code, entryId, label, direction }
```

| Code | What changed since the entry was recorded |
|---|---|
| `content-changed` | an attribute, a text run, or the saved content of a subtree the step would erase is not what the step recorded |
| `structure-changed` | the children of a list the step edits are not in the order it recorded, or a node it would place is still attached elsewhere |
| `target-detached` | the element or list the step addresses is no longer in the scope |
| `duplicate-id` | restoring a removed subtree would bring back a `data-id` a live node already carries |
| `protected` | the step would erase a subtree containing a node `isProtected` accepts |
| `unsupported` | the step holds a shape replay cannot address or verify |
| `stale-entry` | `undo({ entryId })` named an entry that is not on top of its stack |
| `replay-error` | a native write failed mid-apply; the entry is rolled back and `replay-error` is the code |
| `empty` | nothing to replay on that stack |

A refused entry keeps its place on top, and `undo.history` (or `undo.future`) shows `refused: { direction, code, targets }` on it, so nothing is lost and nothing is silently skipped. `undo.discard(entryId)` drops exactly that entry and leaves the document and every other entry as they are.

`targets` is one `{ id, kind }` per node the refused step addresses. `id` is the nearest `[data-id]` ancestor, so a text step with no id of its own names the record it was typed in, and `null` when nothing in the ancestor chain carries one; `kind` says what the target was to the step (`added`, `removed`, `move`, `protected`, or the attribute or property name of a value step). The receipt's own `targets` are on the `refused` event and the history entry, so a consumer can name the record a refusal is about without asking the engine again.

## Describing an entry

`undo.describe(entryId)` is the plain, serializable description of one entry, built from its certificate: nothing in it is a live node, so a caller can store it. It answers `null` for an unknown id or an entry whose certificate could not be compiled, and otherwise:

```js
{
  id, label, timestamp,
  refused: { direction, code, targets } | null,   // only for the entry just refused
  steps: [ /* one per step, in recorded order */ ],
}
```

A `move` step is `{ kind: 'move', node: { id }, from: { id }, to: { id } }`; an added or removed subtree is `{ kind: 'add' | 'remove', parent: { id }, nodes: [{ id, html }] }`, where `html` is the recorded markup; a value, text or attribute step is `{ kind: 'value' | 'text' | 'attribute', target: { id }, prop?, name?, before, after }`. Every nested `id` follows the same nearest-`[data-id]` rule as a refusal target.

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

### Plain form controls own their undo

The handler also returns without `preventDefault` when the key event's composed
path holds an `input`, a `textarea`, a `select`, or a `contenteditable` subtree
(declared or resolved, so jsdom works), when the event is an IME composition or
carries `keyCode` 229, and when another handler already called
`preventDefault`. Both Cmd+Z and Cmd+Shift+Z follow that rule.

So a plain field keeps the browser's own character-level undo, and the page
stack never undoes inside it. Typing that is not written into an attribute
records nothing: the page's Cmd+Z history starts at the write a commit or a
`command` makes of that text. Pass `bindKeys: false` to opt out entirely and
bind your own handler.

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
- **`[persist]` inputs** on a Hyperclay™ page mirror `el.value` to the `value`
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

MIT-0 (MIT No Attribution).
