// Whole-entry certificates and symmetric atomic preflight.
//
// An entry (one command or one idle batch) is compiled into a private
// certificate when it closes: normalized scalar endpoints, structural steps
// with the ordered child identities of every affected container before and
// after the step, and an immutable durable projection of every subtree the
// entry would delete or restore.
//
// Undo and redo then run that certificate in the opposite direction against the
// live document BEFORE touching it. Preflight never writes; it returns the
// concrete native operations to apply, or the first reason the entry can no
// longer be applied safely. Apply runs those operations with a rollback
// journal, so an unexpected DOM failure restores what it already did.

import { normalizePrimitives } from './primitives.js'

const identities = new WeakMap()
let identityCount = 0

// Live-node identity. In-session replay always addresses the node the entry
// recorded; a same-data-id replacement is a different node and stays unequal.
export function identityOf(node) {
  let id = identities.get(node)
  if (!id) { id = `n${++identityCount}`; identities.set(node, id) }
  return id
}

function isNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number'
}

function isStructural(p) {
  return p.kind === 'add' || p.kind === 'remove'
}

function childIdentities(parent, isIgnored) {
  const out = []
  const children = parent.childNodes
  if (!children) return out
  for (const child of children) {
    if (isIgnored && isIgnored(child)) continue
    out.push(identityOf(child))
  }
  return out
}

// Immutable durable content of a subtree: every attribute, every text run and
// the exact child order. Deliberately strict — a field the recorder does not
// track is still part of what an undo would erase. The one exception is a
// predicate for attributes the scope never records, on any node of the subtree:
// a value the scope ignores must not make the entry refuse to replay. A subtree
// region the scope ignores is skipped whole, like an ignored attribute.
// `host` is the element a removed subtree belongs under. A detached node has no
// ancestors left, so a predicate that reads them (is this attribute painted by an
// app above it?) receives the host and answers as it did while attached.
export function durableProjection(node, ignoredAttribute, host = null, ignoredNode = null) {
  if (!isNode(node)) return null
  if (node.nodeType === 3) return `#text:${JSON.stringify(node.data)}`
  if (node.nodeType === 8) return `#comment:${JSON.stringify(node.data)}`
  if (node.nodeType !== 1) return `#node:${node.nodeType}`
  const attributes = []
  if (node.attributes) {
    for (const attr of node.attributes) {
      if (isIgnoredAttribute(attr.name, node, ignoredAttribute, host)) continue
      attributes.push(`${attr.name}=${JSON.stringify(attr.value)}`)
    }
    attributes.sort()
  }
  const children = []
  if (node.childNodes) {
    for (const child of node.childNodes) {
      if (isIgnoredNode(child, ignoredNode)) continue
      children.push(durableProjection(child, ignoredAttribute, host, ignoredNode))
    }
  }
  const tag = String(node.tagName || '').toLowerCase()
  return `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children.join('')}</>`
}

function durableIdsIn(node, out = []) {
  if (!isNode(node)) return out
  if (node.nodeType === 1) {
    const id = node.getAttribute && node.getAttribute('data-id')
    if (id) out.push(id)
  }
  if (node.childNodes) for (const child of node.childNodes) durableIdsIn(child, out)
  return out
}

function isIgnoredAttribute(name, node, predicate, host = null) {
  if (typeof predicate !== 'function') return false
  try { return !!predicate(name, node, host) } catch (_) { return false }
}

function isIgnoredNode(node, predicate) {
  if (typeof predicate !== 'function') return false
  try { return !!predicate(node) } catch (_) { return false }
}

function protectedWithin(nodes, isProtected) {
  if (typeof isProtected !== 'function') return []
  const found = []
  const visit = (node) => {
    if (!isNode(node)) return
    let hit = false
    try { hit = !!isProtected(node) } catch (_) { hit = false }
    if (hit) found.push(described(node, 'protected'))
    if (node.childNodes) for (const child of node.childNodes) visit(child)
  }
  for (const node of nodes) visit(node)
  return found
}

export function described(node, kind, parent = null) {
  let host = node
  if (host && host.nodeType !== 1) host = host.parentElement
  let owner = host && typeof host.closest === 'function' ? host.closest('[data-id]') : null
  if (!owner && parent && typeof parent.closest === 'function') owner = parent.closest('[data-id]')
  const id = owner ? owner.getAttribute('data-id') : null
  return { id: id || null, kind: kind || null }
}

function targetsOf(nodes, kind, parent = null) {
  return (nodes || []).filter(isNode).map((node) => described(node, kind, parent))
}

