# hyper-undo changelog

## [0.6.4] - 2026-10-15

### Changed
- Synced content-dom.js and region-capabilities.js with ClayJS, and updated extension-noise.js

### Fixed
- A select whose selected option is excluded from saving now keeps its selection in the content view (ported from ClayJS)



## [0.6.3] - 2026-10-10

### Fixed
- Cmd+Z inside OverType editors is now handled by the editor's own textarea instead of the global undo



## [Unreleased]

## [0.7.1] - 2026-10-30

### Fixed
- Undo and redo keep changes made inside a subtree that an edit removes: a child moved out of a column that is then removed returns to the column on undo and leaves again on redo.

## [0.7.0] - 2026-10-30

### Added
- Undo and redo can run as explicit commands: a command records only the writes it makes itself, also while a sync apply is paused, keeps an outer pause depth and returns a receipt.
- `isProtected` option, which refuses an undo or redo that would erase protected content.
- `ignoreNode` option, which in automatic mode drops a change record when every node it adds and removes is one you ignore.
- `future` lists the redo stack in history's shape, next first, so a Redo control can name what it replays.
- Discarding an entry emits a `discard` event.
- `describe(entryId)`, which returns an entry, its refusal and every step as plain data, so a refused step can be kept as recovery.

### Changed
- Undo checks a whole entry before changing either stack. Each entry carries a certificate of what it touched, and a step whose target has changed since is refused, with both stacks kept.
- A refused top entry can be discarded, and a failed operation rolls back the ones before it.
- Cmd+Z on a checkbox, radio or button now reaches the page stack. Only fields that take typed text keep the browser's undo.
- A commit's or command's own head writes belong to its entry, and a commit captures the title it changes as one value step.
- A refused step names the nearest ancestor with a `data-id`, so a text step inside an entry is described as that entry.

### Fixed
- Cmd+Z inside an OverType editor is left to the textarea, instead of a page-level undo that only restored its `data-value`.
- The undo guard ignores the attributes the scope ignores on every projected node.
- A body scope fed by a document-wide record source drops records whose target is outside it, so a head write such as `document.title` text never joins an entry, and an explicit `recordValue` title stays the one title step.
- The `ignoreAttribute` predicate receives the host a removed subtree belongs under, so a projection that reads ancestors matches while detached and after restore.
- Redo of a deleted list is no longer refused as content-changed.
- Redo of a multi-node add keeps the nodes in order.
- Redo of an add refuses a reused durable id, descendants included, and the id check skips nodes the replay itself removes.
- Rollback returns a moved node where it was, and scalar steps are judged against the replay's planned attachment.
- A removed node is described by the element that held it, and ignored children stay out of projections.

## [0.6.2] - 2026-10-03

### Fixed
- Cloning now preserves the values of file, checkbox, radio, and option elements



## [0.6.1] - 2026-09-30

### Changed
- The packed contract now loads hyper-undo
- The packed contract is excluded from the published npm package

### Fixed
- A descendant's own region marker is now checked on the element itself (content-dom.js synced from ClayJS)



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
