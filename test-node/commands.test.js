import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeDom, tick } from './_setup.js'
import { createScope } from '../src/scope.js'

// Commands mode (Kanban 08 Step 3). An application that routes every authored
// mutation through an explicit command opts in with setRecording('commands'):
// an unbracketed record — a merge apply, sap paint, sortable noise, an async
// adoption — earns no entry, while a command records only its own synchronous
// writes, even while an outer sync pause is active.

const BOARD = '<!DOCTYPE html><html><head><title>Board</title></head><body>' +
  '<ul id="list"><li class="card" data-id="card-1" data-title="Alpha">Alpha</li></ul>' +
  '</body></html>'

function board(opts = {}) {
  const dom = makeDom(BOARD)
  const doc = dom.window.document
  const scope = createScope({ scope: doc.body, idleWindowMs: 20, ...opts })
  scope.start()
  return { dom, doc, scope, card: doc.querySelector('[data-id="card-1"]') }
}

const labels = (scope) => scope.history.map((entry) => entry.label)

test('unbracketed writes make no commands-mode entry, but a command records once', async () => {
  const { doc, scope, card } = board({ recording: 'commands' })
  card.setAttribute('data-title', 'Remote title')
  await tick(40)
  assert.equal(scope.history.length, 0, 'a write no command bracketed is not a local action')
  assert.equal(card.getAttribute('data-title'), 'Remote title', 'the document still changed')

  const receipt = scope.command('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  assert.deepEqual(labels(scope), ['Rename card'])
  assert.ok(receipt && typeof receipt.id === 'string', 'a command returns its receipt id')
  assert.equal(receipt.label, 'Rename card')
  assert.equal(scope.history[0].id, receipt.id, 'the receipt names the entry it pushed')
  scope.stop()
})

test('a command during a paused sync apply is recorded once; the apply writes stay out', async () => {
  const { doc, scope, card } = board()
  scope.setRecording('commands')
  scope.pause()   // the long LiveSync pause around mergeDocument
  try {
    card.setAttribute('data-title', 'Peer title')
    const receipt = scope.command('Rename card', () => { card.setAttribute('data-title', 'Local title') })
    assert.ok(receipt, 'the local command is captured while the outer pause is active')
    card.setAttribute('data-note', 'peer paint')
    assert.equal(scope.isPaused, true, 'the outer pause depth is unchanged inside the command')
  } finally {
    scope.resume()
  }
  await tick(40)
  assert.deepEqual(labels(scope), ['Rename card'], 'exactly one entry, and no peer entry')
  assert.equal(scope.isPaused, false)

  scope.undo()
  assert.equal(card.getAttribute('data-title'), 'Peer title', 'undo walks back to the value before the local command')
  assert.equal(card.getAttribute('data-note'), 'peer paint', 'the paused writes were never part of the entry')
  assert.equal(doc.body.contains(card), true)
  scope.stop()
})

test('records queued before a command are not folded into it', () => {
  const { scope, card } = board({ recording: 'commands' })
  card.setAttribute('data-alpha', '1')   // same tick, unbracketed: still queued in the observer
  const receipt = scope.command('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  assert.ok(receipt)
  assert.equal(scope.history.length, 1)

  const undone = scope.undo()
  assert.equal(undone.ok, true)
  assert.equal(card.getAttribute('data-title'), 'Alpha')
  assert.equal(card.hasAttribute('data-alpha'), true, 'the write before the command keeps its own state')
  scope.stop()
})

test('writes after a command remain excluded and the command still undoes once', async () => {
  const { scope, card } = board({ recording: 'commands' })
  scope.command('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  card.setAttribute('data-title', 'Peer title')   // a later unbracketed write
  await tick(40)
  assert.equal(scope.history.length, 1)

  const refused = scope.undo()
  assert.equal(refused.ok, false, 'the entry no longer describes the live document')
  assert.equal(refused.code, 'content-changed')
  assert.equal(card.getAttribute('data-title'), 'Peer title', 'the peer value is never overwritten')
  scope.stop()
})

test('a command that throws keeps its writes as an interrupted entry and restores the pause depth', () => {
  const { doc, scope, card } = board({ recording: 'commands' })
  scope.pause()
  assert.throws(
    () => scope.command('Rename card', () => {
      card.setAttribute('data-title', 'Half done')
      card.appendChild(doc.createElement('span'))
      throw new Error('boom')
    }),
    /boom/,
    'the caller hears about the failure'
  )
  assert.equal(scope.isPaused, true, 'the outer pause depth is restored unchanged')
  assert.deepEqual(labels(scope), ['Rename card'], 'the observed writes are retained as an interrupted entry')
  assert.equal(card.getAttribute('data-title'), 'Half done', 'the changed document is not silently discarded')
  scope.resume()
  assert.equal(scope.isPaused, false)
  scope.stop()
})

test('nested, async, thenable and effect commands all refuse', async () => {
  const { dom, scope, card } = board({ recording: 'commands' })

  assert.throws(
    () => scope.command('Outer', () => scope.command('Inner', () => {})),
    /cannot nest/,
    'a nested command is an implementation error'
  )
  assert.equal(scope.history.length, 0)

  assert.throws(
    () => scope.command('Later', async () => { card.setAttribute('data-title', 'Async') }),
    /must be synchronous/,
    'a declared async callback is rejected before it runs'
  )
  assert.equal(card.getAttribute('data-title'), 'Alpha', 'the rejected callback never wrote')
  assert.equal(scope.history.length, 0)

  assert.throws(
    () => scope.command('Thenable', () => {
      card.setAttribute('data-title', 'Thenable')
      return Promise.reject(new Error('late'))
    }),
    /must be synchronous/,
    'a returned thenable refuses after its writes'
  )
  await tick(10)   // the rejection is observed, never an unhandled one
  assert.equal(card.getAttribute('data-title'), 'Thenable', 'its writes are retained, not discarded')
  assert.deepEqual(labels(scope), ['Thenable'])

  dom.window.clay = { effect: { running: true } }
  assert.throws(
    () => scope.command('Effect', () => {}),
    /derived-effect/,
    'a command is an authored action, never a derived effect'
  )
  dom.window.clay = undefined
  scope.stop()
})

test('a passive read inside a replay refuses a command without aborting the replay', () => {
  const { doc, scope } = board({ recording: 'commands' })
  const field = doc.createElement('div')
  doc.body.appendChild(field)
  let stored = 'started'
  let attempted = null
  const write = (el, value) => {
    if (value === 'started') {
      try { scope.command('Inside undo', () => {}) } catch (error) { attempted = error }
    }
    stored = value
  }
  scope.command('Store field', () => {
    const before = stored
    stored = 'later'
    scope.recordValue(field, { prop: 'value', oldValue: before, newValue: stored, read: () => stored, write })
  })
  assert.equal(scope.history.length, 1)
  const undone = scope.undo()
  assert.equal(undone.ok, true, 'the replay itself completes')
  assert.equal(stored, 'started')
  assert.ok(attempted && /during undo or redo/.test(attempted.message), 'a command inside a replay refuses')
  scope.stop()
})

test('a no-op command pushes no entry and keeps the redo stack', () => {
  const { scope, card } = board({ recording: 'commands' })
  scope.command('Rename card', () => { card.setAttribute('data-title', 'Local title') })
  assert.equal(scope.undo().ok, true)
  assert.equal(scope.canRedo, true)

  const receipt = scope.command('Rename card', () => { card.setAttribute('data-title', 'Alpha') })
  assert.equal(receipt, null, 'a command that changes nothing returns no receipt')
  assert.equal(scope.history.length, 0)
  assert.equal(scope.canRedo, true, 'a no-op does not clear redo')

  const same = scope.command('No-op', () => {})
  assert.equal(same, null)
  assert.equal(scope.history.length, 0)
  assert.equal(scope.canRedo, true)
  scope.stop()
})

test('commit stays an explicit boundary in commands mode but honors an outer pause', () => {
  const { scope, card } = board({ recording: 'commands' })
  scope.commit('Rename card', () => { card.setAttribute('data-title', 'Committed') })
  assert.deepEqual(labels(scope), ['Rename card'])

  scope.pause()
  try {
    scope.commit('Paused rename', () => { card.setAttribute('data-title', 'Excluded') })
  } finally {
    scope.resume()
  }
  assert.deepEqual(labels(scope), ['Rename card'], 'an outer exclusion pause still excludes a commit')
  assert.equal(card.getAttribute('data-title'), 'Excluded', 'the paused write still reached the document')
  scope.stop()
})

test('setRecording flushes preceding work as its own entry and validates its argument', () => {
  const { scope, card } = board()
  card.setAttribute('data-title', 'Typed')
  assert.throws(() => scope.setRecording('every-now-and-then'), /automatic|commands/)
  scope.setRecording('commands')
  assert.deepEqual(labels(scope), ['Edit'], 'work recorded before the switch closes as its own entry')
  assert.equal(scope.setRecording('commands'), 'commands')
  scope.stop()
})

test('a command records document.title in the same certificate, from its own document', () => {
  // A second page exists first, so the scope must read its OWN document: the
  // module-global one belongs to whichever realm was made last.
  const other = makeDom('<!DOCTYPE html><html><head><title>Other</title></head><body></body></html>')
  const otherDoc = other.window.document
  const { doc, scope, card } = board({ recording: 'commands' })

  const receipt = scope.command('Rename board', () => {
    doc.title = 'Board 2'
    card.setAttribute('data-title', 'Local title')
  })
  assert.ok(receipt)
  assert.equal(otherDoc.title, 'Other', 'another document is never read or written')
  assert.deepEqual(labels(scope), ['Rename board'])

  const undone = scope.undo()
  assert.equal(undone.ok, true, 'the title change is guarded like any other scalar in the entry')
  assert.equal(doc.title, 'Board', 'undo restores the previous title')
  assert.equal(card.getAttribute('data-title'), 'Alpha')

  scope.redo()
  assert.equal(doc.title, 'Board 2')
  assert.equal(card.getAttribute('data-title'), 'Local title')
  scope.stop()
})

test('an explicit title value joins the command entry once, not twice', () => {
  const { doc, scope } = board({ recording: 'commands' })
  scope.command('Rename board', () => {
    const before = doc.title
    doc.title = 'Board 3'
    scope.recordValue(doc, { prop: 'title', oldValue: before, newValue: doc.title })
  })
  assert.equal(scope.history.length, 1)
  const undone = scope.undo()
  assert.equal(undone.ok, true, 'the explicit value and the command capture are one primitive')
  assert.equal(doc.title, 'Board')
  scope.stop()
})

test('a stopped or detached scope refuses a command and mutates no document', () => {
  const first = makeDom('<!DOCTYPE html><html><head><title>First</title></head><body><div id="x"></div></body></html>')
  const scope = createScope({ scope: first.window.document.body, idleWindowMs: 20 })
  scope.start()
  const second = makeDom('<!DOCTYPE html><html><head><title>Second</title></head><body><p id="y">second</p></body></html>')
  const otherDoc = second.window.document

  scope.stop()
  assert.throws(
    () => scope.command('Detached', () => { otherDoc.getElementById('y').textContent = 'changed' }),
    /not started/,
    'a stopped scope refuses before the callback runs'
  )
  assert.equal(otherDoc.getElementById('y').textContent, 'second', 'nothing in the other document moved')
  assert.equal(otherDoc.title, 'Second')
  assert.equal(scope.history.length, 0)
})

// A Redo control names the entry it would replay, and a history surface hears a
// dismissal like every other change.
test('future lists the redo stack next first, and discard is announced', () => {
  const { scope, card } = board({ recording: 'commands' })
  scope.command('First', () => card.setAttribute('data-title', 'One'))
  scope.command('Second', () => card.setAttribute('data-title', 'Two'))
  assert.deepEqual(scope.future, [])
  scope.undo()
  scope.undo()
  assert.deepEqual(scope.future.map((entry) => entry.label), ['First', 'Second'])

  scope.redo()
  card.setAttribute('data-title', 'Peer')
  const discarded = []
  scope.on('discard', (detail) => discarded.push(detail))
  const refused = scope.redo()
  assert.equal(refused.ok, false)
  assert.equal(scope.future[0].refused.code, refused.code)
  assert.equal(scope.discard(refused.entryId).ok, true)
  assert.deepEqual(discarded, [{ entryId: refused.entryId, label: 'Second', direction: 'redo' }])
  assert.deepEqual(scope.future, [])
})