function unsupported(reason) {
  return { replayable: false, reason, steps: [] }
}

// Where a structural primitive's recorded slot sits in `list`, following the
// same anchor priority the primitive itself uses. null means the recorded slot
// cannot be located: the certificate must not guess a position.
function slotIndex(list, primitive) {
  const candidates = [
    [primitive.afterAuthored, (at) => at],
    [primitive.beforeAuthored, (at) => at + 1],
    [primitive.before, (at) => at],
  ]
  let recorded = false
  for (const [anchor, place] of candidates) {
    if (!isNode(anchor)) continue
    recorded = true
    const at = list.indexOf(identityOf(anchor))
    if (at >= 0) return place(at)
  }
  if (recorded) return null
  return list.length
}

// Compile one entry. `isIgnored` is the scope's own region filter, so runtime
// UI and no-undo shells never enter a container's identity sequence.
export function compileCertificate(primitives, env = {}) {
  const isIgnored = env.isIgnored || null
  const ignoredAttribute = env.ignoreAttribute || null
  const normalized = normalizePrimitives(primitives)

  const structural = []
  for (const p of normalized) {
    if (!isStructural(p)) {
      if (!isNode(p.target)) return unsupported('non-dom-target')
      continue
    }
    if (!isNode(p.parent)) return unsupported('non-dom-parent')
    const nodes = Array.from(p.nodes || []).filter(isNode)
    if (nodes.length === 0) continue
    if (nodes.length !== Array.from(p.nodes || []).length) return unsupported('non-dom-node')
    structural.push({ primitive: p, nodes, parent: p.parent })
  }
  if (ambiguousReorder(structural)) return unsupported('in-record-move')

  const states = sequenceStates(structural, isIgnored)
  if (!states) return unsupported('ambiguous-structure')

  const paired = pairMoves(structural, states)
  const byPrimitive = new Map(structural.map((item) => [item.primitive, item]))
  const steps = []
  for (const primitive of normalized) {
    const item = byPrimitive.get(primitive)
    if (!item) { steps.push(scalarStep(primitive)); continue }
    const move = paired.get(item)
    if (move) {
      if (move.at === item) steps.push(move.step)
      continue
    }
    steps.push(structuralStep(item, states.get(item), ignoredAttribute, isIgnored))
  }
  return { replayable: true, reason: null, steps }
}

// A node added and removed by the SAME childList record was reordered inside
// its parent. MutationRecord keeps only the final slot, so the entry's before
// boundary cannot be reconstructed: refuse the certificate instead of guessing.
function ambiguousReorder(structural) {
  const seen = new Map()   // record → Map(node → Set(kinds))
  for (const item of structural) {
    const record = item.primitive.record
    if (!record) continue
    let nodes = seen.get(record)
    if (!nodes) { nodes = new Map(); seen.set(record, nodes) }
    for (const node of item.nodes) {
      let kinds = nodes.get(node)
      if (!kinds) { kinds = new Set(); nodes.set(node, kinds) }
      kinds.add(item.primitive.kind)
    }
  }
  for (const nodes of seen.values()) {
    for (const kinds of nodes.values()) if (kinds.size > 1) return true
  }
  return false
}

// Rebuild each container's ordered child identities backwards from the live
// (after) boundary, so every structural step knows both of its endpoints.
function sequenceStates(structural, isIgnored) {
  const current = new Map()
  for (const item of structural) {
    if (!current.has(item.parent)) current.set(item.parent, childIdentities(item.parent, isIgnored))
  }
  const states = new Map()
  for (let i = structural.length - 1; i >= 0; i--) {
    const item = structural[i]
    const list = current.get(item.parent)
    if (!list) return null
    const after = list.slice()
    let before
    if (item.primitive.kind === 'add') {
      const ids = item.nodes.map(identityOf)
      if (!ids.every((id) => list.includes(id))) return null
      before = list.filter((id) => !ids.includes(id))
    } else {
      const at = slotIndex(after, item.primitive)
      if (at == null) return null
      before = after.slice()
      before.splice(at, 0, ...item.nodes.map(identityOf))
    }
    states.set(item, { before, after })
    current.set(item.parent, before)
  }
  return states
}

