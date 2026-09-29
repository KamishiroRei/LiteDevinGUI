import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'devin-lite-visible-'))
let server
let base
const sleep = ms => new Promise(done => setTimeout(done, ms))

async function port() {
  const probe = createServer()
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  const value = probe.address().port
  await new Promise(done => probe.close(done))
  return value
}
async function api(method, path, body) {
  const response = await fetch(base + path, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const data = await response.json()
  assert.equal(response.status, 200, JSON.stringify(data))
  return data
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(60)
  }
  throw new Error('timed out')
}
async function start() {
  server = spawn(process.execPath, [join(work, 'server.mjs'), String(new URL(base).port)], {
    cwd: work, env: { ...process.env, DEVIN_EXE: process.execPath,
      DEVIN_LITE_CAPACITY_SCRIPT: join(work, 'fake-capacity.py'),
      DEVIN_LITE_PYTHON: process.env.DEVIN_LITE_TEST_PYTHON ?? 'python' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  await until(async () => { try { return (await api('GET', '/api/health')).ok } catch { return false } })
}
async function stop() {
  if (!server) return
  const child = server
  server = undefined
  const exited = new Promise(done => child.once('exit', done))
  child.kill()
  await Promise.race([exited, sleep(3000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}
function promptCount() {
  return readFileSync(join(work, 'prompt-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
}

try {
  for (const file of ['server.mjs', 'workspace-skills.mjs', 'outbound-journal.mjs'])
    copyFileSync(join(source, file), join(work, file))
  copyFileSync(join(source, 'tests', 'fixtures', 'acp'), join(work, 'acp'))
  copyFileSync(join(source, 'tests', 'fixtures', 'fake-capacity.py'), join(work, 'fake-capacity.py'))
  writeFileSync(join(work, 'fake-state.json'), JSON.stringify({ capacity: { active: 0, limit: 5 }, promptMode: 'ok' }))
  writeFileSync(join(work, 'prompt-log.jsonl'), '')
  base = `http://127.0.0.1:${await port()}`
  await start()
  const { sessionId } = await api('POST', '/api/sessions/new', { cwd: work })

  const events = []
  const connection = await fetch(base + '/api/events', { signal: AbortSignal.timeout(12000) })
  const reader = connection.body.getReader()
  const collect = (async () => {
    let buffer = ''
    while (events.length < 30) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore heartbeat */ }
      }
    }
  })().catch(() => {})

  const fullText = '完整交接正文\n第二段：需要用户可核对'
  const started = await api('POST', '/api/bridge/turn/start', {
    sessionId, cwd: work, text: fullText, model: 'swe-2-high', modeId: 'bypass',
    clientTurnId: 'controller-action-1', priority: true,
  })
  await until(() => events.some(e => e.kind === 'update' && e.update?.content?.text === fullText))
  const visible = events.find(e => e.kind === 'update' && e.update?.content?.text === fullText)
  assert.equal(visible.update.lite.source, 'controller', 'live SSE shows full controller prompt')
  await until(() => events.some(e => e.kind === 'message-status' && e.messageId === started.turnId && e.status === 'completed'))
  const liveHistory = await api('GET', `/api/history?sessionId=${sessionId}&tail=5`)
  const liveRows = liveHistory.turns.flat().filter(u => u.content?.text === fullText)
  assert.equal(liveRows.length, 1, 'live history contains one full handoff')
  assert.equal(liveRows[0].lite.status, 'completed')
  assert.equal(promptCount(), 1, 'ACP received the handoff once')

  await api('POST', '/api/prompt', { sessionId, cwd: work, text: '网页插话', clientMessageId: 'gui-1' })
  await until(async () => (await api('GET', `/api/history?sessionId=${sessionId}&tail=5`))
    .turns.flat().some(u => u.lite?.id === 'gui-1' && u.lite.status === 'completed'))
  assert.equal(promptCount(), 2)

  writeFileSync(join(work, 'fake-state.json'), JSON.stringify({ capacity: { active: 0, limit: 5 },
    promptMode: 'reject', rejectMessage: 'Too many concurrent sessions; please wait 2 minutes before retrying.' }))
  await api('POST', '/api/bridge/turn/start', { sessionId, cwd: work, text: '排队但未完成的正文',
    model: 'swe-2-high', clientTurnId: 'ordinary-queued-1' })
  const queued = await until(async () => (await api('GET', '/api/queue')).pending[0])
  const queuedHistory = await api('GET', `/api/history?sessionId=${sessionId}&tail=5`)
  assert.equal(queuedHistory.turns.flat().find(u => u.content?.text === '排队但未完成的正文').lite.status, 'queued')
  await api('POST', '/api/queue/drop', { queueId: queued.queueId })
  const cancelled = await api('GET', `/api/history?sessionId=${sessionId}&tail=5`)
  assert.equal(cancelled.turns.flat().find(u => u.content?.text === '排队但未完成的正文').lite.status, 'cancelled')
  assert.equal(promptCount(), 3)
  await reader.cancel()
  await collect
  await stop()

  await start() // fake ACP replays no history; local journal restores display only
  await api('POST', '/api/sessions/load', { sessionId, cwd: work })
  const reloaded = await api('GET', `/api/history?sessionId=${sessionId}&tail=5`)
  const rows = reloaded.turns.flat().filter(u => u.sessionUpdate === 'user_message_chunk')
  assert.deepEqual(rows.map(u => u.content.text), [fullText, '网页插话', '排队但未完成的正文'])
  assert.deepEqual(rows.map(u => u.lite.source), ['controller', 'gui', 'bridge'])
  assert.deepEqual(rows.map(u => u.lite.status), ['completed', 'completed', 'cancelled'])
  assert.equal(promptCount(), 3, 'reload never re-executes a displayed message')
  console.log('bridge message visibility: OK')
} finally {
  await stop()
  const parent = resolve(dirname(work)).toLowerCase()
  assert.equal(parent, resolve(tmpdir()).toLowerCase())
  assert.ok(basename(work).startsWith('devin-lite-visible-'))
  rmSync(work, { recursive: true, force: true })
}
