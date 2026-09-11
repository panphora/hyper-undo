# hyper-undo changelog

## [0.6.0] - 2026-09-11

### Changed
- An undo step only replays while the change it describes still stands



## [0.5.2] - 2026-09-04

### Fixed
- Undo and redo inside a live richclay text region now reach the editor instead of the page. `[data-richclay-active]` joins the default `shadowKeydownIn` list, alongside CodeMirror, Monaco, Ace, Quill, TipTap and ProseMirror. richclay stamps `no-undo` on its region, so the page-level stack holds no record of what was typed there; the capture-phase key handler nevertheless swallowed Cmd+Z, which meant the keystroke never reached the editor's own stack and the page instead reverted an unrelated earlier edit. richclay has always intended this deferral, and this is the other half of it.

## [0.5.1] - 2026-08-21

### Added
- CONTRIBUTING.md stating that contributions are accepted under MIT-0

### Changed
- Relicensed from MIT to MIT-0 (MIT No Attribution); attribution is no longer required
- Node tests now await the scope's next `commit` event (`nextCommit` helper) instead of fixed wall-clock waits, making the suite less timing-sensitive



## [Unreleased]

### Changed
- License: relicensed to MIT-0 (MIT No Attribution). Same rights, attribution no longer required.

## [0.5.0] - 2026-08-12

### Added
- Script to copy the built bundle to clayjs
- `kind`, `status`, and `url` declarations in the hyper key

### Changed
- Platform namespace is now read off `window.clay` in addition to `hyperclay`
- Updated hyper-undo

### Fixed
- Documentation that blocked outside users



## [0.4.0] - 2026-06-16

### Changed
- Integrated the region capability model into hyper-undo
- Adopted a shared MutationObserver in hyper-undo



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