// A node removed from one slot and later inserted at another is a move, not a
// deletion plus an addition: undoing a move places the same live node back, so
// a peer's edit to that card does not have to be reverted to allow it.
function pairMoves(structural, states) {
  const removes = new Map()
  const adds = new Map()
  structural.forEach((item, index) => {
    for (const node of item.nodes) {
      const key = identityOf(node)
      if (item.primitive.kind === 'remove') removes.set(key, { item, index, node })
      else adds.set(key, { item, index, node })
    }
  })

  const moves = new Map()
  for (const [key, removal] of removes) {
    const addition = adds.get(key)
    if (!addition || addition.index < removal.index) continue
    if (removal.item.nodes.length !== 1 || addition.item.nodes.length !== 1) continue
    const step = {
      type: 'move',
      node: removal.node,
      sourceParent: removal.item.parent,
      destParent: addition.item.parent,
      source: states.get(removal.item),
      dest: states.get(addition.item),
      sourceSlot: removal.item.primitive,
      destSlot: addition.item.primitive,
      targets: [described(removal.node, 'move')],
    }
    moves.set(removal.item, { step, at: addition.item })
    moves.set(addition.item, { step, at: addition.item })
  }
  return moves
}

function structuralStep(item, state, ignoredAttribute, ignoredNode) {
  const kind = item.primitive.kind
  return {
    type: kind === 'add' ? 'add' : 'restore',
    parent: item.parent,
    nodes: item.nodes,
    seqBefore: state.before,
    seqAfter: state.after,
    slot: item.primitive,
    content: item.nodes.map((node) => durableProjection(node, ignoredAttribute, item.parent, ignoredNode)),
    ids: kind === 'remove' ? item.nodes.flatMap((node) => durableIdsIn(node)) : [],
    targets: targetsOf(item.nodes, kind === 'add' ? 'added' : 'removed', item.parent),
  }
}

function scalarStep(primitive) {
  return {
    type: primitive.kind,
    primitive,
    targets: [described(primitive.target, primitive.name || primitive.prop || 'text')],
  }
}

export function preflight(certificate, direction, env = {}) {
  if (!certificate || !certificate.replayable) return { ok: false, code: 'unsupported', targets: [] }

  const context = {
    isIgnored: env.isIgnored || null,
    ignoreAttribute: env.ignoreAttribute || null,
    isProtected: env.isProtected || null,
    inScope: env.inScope || (() => true),
    liveNodesWithIds: env.liveNodesWithIds || (() => []),
    sim: new Map(),
    planned: new Map(),
    operations: [],
  }

  for (let i = 0; i < certificate.steps.length; i++) {
    const step = certificate.steps[direction === 'undo' ? certificate.steps.length - 1 - i : i]
    const refusal = checkStep(step, direction, context)
    if (refusal) return { ok: false, code: refusal.code, targets: refusal.targets }
  }
  return { ok: true, operations: context.operations }
}

function listFor(context, parent) {
  if (!context.sim.has(parent)) context.sim.set(parent, childIdentities(parent, context.isIgnored))
  return context.sim.get(parent)
}

function inPlannedScope(node, context) {
  for (let n = node; n; n = n.parentNode) {
    if (context.planned.has(n)) return context.planned.get(n)
  }
  return context.inScope(node)
}

// A duplicate identity is one that would still be live when this step inserts
// its own node: a node an earlier step of the same replay removes (or one under
// it) is leaving, so it does not collide.
function liveDuplicates(ids, context) {
  return context.liveNodesWithIds(ids).filter((node) => inPlannedScope(node, context)).length > 0
}

function refuseStep(code, targets) {
  return { code, targets: targets || [] }
}

function liveValue(primitive) {
  if (primitive.kind === 'text') return primitive.target.data
  if (primitive.kind === 'value') {
    return typeof primitive.read === 'function' ? primitive.read(primitive.target) : primitive.target[primitive.prop || 'value']
  }
  return primitive.target.getAttribute(primitive.name)
}

function checkStep(step, direction, context) {
  const undoing = direction === 'undo'
  if (step.type === 'move') return checkMove(step, undoing, context)
  if (step.type === 'add') return checkAdd(step, undoing, context)
  if (step.type === 'restore') return checkRestore(step, undoing, context)
  return checkScalar(step, undoing, context)
}

