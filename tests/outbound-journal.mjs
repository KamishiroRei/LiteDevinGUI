import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { OutboundJournal } from '../outbound-journal.mjs'

const root = mkdtempSync(join(tmpdir(), 'devin-lite-outbound-'))
const tempRoot = resolve(tmpdir()) + sep
assert.ok(resolve(root).startsWith(tempRoot))

try {
  const file = join(root, 'messages.jsonl')
  const journal = new OutboundJournal(file)
  const text = '完整交接任务\n第 2 行：保留正文'
  const row = journal.record({ id: 'turn-1', sessionId: 's1', text, source: 'controller',
    status: 'sending', historyIndex: 1 })
  assert.equal(journal.record({ ...row }).id, 'turn-1', 'same ID does not create a second send record')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  journal.setStatus('turn-1', 'completed')
  assert.equal(new OutboundJournal(file).forSession('s1')[0].status, 'completed')

  const replay = [
    { sessionUpdate: 'session_info_update', title: 'test' },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '完整交接任务\n' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第 2 行：保留正文' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } },
  ]
  const matched = journal.mergeReplay('s1', replay)
  assert.equal(matched.length, replay.length, 'ACP replay is annotated, not duplicated')
  assert.equal(matched[1].lite.source, 'controller')
  assert.equal(matched[1].lite.status, 'completed')

  const omitted = journal.mergeReplay('s1', [replay[0], replay[3]])
  assert.equal(omitted[1].content.text, text, 'missing ACP echo is restored for display')
  assert.equal(omitted[2].content.text, '收到', 'outbound message precedes the response')

  journal.record({ id: 'turn-2', sessionId: 's1', text: '第二条相同正文', source: 'bridge',
    status: 'sending', historyIndex: 4 })
  assert.equal(new OutboundJournal(file).forSession('s1')[1].status, 'unknown', 'in-flight outcome is uncertain after restart')
  journal.setStatus('turn-2', 'cancelled')
  journal.setStatus('turn-2', 'completed')
  assert.equal(journal.forSession('s1')[1].status, 'cancelled', 'cancelled turn cannot become completed')
} finally {
  assert.ok(resolve(root).startsWith(tempRoot))
  rmSync(root, { recursive: true, force: true })
}

console.log('outbound journal: OK')
