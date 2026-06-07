# hyper-undo changelog

## [0.3.0] - 2026-06-07



## 0.2.0 — unreleased

- **BREAKING:** the generic `change` event is removed and replaced by dedicated,
  self-describing events: `undo` and `redo` (fire after a history navigate),
  `commit` (after a new commit), and `clear` (after a reset). The event name is
  the signal; payloads are unchanged (none). Subscribe with
  `undo.on('undo', fn)` etc. A react-to-all consumer subscribes to all four.
  Migration: replace `undo.on('change', fn)` with the specific event(s) you need.

## 0.1.0 — unreleased

Initial release. DOM-state undo/redo via MutationObserver inverse-op replay.

- Single `MutationObserver` per scope records primitive mutations
  (attr-set/add/remove, text, childList add/remove) with computable inverses
- Removed subtrees held by reference — undo restores the same live nodes
  (listeners, focus, scroll, custom-attribute wiring preserved)
- Two batching modes: explicit `commit(label, fn)` and 500ms idle auto-batch
- Pause-before / commit-on-success helpers (`commitCaptured` / `discardCaptured`)
  so a failed apply never leaves a no-op pair on the stack
- Global Cmd+Z / Cmd+Shift+Z / Cmd+Y handler with a configurable
  `shadowKeydownIn` bypass list for in-page code editors
- Reuses hyperclayjs filter-attribute semantics
  (`mutations-ignore` / `save-remove` / `save-ignore` / `save-freeze`)
- Default singleton on `document.body`; `create({ scope })` for multi-scope use
- Max-history eviction (default 100) releases removed-node references
- Standalone npm package + vendor bundle for hyperclayjs (`window.hyperclay.undo`)

### Refinements over the reference plan

Two correctness fixes applied to the locked plan's reference skeletons:

- `commitCaptured(label)` now flushes any pending idle batch BEFORE pushing the
  captured commit. Without this, typing then immediately triggering a structural
  op (before the 500ms idle close) would record the structural commit ahead of
  the typing, inverting undo order.
- `undo.create({ scope })` delegates getters explicitly instead of
  object-spreading the scope instance. Spreading would snapshot `canUndo` /
  `canRedo` / `history` / `isPaused` at create time, freezing them; explicit
  delegation keeps them live.