function checkScalar(step, undoing, context) {
  const primitive = step.primitive
  const expected = undoing ? primitive.newValue : primitive.oldValue
  const next = undoing ? primitive.oldValue : primitive.newValue
  if (!isNode(primitive.target)) return refuseStep('unsupported', step.targets)
  if (!inPlannedScope(primitive.target, context)) return refuseStep('target-detached', step.targets)
  if (primitive.kind === 'value' && typeof primitive.write === 'function' && typeof primitive.read !== 'function') {
    return refuseStep('unsupported', step.targets)
  }
  if (liveValue(primitive) !== expected) return refuseStep('content-changed', step.targets)
  if (primitive.kind === 'value') {
    context.operations.push({ type: 'value', target: primitive.target, prop: primitive.prop || 'value', value: next, read: primitive.read || null, write: primitive.write || null })
  } else if (primitive.kind === 'text') {
    context.operations.push({ type: 'text', target: primitive.target, data: next })
  } else {
    context.operations.push({ type: 'attr', target: primitive.target, name: primitive.name, value: next == null ? null : next })
  }
  return null
}

function checkAdd(step, undoing, context) {
  if (!isNode(step.parent) || !inPlannedScope(step.parent, context)) return refuseStep('target-detached', step.targets)
  if (undoing) {
    if (!sameSequence(listFor(context, step.parent), step.seqAfter)) return refuseStep('structure-changed', step.targets)
    const protectedTargets = protectedWithin(step.nodes, context.isProtected)
    if (protectedTargets.length > 0) return refuseStep('protected', protectedTargets)
    for (let i = 0; i < step.nodes.length; i++) {
      if (durableProjection(step.nodes[i], context.ignoreAttribute, step.parent, context.isIgnored) !== step.content[i]) return refuseStep('content-changed', step.targets)
    }
    for (const node of step.nodes) {
      context.operations.push({ type: 'remove', node })
      context.planned.set(node, false)
    }
    context.sim.set(step.parent, step.seqBefore.slice())
    return null
  }
  if (!sameSequence(listFor(context, step.parent), step.seqBefore)) return refuseStep('structure-changed', step.targets)
  for (const node of step.nodes) {
    if (node.parentNode) return refuseStep('structure-changed', step.targets)
  }
  const ids = step.nodes.flatMap((node) => durableIdsIn(node))
  if (ids.length > 0 && liveDuplicates(ids, context)) return refuseStep('duplicate-id', step.targets)
  const at = slotIndex(step.seqBefore, step.slot)
  if (at == null) return refuseStep('unsupported', step.targets)
  let inserted = step.seqBefore.slice()
  let cursor = at
  for (const node of step.nodes) {
    context.operations.push({ type: 'insert', parent: step.parent, node, beforeId: inserted[cursor] ?? null })
    inserted = inserted.slice(0, cursor).concat(identityOf(node), inserted.slice(cursor))
    cursor += 1
    context.planned.set(node, true)
  }
  context.sim.set(step.parent, step.seqAfter.slice())
  return null
}

function checkRestore(step, undoing, context) {
  if (!isNode(step.parent) || !inPlannedScope(step.parent, context)) return refuseStep('target-detached', step.targets)
  if (undoing) {
    if (!sameSequence(listFor(context, step.parent), step.seqAfter)) return refuseStep('structure-changed', step.targets)
    for (let i = 0; i < step.nodes.length; i++) {
      const node = step.nodes[i]
      if (node.parentNode || durableProjection(node, context.ignoreAttribute, step.parent, context.isIgnored) !== step.content[i]) return refuseStep('content-changed', step.targets)
    }
    if (step.ids.length > 0 && liveDuplicates(step.ids, context)) return refuseStep('duplicate-id', step.targets)
    const at = slotIndex(step.seqAfter, step.slot)
    if (at == null) return refuseStep('unsupported', step.targets)
    let restored = step.seqAfter.slice()
    let cursor = at
    for (const node of step.nodes) {
      context.operations.push({ type: 'insert', parent: step.parent, node, beforeId: restored[cursor] ?? null })
      restored = restored.slice(0, cursor).concat(identityOf(node), restored.slice(cursor))
      cursor += 1
      context.planned.set(node, true)
    }
    context.sim.set(step.parent, step.seqBefore.slice())
    return null
  }
  if (!sameSequence(listFor(context, step.parent), step.seqBefore)) return refuseStep('structure-changed', step.targets)
  const protectedTargets = protectedWithin(step.nodes, context.isProtected)
  if (protectedTargets.length > 0) return refuseStep('protected', protectedTargets)
  // A child an earlier step of this replay moves out (a card moved to another
  // column before its column is removed) is leaving, so the removed subtree is
  // compared without it, as it was when it was recorded.
  const leaving = (node) => context.planned.get(node) === true || (typeof context.isIgnored === 'function' && context.isIgnored(node))
  for (let i = 0; i < step.nodes.length; i++) {
    const node = step.nodes[i]
    if (node.parentNode !== step.parent || durableProjection(node, context.ignoreAttribute, step.parent, leaving) !== step.content[i]) return refuseStep('content-changed', step.targets)
  }
  for (const node of step.nodes) {
    context.operations.push({ type: 'remove', node })
    context.planned.set(node, false)
  }
  context.sim.set(step.parent, step.seqAfter.slice())
  return null
}

