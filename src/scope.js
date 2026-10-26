import { recordsToPrimitives } from './primitives.js'
import { compileCertificate, preflight, applyOperations, described } from './replay-plan.js'
import { shouldIgnore } from './filter.js'
import { createEmitter } from './emitter.js'

const DEFAULTS = {
  maxHistory: 100,
  idleWindowMs: 500,
  idleLabel: 'Edit',
  recording: 'automatic',
  ignoreAttribute: null,
  isProtected: null,
  ignoreNode: null,
  debug: false,
}

export function createScope(opts) {
  const config = { ...DEFAULTS, ...opts }
  if (!config.scope) throw new Error('hyper-undo: scope is required')

  const emitter = createEmitter()
  const undoStack = []        // [{ id, label, timestamp, primitives, certificate }]
  const redoStack = []        // same shape
  const entryPrefix = `u${Math.random().toString(36).slice(2, 8)}`
  let entryCount = 0
  let refusedTop = null       // { entryId, direction, code, targets } for the top entry
  let pendingPrimitives = []  // primitives collected since last commit
  let idleTimer = null
  let observer = null
  let pauseDepth = 0       // reference-counted; recording is active only at 0
  let started = false
  let recordingMode = config.recording === 'commands' ? 'commands' : 'automatic'
  let capture = null       // { records, primitives } while an explicit command runs
  let replaying = false    // true only inside an undo/redo preflight and apply

  function log(...args) { if (config.debug) console.log('[hyper-undo]', ...args) }

  // --- Lifecycle ---

  function start() {
    if (started) return
    started = true
    observer = createRecordSource(handleRecords)
    observer.observe(config.scope, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
      attributeOldValue: true,
      characterDataOldValue: true,
    })
    log('started')
  }

  // Choose the record source ONCE. Paired with hyperclayjs AND watching the
  // document.body singleton, source records from the platform's single shared
  // observer (Mutation.createObserver) so the page runs ONE MutationObserver.
  // Otherwise — standalone, or a created shadow/CodeMirror scope — use a real
  // MutationObserver. The result is duck-typed: only observe / disconnect /
  // takeRecords are touched, and the shared hub observes with options identical
  // to the ones above, so nothing here needs to change between the two paths.
  function createRecordSource(handler) {
    const isBodySingleton = typeof document !== 'undefined' && config.scope === document.body
    const hub = (typeof window !== 'undefined' &&
      (window.clay?.Mutation || window.hyperclay?.Mutation)) || null
    if (isBodySingleton && hub && typeof hub.createObserver === 'function') {
      log('sourcing records from the platform Mutation hub (shared observer)')
      return hub.createObserver(handler)
    }
    return new MutationObserver(handler)
  }

  function stop() {
    if (!started) return
    started = false
    if (observer) { observer.disconnect(); observer = null }
    clearIdleTimer()
    undoStack.length = 0
    redoStack.length = 0
    pendingPrimitives = []
    refusedTop = null
    capture = null
    replaying = false
    pauseDepth = 0   // reset so a reused (created) scope doesn't restart paused
    log('stopped')
  }

  // The plan requires a scope whose root has been removed from the document to
  // stop itself with its stack cleared. Detected lazily at the next undo/redo
  // (and at the key handler in keys.js) rather than via a polling timer.
  function scopeDisconnected() {
    const el = config.scope
    return !!(el && el.nodeType === 1 && el.isConnected === false)
  }

  // --- Observer callback ---

  // The record source's callback. It hands over its own instance as a second
  // argument, so the bracket flag is passed through collectRecords instead.
  function handleRecords(records) {
    collectRecords(records, false)
  }

  // `bracketed` marks records a commit's or a command's own callback wrote.
  function collectRecords(records, bracketed) {
    // While paused, these callback-delivered records are DROPPED — they have
    // already left the observer's buffer, so they're gone. resume()'s
    // takeRecords() separately purges only the remainder that was never
    // delivered. Those two halves together are the pause contract, and the
    // shimmed (paired) path reproduces both.
    if (capture) {
      for (const record of records) capture.records.push(record)
      return
    }
    // Commands mode: an unbracketed record is some other writer's (a merge, a
    // sap paint, a sortable gesture). It changes the document, so later guards
    // see it, but it is not a local action and earns no entry.
    if (recordingMode === 'commands') return
    if (pauseDepth > 0) return
    const prims = convertRecords(dropIgnoredRecords(records), bracketed)
    if (prims.length > 0) {
      for (const p of prims) pendingPrimitives.push(p)
      restartIdleTimer()
    }
  }

  // A gesture can move its own node many times while a command is still open
  // (dragover, touchmove). In automatic mode each of those childList records
  // would join the idle batch and leave a generic entry beside the one semantic
  // move the consumer records with command(). Drop a childList record whose
  // every added and removed node the caller ignores, so it also never restarts
  // the idle window; a record that also touches any other node is kept whole.
  // Command brackets bypass this: they record what they bracket.
  function dropIgnoredRecords(records) {
    if (typeof config.ignoreNode !== 'function') return records
    return records.filter((record) => {
      if (record.type !== 'childList') return true
      const touched = [...record.addedNodes, ...record.removedNodes]
      if (touched.length === 0) return true
      return !touched.every((node) => ignoresNode(node))
    })
  }

  function ignoresNode(node) {
    try { return !!config.ignoreNode(node) } catch (_) { return false }
  }

  // Filter ignored records, then coalesce same-attribute repeats within the batch.
  // A shared record source observes the whole document, so an idle record whose
  // target sits outside this scope (a head write such as document.title's text) is
  // some other region's change and never part of an entry here; a title an entry
  // owns is recorded explicitly with recordValue. A bracketed record — one a
  // commit's or a command's own callback wrote — is the caller's declaration that
  // what it wrote there is one entry, so it may own the scope document's head
  // fields too; head's <title> stays with the bracket's own title capture.
  function convertRecords(records, bracketed = false) {
    const kept = records.filter((r) => (observedHere(r.target) || (bracketed && inHead(r.target))) && !shouldIgnore(r.target, config.ignoreAttribute, r))
    return recordsToPrimitives(kept, (node) => shouldIgnore(node, config.ignoreAttribute))
  }

  // --- Idle batching ---

  function restartIdleTimer() {
    clearIdleTimer()
    idleTimer = setTimeout(closeIdleBatch, config.idleWindowMs)
  }
  function clearIdleTimer() {
    if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null }
  }
  function closeIdleBatch() {
    idleTimer = null
    if (pendingPrimitives.length === 0) return
    const primitives = pendingPrimitives
    pendingPrimitives = []
    pushCommit(config.idleLabel, primitives)
  }

  // --- Commit machinery ---

  function pushCommit(label, primitives) {
    const certificate = compileCertificate(primitives, { isIgnored: isIgnoredNode, ignoreAttribute: isIgnoredAttribute })
    if (certificate.steps.length === 0) {
      log('commit', label, 'with nothing to record')
      emitter.emit('commit')
      return null
    }
    const entry = { id: `${entryPrefix}-${++entryCount}`, label, timestamp: Date.now(), primitives, certificate }
    undoStack.push(entry)
    redoStack.length = 0
    refusedTop = null
    while (undoStack.length > config.maxHistory) undoStack.shift()
    log('commit', label, 'primitives:', primitives.length)
    emitter.emit('commit')
    return entry
  }

  function isIgnoredNode(node) {
    return shouldIgnore(node, config.ignoreAttribute)
  }

  // The same predicate the recorder uses, asked about an attribute the
  // certificate is projecting rather than about a live record.
  // `host` is the parent a removed subtree belongs under (see durableProjection).
  function isIgnoredAttribute(name, node, host = null) {
    if (typeof config.ignoreAttribute !== 'function') return false
    try { return !!config.ignoreAttribute(name, node, host) } catch (_) { return false }
  }

  function isProtectedNode(node) {
    if (typeof config.isProtected !== 'function') return false
    try { return !!config.isProtected(node) } catch (_) { return false }
  }

  // Explicit commit: caller-driven, synchronous fn.
  function commit(label, fn) {
    if (!started) throw new Error('hyper-undo: scope not started')
    // Only automatic IDLE collection is off in commands mode: commit stays an
    // explicit boundary, and an outer exclusion pause still excludes it.
    if (recordingMode === 'commands') return runCapture(label, fn, { honorPause: true, receipt: false })
    // Drain anything already buffered from this same synchronous tick (e.g.
    // typing whose observer callback hasn't fired yet) into pending, THEN close
    // it as its own batch — so the explicit commit starts clean and prior work
    // isn't swallowed under this label.
    handleRecords(observer.takeRecords())
    flush()
    // A commit brackets fn the way a command does, so the document title it
    // changes is one value step of this entry (and head's <title> text is left to
    // that capture, never a second record beside it).
    const titleBefore = pauseDepth === 0 ? titleValue() : null
    const result = fn()
    if (result && typeof result.then === 'function') {
      throw new Error('hyper-undo: commit() fn must be synchronous; returned a Promise')
    }
    // Drain records the observer hasn't fired callback for yet. They are this
    // commit's own bracket, so what fn wrote in the document's head joins it.
    collectRecords(observer.takeRecords(), true)
    if (titleBefore != null) recordTitleChange(titleBefore)
    if (pendingPrimitives.length === 0) {
      emitter.emit('commit')
      return
    }
    clearIdleTimer()
    const primitives = pendingPrimitives
    pendingPrimitives = []
    pushCommit(label, primitives)
  }

  // Pause-before / commit-on-success pattern used by hypercms.
  // Caller: pause() → run code → commitCaptured(label) on success / discardCaptured() on failure → resume().
  function commitCaptured(label) {
    if (!started) throw new Error('hyper-undo: scope not started')
    if (!observer) return
    // If an OUTER pause is still active (this capture frame is nested inside an
    // exclusion pause), honor the outer "exclude everything" contract: discard
    // the captured records instead of committing through the outer pause.
    if (pauseDepth > 1) { observer.takeRecords(); return }
    // Close any pending idle batch (e.g. in-progress typing captured BEFORE the
    // pause) as its own commit FIRST, so the structural commit we're about to
    // push lands AFTER it in history. Without this, type-then-immediately-add
    // would record the structural op before the typing, inverting undo order.
    flush()
    const primitives = convertRecords(observer.takeRecords(), true)
    if (primitives.length === 0) return
    clearIdleTimer()
    pushCommit(label, primitives)
  }

  function discardCaptured() {
    if (observer) observer.takeRecords()
  }

  // --- Explicit commands ---

  // document.title lives in <head>, outside the body the observer watches, so a
  // command records it from its own bracket and addresses head's <title> element
  // directly. The document is the SCOPE's, never the module-global one: a scope
  // bound to another realm must not read or write this page's title.
  function scopeDocument() {
    const root = config.scope
    return (root && root.ownerDocument) || (typeof document !== 'undefined' ? document : null)
  }

  function titleNode() {
    const doc = scopeDocument()
    if (!doc || !doc.head || typeof doc.head.querySelector !== 'function') return null
    return doc.head.querySelector('title')
  }

  function titleValue() {
    const node = titleNode()
    return node ? node.textContent : null
  }

  function recordTitleChange(before) {
    const node = titleNode()
    if (!node || before == null) return
    const after = node.textContent
    if (after === before) return
    capturePrimitive({ kind: 'value', target: node, prop: 'textContent', oldValue: before, newValue: after })
  }

  // A caller records document.title explicitly (recordValue(document, { prop: 'title' })).
  // Redirect that write onto the live <title> element so it shares one target and
  // one certificate entry with the command's own title capture.
  function normalizeRecordedPrimitive(primitive) {
    if (!primitive) return null
    const doc = scopeDocument()
    if (!doc || primitive.target !== doc || primitive.prop !== 'title') return primitive
    const node = titleNode()
    if (!node) return null
    return { kind: 'value', target: node, prop: 'textContent', oldValue: primitive.oldValue, newValue: primitive.newValue }
  }

  function inEffectContext() {
    if (typeof window === 'undefined') return false
    const effect = window.clay?.effect || window.hyperclay?.effect
    return !!(effect && effect.running)
  }

  function openCapture() {
    // Everything that happened before the command goes through its ordinary
    // classification first: automatic work becomes its own idle entry, and in
    // commands mode an unbracketed record is dropped as usual. Then preceding
    // local work is closed, so the command starts from a fresh buffer.
    if (observer) handleRecords(observer.takeRecords())
    flush()
    capture = { records: [], primitives: [] }
  }

  function closeCapture() {
    const held = capture
    capture = null
    if (!held) return []
    const primitives = convertRecords(held.records, true)
    for (const p of held.primitives) primitives.push(p)
    return primitives
  }

  // One synchronous bracket around a caller's authored writes. Deliberately
  // records only what happens inside the callback, so a local command during a
  // long sync pause is captured while the surrounding merge writes are not. The
  // outer pause depth is never touched: no part of the hub is resumed.
  function runCapture(label, fn, { honorPause, receipt }) {
    if (typeof fn !== 'function') throw new Error('hyper-undo: command() needs a synchronous function')
    if (capture) throw new Error('hyper-undo: command() cannot nest inside another command')
    if (replaying) throw new Error('hyper-undo: command() cannot run during undo or redo')
    if (inEffectContext()) throw new Error('hyper-undo: command() cannot run inside a derived-effect context')
    if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
      throw new Error('hyper-undo: command() fn must be synchronous; it was declared async')
    }
    const discarded = honorPause && pauseDepth > 0
    const titleBefore = discarded ? null : titleValue()
    openCapture()
    let primitives = []
    let failure = null
    let result
    try {
      try {
        result = fn()
      } catch (error) {
        failure = error
      }
      if (observer) handleRecords(observer.takeRecords())
      if (result && typeof result.then === 'function') {
        // Never extend the capture across the await; just keep the rejection
        // from surfacing as an unhandled one.
        try { result.then(undefined, () => {}) } catch (_) {}
        if (!failure) failure = new Error('hyper-undo: command() fn must be synchronous; returned a Promise')
      }
      if (!discarded) recordTitleChange(titleBefore)
    } finally {
      primitives = closeCapture()
    }
    // A callback that wrote and then failed keeps its observed writes as an
    // interrupted entry: the DOM already changed and dropping it would leave
    // unexplained content with no way back.
    const entry = discarded || primitives.length === 0 ? null : pushCommit(label, primitives)
    if (failure) throw failure
    if (!receipt) return entry
    return entry ? { id: entry.id, label: entry.label } : null
  }

  // Explicit local command: one label, one entry, only its own synchronous
  // writes. Returns null for a no-op and { id, label } otherwise.
  function command(label, fn) {
    if (!started) throw new Error('hyper-undo: scope not started')
    return runCapture(label, fn, { honorPause: false, receipt: true })
  }

  // Automatic (default) keeps idle batches for every consumer that records by
  // watching the document; commands mode records only explicit commands.
  function setRecording(mode) {
    if (mode !== 'automatic' && mode !== 'commands') {
      throw new Error("hyper-undo: setRecording() takes 'automatic' or 'commands'")
    }
    if (capture) throw new Error('hyper-undo: setRecording() cannot change while a command is running')
    if (recordingMode === mode) return recordingMode
    // Work already recorded keeps its own entry: the switch is a commit
    // boundary, never a silent merge into the next command.
    flush()
    recordingMode = mode
    log('recording', mode)
    return recordingMode
  }

  // --- Manual recording (for changes the observer can't see) ---

  // Record a primitive the MutationObserver never delivers — an element PROPERTY
  // write (input.value, checkbox.checked) fires no MutationRecord. The primitive
  // joins the same idle batch as observed edits, so rapid same-field property
  // writes coalesce into one commit exactly like text edits do. Inside a command
  // the write joins that command's entry; outside one it is a no-op while
  // stopped, paused or in commands mode.
  function record(primitive) {
    if (!started || !primitive) return
    // Inside a command the capture owns the write, even under an outer pause.
    // Outside one, commands mode records nothing and an exclusion pause still
    // excludes.
    if (!capture && (pauseDepth > 0 || recordingMode === 'commands')) return
    const normalized = normalizeRecordedPrimitive(primitive)
    if (!normalized) return
    capturePrimitive(normalized)
  }

  function capturePrimitive(primitive) {
    if (capture) { capture.primitives.push(primitive); return }
    pendingPrimitives.push(primitive)
    restartIdleTimer()
  }

  // Convenience for the common case: a value/checked property write on an element.
  function recordValue(target, { prop = 'value', oldValue, newValue, read, write } = {}) {
    if (!target || oldValue === newValue) return
    record({ kind: 'value', target, prop, oldValue, newValue, read, write })
  }

  // Force-close current idle batch as its own commit. Used by undo()/redo() and
  // by the save seam (snapshot.js calls undo.flush() before cloning).
  function flush() {
    // Drain same-tick records the observer hasn't delivered yet so the batch
    // boundary is correct (e.g. a synchronous save right after a DOM edit).
    // Skip while paused — the paused caller (commitCaptured) drains the buffer
    // itself, and draining here would route those records through the
    // early-returning handleRecords and lose them.
    if (pauseDepth === 0 && observer) handleRecords(observer.takeRecords())
    if (pendingPrimitives.length === 0) return
    clearIdleTimer()
    closeIdleBatch()
  }

  // --- Pause/resume ---

  // Reference-counted so nested pauses (e.g. a hypercms commit wrapping a
  // live-sync morph that also pauses) only resume on the outermost release.
  function pause() {
    // On the outermost pause, drain anything already buffered from this same
    // synchronous tick into pending FIRST, while still unpaused, so a pre-pause
    // edit isn't swallowed into the captured/structural batch that follows.
    if (pauseDepth === 0 && observer) handleRecords(observer.takeRecords())
    pauseDepth++
    log('paused', pauseDepth)
  }
  function resume() {
    if (pauseDepth === 0) return  // underflow guard
    pauseDepth--
    // Discard records captured during the pause only on the outermost release.
    if (pauseDepth === 0 && observer) observer.takeRecords()
    log('resumed', pauseDepth)
  }

  // --- Undo/redo ---

  // One entry is applied whole or not at all. Preflight compares the certificate
  // against the live document without writing; only a fully validated plan
  // reaches the DOM, and a native failure rolls it back and keeps both stacks.
  function replay(direction, requestedId) {
    if (scopeDisconnected()) { stop(); return { ok: false, code: 'disconnected' } }
    flush()
    const source = direction === 'undo' ? undoStack : redoStack
    const destination = direction === 'undo' ? redoStack : undoStack
    const entry = source.at(-1)
    if (!entry) return { ok: false, code: 'empty' }
    if (requestedId && requestedId !== entry.id) {
      const requested = findEntry(requestedId) || entry
      return refuse(requested, direction, 'stale-entry')
    }
    let checked
    replaying = true
    try {
      checked = preflight(entry.certificate, direction, {
        isIgnored: isIgnoredNode,
        ignoreAttribute: isIgnoredAttribute,
        isProtected: isProtectedNode,
        inScope,
        liveNodesWithIds,
      })
    } finally {
      replaying = false
    }
    if (!checked.ok) return refuse(entry, direction, checked.code, checked.targets)
    pause()
    let applied
    replaying = true
    try {
      applied = applyOperations(checked.operations)
    } finally {
      replaying = false
      resume()
    }
    if (!applied.ok) {
      log(`${direction} failed and was rolled back`, applied.error)
      return refuse(entry, direction, 'replay-error')
    }
    source.pop()
    destination.push(entry)
    refusedTop = null
    const receipt = { ok: true, entryId: entry.id, label: entry.label, direction }
    log(direction, entry.label)
    emitter.emit(direction, receipt)
    return receipt
  }

  function undo(opts) { return replay('undo', opts && opts.entryId) }
  function redo(opts) { return replay('redo', opts && opts.entryId) }

  function findEntry(entryId) {
    return undoStack.find((entry) => entry.id === entryId) || redoStack.find((entry) => entry.id === entryId) || null
  }

  function refuse(entry, direction, code, targets = []) {
    refusedTop = { entryId: entry.id, direction, code, targets }
    log('refused', direction, code)
    emitter.emit('refused', { entryId: entry.id, label: entry.label, direction, code, targets })
    return { ok: false, code, entryId: entry.id, label: entry.label, direction }
  }

  // Explicit dismissal of the refused top entry only: the document and every
  // other entry stay exactly as they are.
  function discard(entryId) {
    if (!refusedTop || refusedTop.entryId !== entryId) return { ok: false, code: 'not-refused', entryId }
    const direction = refusedTop.direction
    const stack = direction === 'undo' ? undoStack : redoStack
    const entry = stack.at(-1)
    if (!entry || entry.id !== entryId) return { ok: false, code: 'stale-entry', entryId }
    stack.pop()
    refusedTop = null
    log('discarded', entry.label)
    emitter.emit('discard', { entryId, label: entry.label, direction })
    return { ok: true, entryId, direction }
  }

  // Plain-data description of what an entry changes, built only from its
  // certificate: the recovery store accepts serializable values, and the entry
  // itself holds live DOM nodes. `null` for an unknown id or an entry whose
  // certificate could not be compiled, so a caller can store the result as-is.
  function describe(entryId) {
    const entry = findEntry(entryId)
    if (!entry || !entry.certificate || !entry.certificate.replayable) return null
    const refused = refusedTop && refusedTop.entryId === entry.id
      ? {
          direction: refusedTop.direction,
          code: refusedTop.code,
          targets: (refusedTop.targets || []).map((target) => ({ id: target.id ?? null, kind: target.kind ?? null })),
        }
      : null
    return {
      id: entry.id,
      label: entry.label,
      timestamp: entry.timestamp,
      refused,
      steps: entry.certificate.steps.map(describeStep),
    }
  }

  function describeStep(step) {
    if (step.type === 'move') {
      return {
        kind: 'move',
        node: { id: described(step.node).id },
        from: { id: described(step.sourceParent).id },
        to: { id: described(step.destParent).id },
      }
    }
    // A removal replays as a restore; from the entry's own point of view it is
    // still a removal, and that is the name the description uses.
    if (step.type === 'add' || step.type === 'restore') {
      return {
        kind: step.type === 'add' ? 'add' : 'remove',
        parent: { id: described(step.parent).id },
        nodes: step.nodes.map((node, i) => ({ id: described(node).id, html: step.content[i] ?? null })),
      }
    }
    const primitive = step.primitive
    const target = { id: described(primitive.target).id }
    const before = primitive.oldValue ?? null
    const after = primitive.newValue ?? null
    if (step.type === 'value') return { kind: 'value', target, prop: primitive.prop ?? 'value', before, after }
    if (step.type === 'text') return { kind: 'text', target, before, after }
    if (step.type === 'attr-set' || step.type === 'attr-add' || step.type === 'attr-remove') {
      return { kind: 'attribute', target, name: primitive.name ?? null, before, after }
    }
    // A step kind this engine does not name yet keeps its own name and the same
    // JSON-safe endpoint shape rather than being dropped.
    return { kind: step.type, target, before, after }
  }

  function observedHere(node) {
    const root = config.scope
    if (!root || !node) return false
    return node === root || (typeof root.contains === 'function' && root.contains(node))
  }

  // A node the scope document's head holds, other than the <title> and what it
  // contains: the fields a page saves with its document, which a bracket records.
  function inHead(node) {
    const doc = scopeDocument()
    const head = doc && doc.head
    if (!head || !node) return false
    let el = node.nodeType === 1 ? node : node.parentElement
    for (; el && el !== head; el = el.parentElement) {
      if (el.localName === 'title') return false
    }
    return el === head
  }

  function inScope(node) {
    const root = config.scope
    if (!node || !root) return false
    if (node === root) return true
    // A manually recorded document.title value addresses head's <title>: the node
    // outside the observed scope an entry's title step owns.
    if (titleNode() === node) return true
    // A bracket may record the head's own fields (see convertRecords), so their
    // replay is judged by the head they still sit in.
    if (inHead(node)) return true
    return typeof root.contains === 'function' ? root.contains(node) : false
  }

  function liveNodesWithIds(ids) {
    const root = config.scope
    if (!ids || ids.length === 0 || typeof root?.querySelectorAll !== 'function') return []
    const wanted = new Set(ids)
    const found = []
    for (const el of root.querySelectorAll('[data-id]')) {
      if (!wanted.has(el.getAttribute('data-id'))) continue
      if (isIgnoredNode(el)) continue
      found.push(el)
    }
    return found
  }

  function clear() {
    // Discard any same-tick buffered records too, so a bootstrap mutation
    // followed by clear() in the same turn doesn't resurface as a commit once
    // the observer callback fires.
    if (observer) observer.takeRecords()
    undoStack.length = 0
    redoStack.length = 0
    pendingPrimitives = []
    refusedTop = null
    clearIdleTimer()
    log('cleared')
    emitter.emit('clear')
  }

  // --- Public surface for the singleton wrapper ---

  return {
    _config: config,  // private: used by keys.js to read shadowKeydownIn
    start, stop,
    commit, commitCaptured, discardCaptured, flush,
    command, setRecording,
    record, recordValue,
    undo, redo, clear, discard, describe,
    pause, resume,
    on: emitter.on, off: emitter.off,
    get canUndo() { return undoStack.length > 0 },
    get canRedo() { return redoStack.length > 0 },
    get isPaused() { return pauseDepth > 0 },
    get history() {
      return undoStack.map(c => {
        const entry = { id: c.id, label: c.label, timestamp: c.timestamp }
        if (refusedTop && refusedTop.entryId === c.id) {
          entry.refused = { direction: refusedTop.direction, code: refusedTop.code, targets: refusedTop.targets }
        }
        return entry
      })
    },
    // The redo stack, next first, in history's shape: what a Redo control names.
    get future() {
      return redoStack.map(c => {
        const entry = { id: c.id, label: c.label, timestamp: c.timestamp }
        if (refusedTop && refusedTop.entryId === c.id) {
          entry.refused = { direction: refusedTop.direction, code: refusedTop.code, targets: refusedTop.targets }
        }
        return entry
      }).reverse()
    },
    get scope() { return config.scope },
  }
}
