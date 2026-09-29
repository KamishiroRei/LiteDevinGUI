import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Execute the real pagination handler with a tiny DOM model. This catches a
// second older-page load being inserted between previously loaded turns.
const source = readFileSync(process.env.HISTORY_APP_SOURCE ?? new URL('../public/app.js', import.meta.url), 'utf8')
const start = source.indexOf('async function loadEarlier() {')
const end = source.indexOf('\nasync function renderHistoryTail()', start)
assert.ok(start >= 0 && end > start, 'find the actual loadEarlier implementation')

class Element {
  constructor(kind, value) {
    this.kind = kind
    this.value = value
    this.children = []
    this.parent = null
    this.scrollTop = 0
  }
  get firstChild() { return this.children[0] ?? null }
  get nextSibling() {
    if (!this.parent) return null
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null
  }
  get scrollHeight() { return this.children.length * 10 }
  appendChild(child) { return this.insertBefore(child, null) }
  insertBefore(child, before) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = before === null ? this.children.length : this.children.indexOf(before)
    assert.ok(index >= 0, 'insert anchor belongs to this parent')
    this.children.splice(index, 0, child)
    child.parent = this
    return child
  }
  remove() {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  querySelector(selector) { return selector === 'button' ? this.button : null }
}

const transcript = new Element('transcript')
const row = new Element('loadEarlier')
row.button = { textContent: '' }
transcript.appendChild(row)
transcript.appendChild(new Element('turn', 12))
transcript.appendChild(new Element('separator'))
transcript.appendChild(new Element('turn', 13))

const state = {
  active: { sessionId: 'old-session' }, openSeq: 1,
  earliestTurn: 12, totalTurns: 14, loadingEarlier: false,
}
const calls = []
const ctx = {
  state, PAGE_TURNS: 5,
  $: id => id === 'transcript' ? transcript
    : id === 'loadEarlier' ? transcript.children.find(child => child === row) : null,
  document: { createElement: kind => new Element(kind) },
  freshStream: () => ({}),
  api: async (_method, path) => {
    const params = new URL(path, 'http://localhost').searchParams
    const to = Number(params.get('to'))
    const from = Math.max(0, to - Number(params.get('count')))
    calls.push([from, to])
    return { from, to, turns: Array.from({ length: to - from }, (_, i) => [from + i]) }
  },
  renderTurn: (updates, _stream, target) => target.appendChild(new Element('turn', updates[0])),
  turnSep: target => target.appendChild(new Element('separator')),
  renderLoadEarlier: () => { if (state.earliestTurn === 0) row.remove() },
  addNote: message => { throw new Error(message) },
  console,
  URL,
}
runInNewContext(source.slice(start, end), ctx)

for (const expectedFrom of [7, 2, 0]) {
  await runInNewContext('loadEarlier()', ctx)
  assert.equal(state.earliestTurn, expectedFrom)
  assert.equal(state.loadingEarlier, false)
  const turns = transcript.children.filter(child => child.kind === 'turn').map(child => child.value)
  assert.deepEqual(turns, Array.from({ length: 14 - expectedFrom }, (_, i) => expectedFrom + i),
    'all loaded turns stay in chronological order across the page boundary')
  assert.equal(transcript.children.includes(row), expectedFrom > 0)
  if (expectedFrom > 0) assert.equal(transcript.firstChild, row, 'load control stays above every turn')
}
assert.deepEqual(calls, [[7, 12], [2, 7], [0, 2]], 'cursor includes every boundary turn exactly once')
console.log('history boundary pagination: OK')