function withoutIdentity(list, id) {
  const at = list.indexOf(id)
  if (at < 0) return null
  return list.slice(0, at).concat(list.slice(at + 1))
}

function checkMove(step, undoing, context) {
  const nodeId = identityOf(step.node)
  const fromParent = undoing ? step.destParent : step.sourceParent
  const toParent = undoing ? step.sourceParent : step.destParent
  const fromList = listFor(context, fromParent)
  const toList = listFor(context, toParent)
  const expectedFrom = undoing ? step.dest.after : step.source.before
  const gap = undoing ? step.source.after : step.dest.before
  const slot = undoing ? step.sourceSlot : step.destSlot
  if (!isNode(fromParent) || !isNode(toParent)) return refuseStep('target-detached', step.targets)
  if (!inPlannedScope(fromParent, context) || !inPlannedScope(toParent, context)) return refuseStep('target-detached', step.targets)
  if (!sameSequence(fromList, expectedFrom)) return refuseStep('structure-changed', step.targets)
  const toGap = fromParent === toParent ? withoutIdentity(toList, nodeId) : toList
  if (!sameSequence(toGap, gap)) return refuseStep('structure-changed', step.targets)

  const at = slotIndex(gap, slot)
  if (at == null) return refuseStep('unsupported', step.targets)
  context.operations.push({ type: 'insert', parent: toParent, node: step.node, beforeId: gap[at] ?? null })
  context.planned.set(step.node, true)
  if (undoing) {
    context.sim.set(toParent, step.source.before.slice())
    if (fromParent !== toParent) context.sim.set(fromParent, step.dest.before.slice())
  } else {
    context.sim.set(toParent, step.dest.after.slice())
    if (fromParent !== toParent) context.sim.set(fromParent, step.source.after.slice())
  }
  return null
}

function sameSequence(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function findChildByIdentity(parent, id) {
  for (const child of parent.childNodes || []) {
    if (identityOf(child) === id) return child
  }
  return null
}

function writeValue(op, value) {
  if (typeof op.write === 'function') op.write(op.target, value)
  else op.target[op.prop] = value
}

export function applyOperations(operations) {
  const journal = []
  try {
    for (const op of operations) applyOne(op, journal)
    return { ok: true }
  } catch (error) {
    for (let i = journal.length - 1; i >= 0; i--) {
      try { journal[i]() } catch (_) { /* the rollback keeps trying the rest */ }
    }
    return { ok: false, error }
  }
}

function applyOne(op, journal) {
  if (op.type === 'attr') {
    const previous = op.target.getAttribute(op.name)
    if (op.value == null) op.target.removeAttribute(op.name)
    else op.target.setAttribute(op.name, op.value)
    journal.push(() => {
      if (previous == null) op.target.removeAttribute(op.name)
      else op.target.setAttribute(op.name, previous)
    })
    return
  }
  if (op.type === 'text') {
    const previous = op.target.data
    op.target.data = op.data
    journal.push(() => { op.target.data = previous })
    return
  }
  if (op.type === 'value') {
    const previous = typeof op.read === 'function' ? op.read(op.target) : op.target[op.prop]
    writeValue(op, op.value)
    journal.push(() => writeValue(op, previous))
    return
  }
  if (op.type === 'insert') {
    const before = op.beforeId == null ? null : findChildByIdentity(op.parent, op.beforeId)
    if (op.beforeId != null && !before) throw new Error('hyper-undo: replay anchor vanished')
    const fromParent = op.node.parentNode
    const fromNext = op.node.nextSibling
    op.parent.insertBefore(op.node, before)
    journal.push(() => {
      if (fromParent) fromParent.insertBefore(op.node, fromNext && fromNext.parentNode === fromParent ? fromNext : null)
      else if (op.node.parentNode === op.parent) op.parent.removeChild(op.node)
    })
    return
  }
  if (op.type === 'remove') {
    const parent = op.node.parentNode
    if (!parent) throw new Error('hyper-undo: replay target is no longer attached')
    const next = op.node.nextSibling
    parent.removeChild(op.node)
    journal.push(() => parent.insertBefore(op.node, next))
  }
}
