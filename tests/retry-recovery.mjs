// Regression test for one ACP entry point, restart controls and retry pacing.
// The test copies server.mjs and fake fixtures into a unique temporary root:
// server.mjs therefore cannot read or write the production deferred queue.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const TEMP_PREFIX = 'devin-lite-retry-'
const WORK = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
const STATE = join(WORK, 'fake-state.json')
const START_LOG = join(WORK, 'acp-start-log.jsonl')
const PROMPT_LOG = join(WORK, 'prompt-log.jsonl')
const QUEUE = join(WORK, 'deferred-prompts.json')
const checks = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let base

function guardedCleanup() {
  const parent = resolve(dirname(WORK)).toLowerCase()
  if (parent !== resolve(tmpdir()).toLowerCase() || !basename(WORK).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove unexpected test directory: ${WORK}`)
  }
  rmSync(WORK, { recursive: true, force: true })
}

function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function lines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function setState(patch) {
  const previous = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
  writeFileSync(STATE, JSON.stringify({ ...previous, ...patch }))
}

async function freePort() {
  const probe = createServer()
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolvePromise)
  })
  const port = probe.address().port
  await new Promise(resolvePromise => probe.close(resolvePromise))
  return port
}

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function until(predicate, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await sleep(75)
  }
  throw new Error(`test condition timed out after ${timeoutMs} ms`)
}

function startServer() {
  if (child) throw new Error('test server is already running')
  child = spawn(process.execPath, [join(WORK, 'server.mjs'), base.split(':').at(-1)], {
    cwd: WORK,
    env: {
      ...process.env,
      DEVIN_EXE: process.execPath,
      DEVIN_LITE_CAPACITY_SCRIPT: join(WORK, 'fake-capacity.py'),
      DEVIN_LITE_PYTHON: process.env.DEVIN_LITE_TEST_PYTHON ?? 'python',
      DEVIN_LITE_RETRY_POLL_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write(`  [test-server] ${chunk}`))
  child.stderr.on('data', chunk => process.stdout.write(`  [test-server!] ${chunk}`))
}

async function stopServer() {
  const processToStop = child
  if (!processToStop) return true
  child = undefined
  if (processToStop.exitCode !== null || processToStop.signalCode !== null) return true
  const exited = new Promise(resolvePromise => processToStop.once('exit', resolvePromise))
  processToStop.kill()
  await Promise.race([exited, sleep(4000)])
  if (processToStop.exitCode === null && processToStop.signalCode === null) {
    processToStop.kill('SIGKILL')
    await Promise.race([exited, sleep(2000)])
  }
  return processToStop.exitCode !== null || processToStop.signalCode !== null
}

async function waitServer() {
  await until(async () => {
    try { return (await api('GET', '/api/archived')).status === 200 } catch { return false }
  }, 10_000)
}

async function nextQueued() {
  return until(async () => {
    const response = await api('GET', '/api/queue')
    return response.body?.pending?.find(entry => entry.state === 'queued')
  })
}

async function drop(queueId) {
  const response = await api('POST', '/api/queue/drop', { queueId })
  check(`drop ${queueId}`, response.status === 200 && response.body?.removed === 1)
}

async function rejectedPrompt(text, errorMessage) {
  writeFileSync(PROMPT_LOG, '')
  setState({ promptMode: 'reject', rejectMessage: errorMessage, rejectData: undefined })
  const response = await api('POST', '/api/prompt', { sessionId: 's1', cwd: WORK, text })
  const first = await until(() => lines(PROMPT_LOG).find(row => row.text === text))
  const queued = await nextQueued()
  return { response, first, queued, deadline: new Date(queued.retryAt).getTime() }
}

async function run() {
  copyFileSync(join(SOURCE_ROOT, 'server.mjs'), join(WORK, 'server.mjs'))
  copyFileSync(join(FIXTURES, 'acp'), join(WORK, 'acp'))
  copyFileSync(join(FIXTURES, 'fake-capacity.py'), join(WORK, 'fake-capacity.py'))
  base = `http://127.0.0.1:${await freePort()}`
  writeFileSync(START_LOG, '')
  writeFileSync(PROMPT_LOG, '')
  setState({
    capacity: { active: 0, limit: 10 }, promptMode: 'ok',
    sessions: [{ sessionId: 's1', title: 'test', cwd: WORK, updatedAt: new Date().toISOString() }],
  })

  startServer()
  await waitServer()
  const health = await api('GET', '/api/health')
  check('health does not spawn ACP', health.status === 200 && lines(START_LOG).length === 0)

  const statuses = await Promise.all(Array.from({ length: 3 }, () => api('GET', '/api/status')))
  check('concurrent status initializes one ACP', statuses.every(r => r.status === 200 && r.body?.agentInfo?.name === 'fake-devin') && lines(START_LOG).length === 1)

  const restarted = await api('POST', '/api/agent/restart', {})
  await until(() => lines(START_LOG).length >= 2)
  check('idle ACP restarts on request', restarted.status === 200 && lines(START_LOG).length === 2)

  setState({ promptMode: 'hang' })
  const running = await api('POST', '/api/prompt', { sessionId: 's1', cwd: WORK, text: 'keep-busy' })
  await until(() => lines(PROMPT_LOG).some(row => row.text === 'keep-busy'))
  const busyRestart = await api('POST', '/api/agent/restart', {})
  check('active turn blocks restart', running.status === 200 && busyRestart.status === 409)
  // A child crash must reject pending ACP requests so the running turn
  // settles instead of remaining stuck in "sending" forever.
  process.kill(lines(START_LOG).at(-1).pid)
  const afterCrash = await nextQueued()
  check('ACP crash releases its in-flight request',
    afterCrash.state === 'queued' && afterCrash.preview === 'keep-busy'
      && new Date(afterCrash.retryAt).getTime() >= Date.now() + 25_000)
  await drop(afterCrash.queueId)
  if (!(await stopServer())) throw new Error('test server did not stop after busy case')
  startServer()
  await waitServer()

  // The exact backend phrase that previously bypassed the retry-time parser.
  const oneMinute = await rejectedPrompt('one-minute',
    'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 1 minute. (trace ID: test)')
  check('reset in 1 minute sets a >=60s deadline', oneMinute.response.status === 200 && oneMinute.deadline - oneMinute.first.at >= 60_000,
    `delay=${oneMinute.deadline - oneMinute.first.at}ms`)
  await sleep(1500)
  check('one minute error does not resend immediately', lines(PROMPT_LOG).length === 1)
  await drop(oneMinute.queued.queueId)

  const twoMinutes = await rejectedPrompt('two-minutes',
    'Too many concurrent sessions; please wait 2 minutes before retrying.')
  check('wait 2 minutes sets a >=120s deadline', twoMinutes.response.status === 200 && twoMinutes.deadline - twoMinutes.first.at >= 120_000,
    `delay=${twoMinutes.deadline - twoMinutes.first.at}ms`)
  await drop(twoMinutes.queued.queueId)

  const undated = await rejectedPrompt('no-reset-time',
    'Reached free model rate limit. Upgrade to Max for higher limits.')
  check('undated concurrency error waits >=30s', undated.response.status === 200 && undated.deadline - undated.first.at >= 29_500,
    `delay=${undated.deadline - undated.first.at}ms`)
  await sleep(1500)
  check('undated concurrency error does not resend immediately', lines(PROMPT_LOG).length === 1)
  setState({ promptMode: 'ok' })
  const secondAttempt = await until(() => lines(PROMPT_LOG)[1], 35_000)
  check('undated rejection retries when 30s deadline arrives',
    secondAttempt.at - undated.first.at >= 30_000 && secondAttempt.at - undated.first.at < 35_000,
    `actual delay=${secondAttempt.at - undated.first.at}ms`)
  const queueCleared = await until(async () => (await api('GET', '/api/queue')).body.pending.length === 0)
  check('successful retry removes the queued item', queueCleared)
  if (!(await stopServer())) throw new Error('test server did not stop before recovery case')

  // Persisted `sending` work has an uncertain outcome; boot must preserve it
  // and enforce a fresh retry floor before any possible re-dispatch.
  writeFileSync(PROMPT_LOG, '')
  const lastAttemptAt = Date.now()
  writeFileSync(QUEUE, JSON.stringify([{
    queueId: 'q-recovered-sending', sessionId: 's1', cwd: WORK,
    text: 'recovered-sending', images: [], committed: false, state: 'sending',
    attempts: 1, queuedAt: lastAttemptAt - 1000, lastAttemptAt,
    retryAt: lastAttemptAt - 1000, lastCheckAt: lastAttemptAt - 1000,
  }]))
  setState({ promptMode: 'ok' })
  startServer()
  await waitServer()
  const queueResponse = await api('GET', '/api/queue')
  const recovered = queueResponse.body?.pending?.find(entry => entry.queueId === 'q-recovered-sending')
  const recoveryAt = new Date(recovered?.retryAt).getTime()
  check('persisted sending entry recovers behind 30s floor', recovered?.state === 'queued' && recoveryAt >= lastAttemptAt + 30_000,
    `delay=${recoveryAt - lastAttemptAt}ms`)
  await sleep(1500)
  check('persisted sending entry does not replay at boot', lines(PROMPT_LOG).length === 0)
  await drop('q-recovered-sending')

  const failures = checks.filter(result => !result.pass)
  console.log(`${checks.length - failures.length}/${checks.length} checks passed`)
  if (failures.length) process.exitCode = 1
}

try {
  await run()
} catch (error) {
  console.error('TEST ERROR:', error)
  process.exitCode = 1
} finally {
  const stopped = await stopServer()
  if (stopped) guardedCleanup()
  else {
    console.error(`test server remained alive; preserving ${WORK} for inspection`)
    process.exitCode = 1
  }
}
