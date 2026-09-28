/**
 * devin-lite — a minimal GUI bridge for `devin acp` (Agent Client Protocol).
 *
 * One Node process: spawns one `devin acp` child on demand, speaks newline-
 * delimited JSON-RPC over stdio, exposes a small REST API + SSE event stream,
 * and serves the single-page UI from ./public. Zero npm dependencies.
 *
 * Run:  node server.mjs [port]   (default 8317, or env DEVIN_LITE_PORT)
 */

import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

/** PID of the devin acp child we spawned — lets a later server reap orphans. */
const PID_FILE = join(ROOT, 'devin-lite.acp.pid')

/** Kill a whole process tree, best-effort. */
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
}

/** Executable image name for a PID, '' when the process does not exist. */
function processImage(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return /"([^"]+)"/.exec(out)?.[1] ?? ''
  } catch { return '' }
}
const PUBLIC_DIR = join(ROOT, 'public')
const PORT = Number(process.env.DEVIN_LITE_PORT ?? process.argv[2] ?? 8317)
const DEVIN_EXE = process.env.DEVIN_EXE ?? 'devin'

// ---------------------------------------------------------------------------
// Capacity gate for ordinary deferred bridge work
// ---------------------------------------------------------------------------
// The local gate runs swe_capacity.py (busy lite sessions + CLI invocations +
// self-registered subagents, same accounting the bridge uses). GUI sends and
// external-controller interjections bypass this queue and report rejection.
const CAPACITY_SCRIPT = process.env.DEVIN_LITE_CAPACITY_SCRIPT
  ?? 'C:\\Users\\ASUS\\.codex\\skills\\devin-session-collaboration\\scripts\\swe_capacity.py'
const CAPACITY_PYTHON = process.env.DEVIN_LITE_PYTHON ?? 'python'
/** Fixed ten-slot bound, matching the shared admission rule. */
const CAPACITY_FALLBACK_LIMIT = 10
/** Never submit a rejected prompt again before this interval. */
const MIN_RETRY_MS = 30_000
/** How often a capacity-blocked queue rechecks the shared slot count. */
const RETRY_POLL_MS = Math.min(600_000, Math.max(MIN_RETRY_MS, Number(process.env.DEVIN_LITE_RETRY_POLL_MS ?? MIN_RETRY_MS)))
/** After this long with no readable capacity, try one deferred prompt anyway —
 * the agent's own rejection is the authoritative full/empty signal. */
const PROBE_AFTER_MS = Math.min(3_600_000, Math.max(60_000, Number(process.env.DEVIN_LITE_PROBE_AFTER_MS ?? 300_000)))
const QUEUE_FILE = join(ROOT, 'deferred-prompts.json')
const CONCURRENCY_RE = new RegExp(
  process.env.DEVIN_LITE_CONCURRENCY_RE
  ?? 'concurren|rate.?limit|too many|too.{0,5}quick|429|resource.?exhaust|quota|usage.?limit|capacity|insufficient.{0,12}(quota|capacity|fund|balance)',
  'i')

/** IDE-host env markers that break `devin acp` when inherited. */
const AMBIENT_TOMBSTONE = /^(ELECTRON_|WINDSURF_|VSCODE_|ACP_)/

const log = (...args) => console.log(`[devin-lite ${new Date().toISOString().slice(11, 19)}]`, ...args)

// ---------------------------------------------------------------------------
// ACP subprocess
// ---------------------------------------------------------------------------

class DevinAcp {
  child = undefined
  nextId = 0
  /** id -> { resolve, reject } for client->agent requests. */
  pending = new Map()
  /** requestId -> respond(result) for agent->client requests we keep open. */
  inbound = new Map()
  agentInfo = {}
  capabilities = {}
  authMethods = []
  authed = false
  starting = undefined
  restarting = undefined
  /** sessionId -> cwd for sessions loaded/created in this process. */
  loaded = new Map()
  /**
   * sessionId -> buffered update list. `session/load` replays full history as
   * updates; buffering lets the client page in only the turns it renders.
   */
  histories = new Map()
  /** sessionIds mid-replay: their updates buffer instead of broadcasting. */
  loading = new Set()
  /** sessionId -> in-flight session/prompt count (interjections share a session). */
  busy = new Map()
  /**
   * sessionId -> FIFO of { text, buf, images } suppression records, one per
   * in-flight prompt. Sent messages are pushed into the history buffer
   * immediately; devin's live echo of them (when it comes) is suppressed here
   * so a reload neither loses the message nor shows it twice — suppression
   * must live server-side to survive the client switching sessions mid-turn.
   * A queue, not a single record: interjecting into a running session keeps
   * two prompts in flight and each needs its own suppression.
   */
  echoPending = new Map()
  listeners = new Set()

  emit(payload) {
    for (const sink of this.listeners) {
      try { sink(payload) } catch { /* a dead SSE sink is removed on write error */ }
    }
  }

  send(message) {
    this.child?.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method, params, timeoutMs = 0) {
    const child = this.child
    if (child === undefined || child.killed || child.exitCode !== null || child.stdin.destroyed) {
      return Promise.reject(Object.assign(new Error('devin acp is not running'), { agentDown: true }))
    }
    const id = `c-${++this.nextId}`
    return new Promise((resolvePromise, reject) => {
      let timer
      const clear = () => { if (timer !== undefined) clearTimeout(timer) }
      this.pending.set(id, {
        resolve: (value) => { clear(); resolvePromise(value) },
        reject: (error) => { clear(); reject(error) },
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          const error = Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { agentDown: true })
          reject(error)
          if (this.child === child) {
            this.teardown(child, error)
            if (Number.isInteger(child.pid)) killTree(child.pid)
          }
        }, timeoutMs)
      }
      const failWrite = (error) => {
        if (!this.pending.has(id)) return
        const failure = Object.assign(error, { agentDown: true })
        this.teardown(child, failure)
        if (Number.isInteger(child.pid)) killTree(child.pid)
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
          if (error) failWrite(error)
        })
      } catch (error) { failWrite(error) }
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Answer one agent->client request we chose to keep open (permissions). */
  answer(requestId, result) {
    if (!this.inbound.delete(requestId)) return false
    this.send({ jsonrpc: '2.0', id: requestId, result })
    return true
  }

  /** Drop one echo-suppression record; forget the session when none remain. */
  dropEcho(sessionId, rec) {
    const echos = this.echoPending.get(sessionId)
    if (echos === undefined) return
    const i = echos.indexOf(rec)
    if (i >= 0) echos.splice(i, 1)
    if (echos.length === 0) this.echoPending.delete(sessionId)
  }

  /** Devin Desktop credential store supplies the key authenticate() accepts. */
  storedApiKey() {
    const appdata = process.env.APPDATA
    const candidates = [
      ...(appdata === undefined ? [] : [join(appdata, 'devin', 'credentials.toml')]),
      join(homedir(), '.config', 'devin', 'credentials.toml'),
    ]
    for (const candidate of candidates) {
      try {
        const match = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(readFileSync(candidate, 'utf8'))
        if (match?.[1] !== undefined) return match[1]
      } catch { /* next candidate */ }
    }
    return undefined
  }

  async authenticate() {
    const method = this.authMethods[0]
    if (method === undefined) throw new Error('agent advertised no auth methods')
    const apiKey = process.env.WINDSURF_API_KEY ?? this.storedApiKey()
    await this.request('authenticate', {
      methodId: method.id,
      ...(apiKey === undefined ? {} : { _meta: { api_key: apiKey } }),
    })
    this.authed = true
  }

  /** Retry the call once after authenticate() when the agent demands auth. */
  async withAuth(fn) {
    try {
      return await fn()
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== -32000) throw error
      await this.authenticate()
      return fn()
    }
  }

  async ensure() {
    if (this.starting !== undefined) return this.starting
    if (this.child !== undefined && !this.child.killed && this.child.exitCode === null) return
    this.starting ??= this.spawn()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async spawn() {
    // Reap an acp child orphaned by a previous devin-lite server: it still
    // holds its session locks and would poison every session/load. Only kill
    // when the PID is really a devin process (guards against PID reuse).
    try {
      const stale = Number(readFileSync(PID_FILE, 'utf8').trim())
      if (Number.isInteger(stale) && stale > 0 && /devin/i.test(processImage(stale))) {
        log('reaping orphaned devin acp', stale)
        killTree(stale)
      }
    } catch { /* no stale pid marker */ }

    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (AMBIENT_TOMBSTONE.test(key)) delete env[key]
    }
    const child = spawn(DEVIN_EXE, ['acp'], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    try { writeFileSync(PID_FILE, String(child.pid)) } catch { /* marker is best-effort */ }
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trimEnd()
      if (line.length > 0) log('devin stderr:', line.slice(0, 300))
    })
    child.on('error', (error) => {
      log('devin spawn error:', error.message)
      this.teardown(child, error)
    })
    child.on('close', (code, signal) => {
      log('devin acp exited', code ?? signal)
      this.teardown(child, Object.assign(new Error(`devin acp exited (code ${code ?? signal})`), { agentDown: true }))
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => { if (this.child === child) this.onLine(line) })

    try {
      const init = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'devin-lite', version: '0.1.0' },
      }, 15_000)
      if (this.child !== child) throw Object.assign(new Error('devin acp exited during initialize'), { agentDown: true })
      this.capabilities = init.agentCapabilities ?? {}
      this.authMethods = init.authMethods ?? []
      this.agentInfo = init.agentInfo ?? {}
      log('devin acp ready:', this.agentInfo.name ?? 'agent', this.agentInfo.version ?? '')
      this.emit({ kind: 'agent-ready', agentInfo: this.agentInfo })
    } catch (error) {
      if (this.child === child) {
        this.teardown(child, error)
        if (Number.isInteger(child.pid)) killTree(child.pid)
      }
      throw error
    }
  }

  teardown(child, error) {
    if (this.child !== child) return
    const childPid = child.pid
    // Snapshot before clear(): retaining the Map itself would empty `failed`
    // too, leaving every in-flight request hung after an ACP crash.
    const failed = [...this.pending.values()]
    this.pending.clear()
    this.inbound.clear()
    this.loaded.clear()
    this.histories.clear()
    this.loading.clear()
    this.echoPending.clear()
    this.child = undefined
    this.authed = false
    this.agentInfo = {}
    this.capabilities = {}
    this.authMethods = []
    try {
      if (childPid !== undefined && readFileSync(PID_FILE, 'utf8').trim() === String(childPid)) unlinkSync(PID_FILE)
    } catch { /* marker already gone */ }
    for (const { reject } of failed) reject(error)
    this.emit({ kind: 'agent-down', message: String(error.message ?? error) })
  }

  /** Recycle only this server's own idle ACP child; a disconnected child starts fresh. */
  async restart() {
    if (this.restarting !== undefined) return this.restarting
    this.restarting = (async () => {
      if (this.starting !== undefined) await this.starting.catch(() => {})
      const child = this.child
      if (child !== undefined) {
        if (this.busy.size > 0) throw httpError(409, 'Devin 正在处理回合，请等待完成后再重启')
        const closed = new Promise((resolveClosed) => {
          let timer
          const done = () => { clearTimeout(timer); resolveClosed() }
          child.once('close', done)
          timer = setTimeout(() => { child.off('close', done); resolveClosed() }, 2_000)
        })
        try { child.stdin.end() } catch { /* the child may already be closing */ }
        await closed
        if (this.child === child) {
          if (Number.isInteger(child.pid)) killTree(child.pid)
          this.teardown(child, Object.assign(new Error('Devin ACP restarted'), { agentDown: true }))
        }
      }
      await this.ensure()
      return { agentInfo: this.agentInfo, capabilities: this.capabilities, authed: this.authed }
    })()
    try { return await this.restarting } finally { this.restarting = undefined }
  }

  onLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve: resolvePending, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) {
        reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }))
      } else {
        resolvePending(message.result)
      }
      return
    }
    if (message.id !== undefined) {
      // Agent -> client request.
      this.onAgentRequest(message)
      return
    }
    // Notification.
    if (message.method === 'session/update') {
      const params = message.params
      let update = params.update
      // Swallow devin's live echo of a prompt we already buffered synthetically.
      const echos = this.echoPending.get(params.sessionId)
      if (echos !== undefined && update.sessionUpdate === 'user_message_chunk') {
        const t = update.content?.type
        if (t === 'image') {
          const ep = echos.find(e => e.images > 0)
          if (ep !== undefined) {
            ep.images--
            if (ep.images === 0 && ep.buf === ep.text) this.dropEcho(params.sessionId, ep)
            return
          }
        }
        if (t === 'text') {
          const chunk = update.content.text ?? ''
          // Attribute the chunk to whichever in-flight prompt it continues —
          // echoes of interleaved same-session prompts do not arrive in order.
          const ep = echos.find(e => e.buf.length < e.text.length && e.text.startsWith(e.buf + chunk))
          if (ep !== undefined) {
            ep.buf += chunk
            if (ep.buf === ep.text && ep.images === 0) this.dropEcho(params.sessionId, ep)
            return
          }
          // No pending prompt accepts this chunk. If a record accumulated a
          // partial echo that now diverges, surface it merged with the chunk
          // rather than losing either side.
          const stuck = echos.find(e => e.buf.length > 0)
          if (stuck !== undefined) {
            this.dropEcho(params.sessionId, stuck)
            update = { ...update, content: { ...update.content, text: stuck.buf + chunk } }
          }
        }
      }
      const history = this.histories.get(params.sessionId)
      if (history !== undefined) {
        history.updates.push(update)
        if (history.updates.length > HISTORY_CAP) {
          history.updates.splice(0, history.updates.length - HISTORY_CAP)
          history.truncated = true
        }
      }
      // While a session is loading its replay is buffered, not broadcast; the
      // client pages it in via /api/history after load resolves.
      if (!this.loading.has(params.sessionId)) {
        this.emit({ kind: 'update', ...params, update })
      }
    } else {
      this.emit({ kind: 'notification', method: message.method, params: message.params })
    }
  }

  onAgentRequest(message) {
    if (message.method === 'session/request_permission') {
      // Bridge 'bypass' sessions auto-approve — the ACP equivalent of the
      // CLI's --permission-mode dangerous. GUI sessions keep the manual flow.
      if (autoApproveSessions.has(message.params?.sessionId)) {
        const options = Array.isArray(message.params.options) ? message.params.options : []
        const pick = options.find(o =>
          /allow|always|approve|accept|yes/i.test(`${o.optionId ?? ''} ${o.name ?? ''} ${o.kind ?? ''}`))
          ?? options[0]
        const result = pick === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: pick.optionId } }
        this.send({ jsonrpc: '2.0', id: message.id, result })
        this.emit({ kind: 'permission-auto', sessionId: message.params.sessionId, optionId: pick?.optionId, toolCall: message.params.toolCall })
        return
      }
      this.inbound.set(message.id, message.params)
      this.emit({ kind: 'permission', requestId: message.id, ...message.params })
      return
    }
    // fs/*, terminal/*, elicitation, etc: we advertise no such capabilities,
    // but refuse cleanly rather than hang if the agent asks anyway.
    this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `devin-lite: unhandled ${message.method}` } })
  }

  /** Load the session into this process when it is not bound yet. */
  async ensureLoaded(sessionId, cwd) {
    // The deferred-queue pump can reach here before any REST call spawned the
    // agent — without ensure() the request would be written to no process.
    try { await this.ensure() } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { agentDown: true })
    }
    if (this.loaded.has(sessionId)) return
    // Replay updates buffer for paging; a fresh buffer replaces a stale one.
    this.loading.add(sessionId)
    this.histories.set(sessionId, { updates: [], truncated: false })
    try {
      const result = await this.withAuth(() => this.request('session/load', { sessionId, cwd, mcpServers: [] }))
      this.loaded.set(sessionId, cwd)
      return result
    } finally {
      this.loading.delete(sessionId)
      this.emit({ kind: 'history-ready', sessionId })
    }
  }

  async newSession(cwd) {
    const created = await this.withAuth(() => this.request('session/new', { cwd, mcpServers: [] }))
    this.loaded.set(created.sessionId, cwd)
    this.histories.set(created.sessionId, { updates: [], truncated: false })
    return created
  }

  async prompt(sessionId, cwd, text, images = [], commit = true, echo) {
    await this.ensureLoaded(sessionId, cwd)
    // Commit the sent message to history immediately — whether or not devin
    // echoes it back, the message must exist in the buffer for reloads.
    // Deferred-queue retries pass commit=false: the entry was already
    // committed when it was queued, and re-pushing would show it twice.
    const history = this.histories.get(sessionId)
    if (history !== undefined && commit) {
      for (const img of images) {
        history.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: img.data, mimeType: img.mimeType } })
      }
      if (text.trim() !== '') {
        history.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
      }
    }
    // Caller may own the suppression record (dispatchPrompt) so settling one
    // prompt doesn't strip a sibling interjection's suppression.
    const rec = echo ?? { text, buf: '', images: images.length }
    const echos = this.echoPending.get(sessionId) ?? []
    echos.push(rec)
    this.echoPending.set(sessionId, echos)
    const prompt = [
      ...images.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
      ...(text.trim() === '' ? [] : [{ type: 'text', text }]),
    ]
    return this.request('session/prompt', { sessionId, prompt })
  }
}

/** Max buffered updates kept per session for history paging. */
const HISTORY_CAP = 4000

const acp = new DevinAcp()

/**
 * Split buffered updates into turns: a new turn opens at the first user
 * message chunk that follows any non-user content.
 */
function splitTurns(updates) {
  const turns = []
  let current = []
  for (const update of updates) {
    if (update.sessionUpdate === 'user_message_chunk'
      && current.some(u => u.sessionUpdate !== 'user_message_chunk')) {
      turns.push(current)
      current = []
    }
    current.push(update)
  }
  if (current.length > 0) turns.push(current)
  return turns
}

/**
 * Distill a session's buffered tail into a bridge prompt: the latest user
 * intent, the trailing assistant output of the last turn, and open plan
 * items — compact enough to seed a fresh session.
 */
function bridgeText(sessionId, cwd, updates) {
  // Last turn's user text: trailing consecutive user chunks.
  let userText = ''
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i]
    if (u.sessionUpdate !== 'user_message_chunk') continue
    const parts = []
    let j = i
    while (j >= 0 && updates[j].sessionUpdate === 'user_message_chunk' && updates[j].content?.type === 'text') {
      parts.unshift(updates[j].content.text)
      j--
    }
    userText = parts.join('')
    break
  }
  // Assistant output of the last turn (stop at the last user chunk).
  const tail = []
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i]
    if (u.sessionUpdate === 'user_message_chunk') break
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') tail.unshift(u.content.text)
    if (tail.join('').length > 3000) break
  }
  // Latest plan, open items only.
  let planLines = []
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i]
    if (u.sessionUpdate === 'plan' && Array.isArray(u.entries)) {
      planLines = u.entries
        .filter(e => e.status !== 'completed')
        .map(e => `- [${e.status ?? 'pending'}] ${typeof e.content === 'string' ? e.content : ''}`)
        .filter(l => !l.endsWith('] '))
      break
    }
  }
  const parts = [
    `【上下文续接】上一个会话（ID：${sessionId}，目录：${cwd}）上下文已满。`,
    userText && `最近任务：\n${userText.slice(0, 1500)}`,
    tail.length > 0 && `最近进展（尾部摘录）：\n${tail.join('').slice(-3000)}`,
    planLines.length > 0 && `未完成计划：\n${planLines.join('\n')}`,
    '请在此基础上继续原任务。',
  ].filter(Boolean)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// HTTP + SSE
// ---------------------------------------------------------------------------

const sseClients = new Set()
acp.listeners.add((payload) => {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(frame) } catch { sseClients.delete(res) }
  }
})

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunks.length > 4096) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({})
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Local image staging & preview
// ---------------------------------------------------------------------------
// Shared size cap for image upload (POST /api/attach) and preview reads
// (GET /api/image-preview). Bodies buffer fully before any file is written,
// so an over-cap or invalid upload never leaves a partial file behind.
const IMAGE_BYTES_CAP = 25 * 1024 * 1024
const ATTACH_DIR = join(ROOT, 'attachments')
const ATTACH_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif',
  'image/svg+xml': '.svg',
}
const IMAGE_MIME = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
}

/** Raster magic-byte detector — type comes from content, never the name. */
function sniffImageKind(buf) {
  if (buf.length >= 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
    if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]/.test(buf.toString('latin1', 8, 12))) return 'avif'
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  }
  if (buf.length >= 6 && /^GIF8[79]a/.test(buf.toString('latin1', 0, 6))) return 'gif'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return undefined
}

/** Collect a raw request body with a hard byte cap (no partial-file risk). */
function readRawBody(req, cap) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    // Over-cap bodies are drained and discarded — destroying the socket would
    // reset the connection before the 413 response could be written.
    req.on('data', (chunk) => {
      total += chunk.length
      if (total <= cap) chunks.push(chunk)
    })
    req.on('end', () => {
      if (total > cap) return reject(httpError(413, 'image too large'))
      resolvePromise(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/**
 * Windows absolute raster-image path inside message text. Path segments may
 * contain spaces and CJK (both legal in NTFS names); the match ends at the
 * image extension and refuses to extend through `.` or a word char, so
 * "a.png这张" / "a.png.txt" / "a.pngx" behave correctly.
 */
const RASTER_PATH_RE = /[A-Za-z]:[\\/](?:[^<>:"|?*\\/\r\n]+[\\/])*[^<>:"|?*\\/\r\n]*?\.(?:png|jpe?g|gif|webp|bmp|avif)(?![\w.])/gi

function requireDir(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw Object.assign(new Error('cwd must be an absolute path'), { status: 400 })
  const resolved = resolve(value)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${resolved}`), { status: 400 })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// Deferred-prompt queue: capacity-gated admission + timed retry
// ---------------------------------------------------------------------------
// An ordinary bridge prompt enters the queue when the agent rejects it with a
// concurrency/quota error or an earlier same-session item is already queued.
// A timer rechecks every RETRY_POLL_MS and dispatches
// queued prompts as slots free up. A deferred session is NOT busy — it holds
// no slot, so it must not count itself in the check.

let deferredSeq = 0
let deferred = []
let pumping = false
let lastCapacity = undefined

/** Move an unreadable persistence file aside instead of silently losing it. */
function salvageCorrupt(file, label) {
  try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* keep original */ }
  log(`${label} file unreadable — moved aside, starting empty`)
}

function loadQueue() {
  try {
    const raw = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'))
    if (!Array.isArray(raw)) return []
    // History buffers were rebuilt from the agent on restart, so the message
    // needs committing again at dispatch time. An in-flight attempt has an
    // uncertain outcome; never replay it immediately after server recovery.
    return raw.filter(e => typeof e?.sessionId === 'string')
      .map(e => ({
        ...e, committed: false, state: 'queued',
        retryAt: Math.max(
          Number.isFinite(Number(e.retryAt)) ? Number(e.retryAt) : 0,
          e.state === 'sending' ? Date.now() + MIN_RETRY_MS : (Number(e.lastAttemptAt) || 0) + MIN_RETRY_MS,
        ),
      }))
  } catch (error) {
    if (error?.code !== 'ENOENT' && existsSync(QUEUE_FILE)) salvageCorrupt(QUEUE_FILE, 'queue')
    return []
  }
}

function saveQueue() {
  try { writeFileSync(QUEUE_FILE, JSON.stringify(deferred)) } catch { /* advisory */ }
}

function queuePreview(entry) {
  const raw = typeof entry.text === 'string' ? entry.text : ''
  if (entry.source === 'bridge' || entry.turnId !== undefined) {
    const marker = '\nTask for this turn:\n'
    const at = raw.lastIndexOf(marker)
    if (at >= 0) return raw.slice(at + marker.length, at + marker.length + 240)
  }
  return raw.slice(0, 240)
}

function queueView() {
  return deferred.map(e => ({
    queueId: e.queueId, sessionId: e.sessionId, attempts: e.attempts,
    state: e.state === 'sending' ? 'sending' : 'queued',
    source: e.source ?? (e.turnId === undefined ? 'gui' : 'bridge'),
    preview: queuePreview(e),
    textLength: typeof e.text === 'string' ? e.text.length : 0,
    imageCount: Array.isArray(e.images) ? e.images.length : 0,
    queuedAt: new Date(e.queuedAt).toISOString(), lastError: e.lastError,
    retryAt: e.retryAt === undefined ? undefined : new Date(e.retryAt).toISOString(),
  }))
}

let capacityInflight
/** Shared-account slot usage from swe_capacity.py; null when unreadable. */
function capacitySnapshot() {
  capacityInflight ??= new Promise((resolvePromise) => {
    const child = spawn(CAPACITY_PYTHON, [CAPACITY_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 30_000)
    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => { clearTimeout(timer); resolvePromise(null) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(out)
        if (typeof parsed.active !== 'number' || typeof parsed.limit !== 'number') throw new Error('bad shape')
        resolvePromise({ active: parsed.active, limit: parsed.limit,
          available: Math.max(0, parsed.limit - parsed.active), at: Date.now() })
      } catch { resolvePromise(null) }
    })
  }).finally(() => { capacityInflight = undefined })
  return capacityInflight
}

const isConcurrencyError = (error) => CONCURRENCY_RE.test(String(error?.message ?? error))

/** Retry offset appended to the wait the backend itself advertises. */
const RETRY_AFTER_BUFFER_MS = 5_000

/**
 * When a turn dies mid-execution on a concurrency rejection, the error may
 * carry the backend's own wait time — retry at that time +5s rather than
 * polling. Checked shapes: structured fields (retry_after*, reset*, unix
 * epoch seconds/ms) and message text like "retry in 42s" / "42秒后重试".
 * Returns undefined when no wait time is advertised.
 */
function parseRetryAfterMs(error) {
  // Structured fields may sit one level deep (error.data._meta/details).
  const bags = [error?.data, error?.data?._meta, error?.data?.details]
  for (const data of bags) {
    if (!data || typeof data !== 'object') continue
    for (const key of ['retry_after_ms', 'retryAfterMs', 'retry_after', 'retryAfter', 'retry_after_seconds']) {
      const value = Number(data[key])
      if (Number.isFinite(value) && value > 0) {
        return (key.endsWith('_ms') || key === 'retryAfterMs' ? value : value * 1000) + RETRY_AFTER_BUFFER_MS
      }
    }
    for (const key of ['reset_at_unix', 'retry_at_unix', 'daily_quota_reset_at_unix', 'reset_at', 'retry_at']) {
      const value = Number(data[key])
      if (Number.isFinite(value) && value > 0) {
        const at = value > 1e12 ? value : value * 1000
        const wait = at - Date.now()
        if (wait > 0 && wait < 86_400_000) return wait + RETRY_AFTER_BUFFER_MS
      }
    }
  }
  const message = String(error?.message ?? error ?? '')
  if (/retry|again|wait|reset|limit|重试|稍后|稍候|稍等|等待|恢复|after|later|后|分钟/i.test(message)) {
    const unit = /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|minutes?|mins?|seconds?|secs?|hours?|hrs?|hr|ms|min|sec|m|s|h|毫秒|分钟|小时|秒|分)(?![a-zA-Z])/i.exec(message)
    if (unit) {
      const n = Number(unit[1])
      if (Number.isFinite(n) && n > 0) {
        const u = unit[2].toLowerCase()
        const mult = /^(ms|msec|millisecond|毫秒)/.test(u) ? 1
          : /^(m|min|minute|分钟|分)/.test(u) ? 60_000
          : /^(h|hr|hour|小时)/.test(u) ? 3_600_000
          : 1_000
        const wait = n * mult
        if (wait <= 86_400_000) return wait + RETRY_AFTER_BUFFER_MS
      }
    }
    const bare = /retry.{0,16}(\d+)/i.exec(message)
    if (bare) {
      const n = Number(bare[1])
      if (Number.isFinite(n) && n > 0 && n <= 86_400) return n * 1000 + RETRY_AFTER_BUFFER_MS
    }
  }
  return undefined
}

/** Push the queued message into the history buffer so it shows before it runs. */
function commitDeferred(entry) {
  if (entry.committed) return // a re-deferred send already pushed its copy
  const history = acp.histories.get(entry.sessionId)
  if (history === undefined) return
  for (const img of entry.images) {
    history.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: img.data, mimeType: img.mimeType } })
  }
  if (entry.text.trim() !== '') {
    history.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: entry.text } })
  }
  entry.committed = true
}

function deferPrompt(entry, reason, retryAfterMs) {
  entry.queueId ??= `q-${Date.now()}-${++deferredSeq}`
  entry.lastError = String(reason)
  entry.retryAt = Date.now() + Math.max(MIN_RETRY_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
  entry.state = 'queued'
  commitDeferred(entry)
  // A re-deferred entry keeps its position so a session's queued messages
  // cannot be overtaken by their own later prompts.
  if (!deferred.includes(entry)) deferred.push(entry)
  saveQueue()
  const position = deferred.indexOf(entry) + 1
  const waitSeconds = Math.max(0, Math.round((entry.retryAt - Date.now()) / 1000))
  acp.emit({
    kind: 'prompt-deferred', sessionId: entry.sessionId, queueId: entry.queueId,
    position, reason: entry.lastError, attempts: entry.attempts,
    retryAt: new Date(entry.retryAt).toISOString(), waitSeconds,
    ...(entry.clientMessageId !== undefined ? { clientMessageId: entry.clientMessageId } : {}),
  })
  if (entry.turnId !== undefined) {
    const turn = bridgeTurns.get(entry.turnId)
    if (turn !== undefined) {
      turnSet(turn, 'deferred', { queueId: entry.queueId, retryAt: entry.retryAt, lastError: entry.lastError, attempts: entry.attempts })
    }
  }
  log(`deferred prompt for ${entry.sessionId} (queue ${deferred.length}, retry in ${waitSeconds}s): ${entry.lastError}`)
  schedulePump()
}

/** Remove an entry that reached a terminal outcome (sent, or non-retryable). */
function removeQueued(entry) {
  const idx = deferred.indexOf(entry)
  if (idx === -1) return
  deferred.splice(idx, 1)
  saveQueue()
  acp.emit({ kind: 'queue', pending: deferred.length })
}

/** One in-flight turn attempt; re-defers on concurrency rejection. */
async function dispatchPrompt(entry) {
  const { sessionId } = entry
  entry.state = 'sending'
  // Refcounted busy: a session stays "running" until its LAST in-flight
  // prompt settles — an early-finishing interjection must not expose the
  // still-running sibling to the capacity gate or the queue pump.
  const inflight = (acp.busy.get(sessionId) ?? 0) + 1
  acp.busy.set(sessionId, inflight)
  if (inflight === 1) acp.emit({ kind: 'busy', sessionId, busy: true })
  // This dispatch's own echo-suppression record — settle removes only it,
  // never a sibling interjection still in flight on the same session.
  const ep = { text: entry.text, buf: '', images: entry.images.length }
  const settle = () => {
    const n = (acp.busy.get(sessionId) ?? 1) - 1
    if (n <= 0) acp.busy.delete(sessionId); else acp.busy.set(sessionId, n)
    acp.dropEcho(sessionId, ep)
    if (n <= 0) acp.emit({ kind: 'busy', sessionId, busy: false })
  }
  try {
    // Commit the user message to the history buffer up front — committed
    // stays truthful however the send then fails (even pre-request), so a
    // re-deferred entry never duplicates or loses its transcript row.
    commitDeferred(entry)
    const response = await acp.prompt(sessionId, entry.cwd, entry.text, entry.images, !entry.committed, ep)
    settle()
    removeQueued(entry)
    acp.emit({
      kind: 'prompt-done', sessionId, stopReason: response.stopReason, usage: response.usage,
      ...(entry.clientMessageId !== undefined ? { clientMessageId: entry.clientMessageId } : {}),
    })
    if (entry.turnId !== undefined) {
      const turn = bridgeTurns.get(entry.turnId)
      if (turn !== undefined) turnSet(turn, 'done', { stopReason: response.stopReason, usage: response.usage })
    }
    void pumpDeferred() // the freed slot may release this session's next queued prompt
  } catch (error) {
    settle()
    // Ordinary background work re-queues on concurrency or agent failure.
    // An explicit controller interjection reports the error to its sender.
    if (!entry.priority && (isConcurrencyError(error) || error?.agentDown === true)) {
      deferPrompt(entry, error.message ?? error, parseRetryAfterMs(error))
      void pumpDeferred()
      return
    }
    removeQueued(entry)
    const message = String(error.message ?? error)
    acp.emit({
      kind: 'prompt-done', sessionId, error: message, code: error.code,
      ...(entry.clientMessageId !== undefined ? { clientMessageId: entry.clientMessageId } : {}),
    })
    if (entry.turnId !== undefined) {
      const turn = bridgeTurns.get(entry.turnId)
      if (turn !== undefined) turnSet(turn, 'error', { error: message, code: error.code })
    }
    void pumpDeferred()
  }
}

let pumpTimer
function schedulePump() {
  if (pumpTimer !== undefined) { clearTimeout(pumpTimer); pumpTimer = undefined }
  if (deferred.length === 0) return
  const now = Date.now()
  let wake = Infinity
  for (const e of deferred) {
    if (e.state === 'sending') continue // in-flight; its completion kicks the pump
    const eligible = e.retryAt ?? now
    // Wake when the entry first may dispatch: exactly at its deadline. An
    // entry already past its deadline but still queued was checked and
    // blocked last tick — recheck it on the poll cadence, not a busy loop.
    const term = e.lastCheckAt === undefined || eligible > now
      ? eligible
      : Math.max(eligible, e.lastCheckAt + RETRY_POLL_MS)
    if (term < wake) wake = term
  }
  if (!Number.isFinite(wake)) return
  const delay = Math.max(1_000, Math.min(2_147_483_647, wake - now))
  pumpTimer = setTimeout(() => { pumpTimer = undefined; void pumpDeferred() }, delay)
}

async function pumpDeferred() {
  if (pumping || deferred.length === 0) return
  pumping = true
  try {
    // No capacity probe until at least one entry is actually dispatchable:
    // entries waiting out an advertised retry deadline must not be sent early.
    if (!deferred.some(e => e.state === 'queued' && (e.retryAt ?? 0) <= Date.now() && !acp.busy.has(e.sessionId))) return
    const cap = await capacitySnapshot()
    lastCapacity = cap === null ? { error: 'capacity check failed', at: Date.now() } : cap
    let slots = cap === null ? 0 : Math.max(0, cap.limit - cap.active)
    // Stall probe: slots exhausted or unreadable for a long while → probe one
    // entry at a time; the agent's own rejection re-defers it if still full.
    let probes = 0
    const blocked = new Set()
    for (const entry of deferred) {
      if (entry.state !== 'queued') { blocked.add(entry.sessionId); continue }
      // A session's queued prompts keep order: once one entry this tick can't
      // go (deadline pending, no slot, probe-gated, or its own send in
      // flight), that session's later entries wait for the next tick.
      if (blocked.has(entry.sessionId) || acp.busy.has(entry.sessionId)) {
        entry.lastCheckAt = Date.now()
        continue
      }
      if ((entry.retryAt ?? 0) > Date.now()) { blocked.add(entry.sessionId); continue }
      entry.lastCheckAt = Date.now()
      if (slots > 0) {
        slots--
      } else {
        blocked.add(entry.sessionId)
        if ((entry.lastAttemptAt ?? entry.queuedAt) > Date.now() - PROBE_AFTER_MS) continue
        if (probes >= 1) continue
        probes++
      }
      entry.attempts++
      entry.lastAttemptAt = Date.now()
      acp.emit({
        kind: 'prompt-dispatch', sessionId: entry.sessionId, queueId: entry.queueId, attempt: entry.attempts,
        ...(entry.clientMessageId !== undefined ? { clientMessageId: entry.clientMessageId } : {}),
      })
      if (entry.turnId !== undefined) {
        const turn = bridgeTurns.get(entry.turnId)
        if (turn !== undefined) turnSet(turn, 'running', { attempts: entry.attempts, retryAt: undefined, queueId: undefined, lastError: undefined })
      }
      log(`dispatching deferred prompt for ${entry.sessionId} (attempt ${entry.attempts})`)
      void dispatchPrompt(entry)
    }
    saveQueue()
    acp.emit({ kind: 'queue', pending: deferred.length })
  } finally {
    pumping = false
    schedulePump()
  }
}

deferred = loadQueue()
if (deferred.length > 0) {
  log(`restored ${deferred.length} deferred prompt(s) from queue file`)
  schedulePump()
}

// ---------------------------------------------------------------------------
// Bridge turns: synchronous-to-completion HTTP contract for devin_bridge
// ---------------------------------------------------------------------------
// A turn is the REST equivalent of one `devin --print [--resume]` invocation:
// created by POST /api/bridge/turn/start, tracked through dispatch → deferred
// → done/error/cancelled. Turn state is deliberately process-memory only:
// after a server restart an unknown turnId returns 404 so the bridge marks
// the outcome uncertain instead of silently duplicating work.
let bridgeTurnSeq = 0
/** turnId -> turn record */
const bridgeTurns = new Map()
/** client-supplied idempotency key -> turnId */
const clientTurnIds = new Map()
/** Sessions whose permission requests are auto-answered (bridge 'bypass'). */
const autoApproveSessions = new Set()

const TURN_TERMINAL = new Set(['done', 'error', 'cancelled'])

function newBridgeTurn({ clientTurnId, sessionId }) {
  const turn = {
    turnId: `bt-${Date.now()}-${++bridgeTurnSeq}`,
    clientTurnId, sessionId,
    status: 'running', attempts: 0,
    queueId: undefined, retryAt: undefined, lastError: undefined,
    stopReason: undefined, usage: undefined, error: undefined, code: undefined,
    createdAt: Date.now(), finishedAt: undefined,
    waiters: new Set(),
  }
  bridgeTurns.set(turn.turnId, turn)
  if (clientTurnId !== undefined) clientTurnIds.set(clientTurnId, turn.turnId)
  // Bound memory: drop the oldest finished turns past 500 tracked.
  if (bridgeTurns.size > 500) {
    for (const [id, t] of bridgeTurns) {
      if (TURN_TERMINAL.has(t.status)) bridgeTurns.delete(id)
      if (bridgeTurns.size <= 500) break
    }
  }
  return turn
}

function turnSet(turn, status, patch = {}) {
  if (TURN_TERMINAL.has(turn.status)) return // terminal is final — a late
  // resolution after cancel must not resurrect the turn's status
  Object.assign(turn, patch, { status })
  if (TURN_TERMINAL.has(status)) turn.finishedAt ??= Date.now()
  acp.emit({ kind: 'bridge-turn', turnId: turn.turnId, sessionId: turn.sessionId, status })
  for (const wake of turn.waiters) wake()
}

function turnView(turn) {
  return {
    turnId: turn.turnId,
    ...(turn.clientTurnId !== undefined ? { clientTurnId: turn.clientTurnId } : {}),
    sessionId: turn.sessionId,
    status: turn.status,
    attempts: turn.attempts,
    pendingWaiters: turn.waiters.size,
    ...(turn.queueId !== undefined ? { queueId: turn.queueId } : {}),
    ...(turn.retryAt !== undefined ? { retryAt: new Date(turn.retryAt).toISOString() } : {}),
    ...(turn.lastError != null ? { lastError: turn.lastError } : {}),
    ...(turn.stopReason !== undefined ? { stopReason: turn.stopReason } : {}),
    ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    ...(turn.error !== undefined ? { error: turn.error, code: turn.code } : {}),
    createdAt: new Date(turn.createdAt).toISOString(),
    ...(turn.finishedAt !== undefined ? { finishedAt: new Date(turn.finishedAt).toISOString() } : {}),
  }
}

/** Mark live turns of a session cancelled (session-level cancel/delete/drop). */
function cancelTurnsForSession(sessionId) {
  for (const turn of bridgeTurns.values()) {
    if (turn.sessionId === sessionId && !TURN_TERMINAL.has(turn.status)) {
      turnSet(turn, 'cancelled')
    }
  }
}

// ---------------------------------------------------------------------------
// Session archive: server-side hide/restore persisted across restarts
// ---------------------------------------------------------------------------
// ACP exposes no archive flag, so devin-lite keeps its own metadata in
// archived-sessions.json. Archiving only hides a session from the default
// /api/sessions listing — nothing is deleted or renamed agent-side, and an
// archived session can be restored (or prompted) at any time.
const ARCHIVE_FILE = join(ROOT, 'archived-sessions.json')
/** sessionId -> { archivedAt: epoch ms, cwd?, title? } */
let archived = {}

function loadArchive() {
  try {
    const raw = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8'))
    // Accept both the current {version, sessions:{…}} shape and a bare map.
    const src = raw?.sessions ?? raw
    const out = {}
    if (src !== null && typeof src === 'object' && !Array.isArray(src)) {
      for (const [sessionId, meta] of Object.entries(src)) {
        if (typeof sessionId !== 'string' || meta === null || typeof meta !== 'object') continue
        const archivedAt = Number(meta.archivedAt)
        if (!Number.isFinite(archivedAt)) continue
        out[sessionId] = { archivedAt }
        if (typeof meta.cwd === 'string') out[sessionId].cwd = meta.cwd
        if (typeof meta.title === 'string') out[sessionId].title = meta.title
      }
    }
    return out
  } catch (error) {
    if (error?.code !== 'ENOENT' && existsSync(ARCHIVE_FILE)) salvageCorrupt(ARCHIVE_FILE, 'archive')
    return {}
  }
}

function saveArchive() {
  try { writeFileSync(ARCHIVE_FILE, JSON.stringify({ version: 1, sessions: archived })) } catch { /* advisory */ }
}

function archiveView() {
  return Object.entries(archived)
    .map(([sessionId, meta]) => ({
      sessionId,
      archivedAt: new Date(meta.archivedAt).toISOString(),
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
    }))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
}

archived = loadArchive()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const routes = {
  /** Pure host liveness check: launcher must not spawn ACP just to find Lite. */
  'GET /api/health': async () => ({
    ok: true,
    agent: acp.starting !== undefined ? 'starting' : acp.child === undefined ? 'stopped' : 'running',
  }),

  'GET /api/status': async () => {
    await acp.ensure()
    return {
      agentInfo: acp.agentInfo,
      capabilities: acp.capabilities,
      authed: acp.authed,
    }
  },

  'POST /api/agent/restart': async () => acp.restart(),

  /**
   * Session list passthrough with server-side flags: `_busy` (a turn is
   * in-flight here), `_queued` (deferred prompts waiting), `_archived`.
   * Archived sessions are hidden by default — they are non-destructively
   * parked, not deleted. `?includeArchived=1` returns them flagged instead.
   * Because filtering happens after the agent's own paging, a page may be
   * short or empty while `nextCursor` still has more — keep paging while a
   * cursor is returned.
   */
  'GET /api/sessions': async (_req, query) => {
    await acp.ensure()
    const params = {}
    if (query.get('cursor')) params.cursor = query.get('cursor')
    if (query.get('cwd')) params.cwd = query.get('cwd')
    const result = await acp.request('session/list', params)
    const queuedCount = new Map()
    for (const e of deferred) {
      queuedCount.set(e.sessionId, (queuedCount.get(e.sessionId) ?? 0) + 1)
    }
    const includeArchived = /^(1|true)$/i.test(query.get('includeArchived') ?? '')
    const sessions = (result.sessions ?? []).map(s => ({
      ...s,
      _busy: acp.busy.has(s.sessionId),
      _queued: queuedCount.get(s.sessionId) ?? 0,
      _archived: archived[s.sessionId] !== undefined,
    }))
    return { ...result, sessions: includeArchived ? sessions : sessions.filter(s => !s._archived) }
  },

  /**
   * Archived sessions independent of agent-side pagination: ids captured at
   * archive time with whatever cwd/title the caller supplied, newest first.
   * Works without the agent running. Entries are pruned when the session is
   * deleted through this server or unarchived; a session deleted elsewhere
   * leaves a stale metadata row until unarchived.
   */
  'GET /api/archived': async () => ({ archived: archiveView() }),

  'POST /api/sessions/archive': async (req) => {
    const { sessionId, cwd, title } = await readBody(req)
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId required')
    if (archived[sessionId] === undefined) {
      archived[sessionId] = { archivedAt: Date.now() }
      if (typeof cwd === 'string') archived[sessionId].cwd = cwd
      if (typeof title === 'string') archived[sessionId].title = title
      saveArchive()
    }
    acp.emit({ kind: 'session-archived', sessionId, archived: true })
    return { ok: true, archived: true }
  },

  'POST /api/sessions/unarchive': async (req) => {
    const { sessionId } = await readBody(req)
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId required')
    const wasArchived = archived[sessionId] !== undefined
    if (wasArchived) {
      delete archived[sessionId]
      saveArchive()
    }
    acp.emit({ kind: 'session-archived', sessionId, archived: false })
    return { ok: true, archived: false, wasArchived }
  },

  'POST /api/sessions/new': async (req) => {
    await acp.ensure()
    const { cwd } = await readBody(req)
    return acp.newSession(requireDir(cwd))
  },

  'POST /api/sessions/load': async (req) => {
    await acp.ensure()
    const { sessionId, cwd } = await readBody(req)
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId required')
    const result = await acp.ensureLoaded(sessionId, requireDir(cwd))
    return result ?? { ok: true, alreadyLoaded: true }
  },

  /**
   * Paged history in turn units. `?sessionId=&tail=5` returns the last 5
   * turns; `&to=N&count=K` returns the K turns ending before turn N.
   * Response: { totalTurns, from, to, turns: [[update…]…], truncated }.
   */
  'GET /api/history': (_req, query) => {
    const sessionId = query.get('sessionId')
    const history = sessionId === null ? undefined : acp.histories.get(sessionId)
    if (history === undefined) return { totalTurns: 0, from: 0, to: 0, turns: [], truncated: false }
    const turns = splitTurns(history.updates)
    const total = turns.length
    let to = total
    let count = Number(query.get('tail') ?? 5)
    if (query.get('to') !== null) {
      to = Math.max(0, Math.min(Number(query.get('to')), total))
      count = Number(query.get('count') ?? 5)
    }
    const from = Math.max(0, to - Math.max(1, count))
    return { totalTurns: total, from, to, turns: turns.slice(from, to), truncated: history.truncated }
  },

  'POST /api/sessions/delete': async (req) => {
    await acp.ensure()
    const { sessionId } = await readBody(req)
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId required')
    await acp.request('session/delete', { sessionId })
    acp.loaded.delete(sessionId)
    acp.histories.delete(sessionId)
    const dropped = deferred.length
    deferred = deferred.filter(e => e.sessionId !== sessionId)
    if (deferred.length !== dropped) { saveQueue(); acp.emit({ kind: 'queue', pending: deferred.length }) }
    cancelTurnsForSession(sessionId)
    autoApproveSessions.delete(sessionId)
    if (archived[sessionId] !== undefined) {
      delete archived[sessionId]
      saveArchive()
      acp.emit({ kind: 'session-archived', sessionId, archived: false })
    }
    return { ok: true }
  },

  'POST /api/sessions/mode': async (req) => {
    await acp.ensure()
    const { sessionId, modeId, cwd } = await readBody(req)
    if (typeof sessionId !== 'string' || typeof modeId !== 'string') throw httpError(400, 'sessionId and modeId required')
    if (cwd !== undefined) await acp.ensureLoaded(sessionId, requireDir(cwd))
    return acp.request('session/set_mode', { sessionId, modeId })
  },

  'POST /api/sessions/config': async (req) => {
    await acp.ensure()
    const { sessionId, configId, value, cwd } = await readBody(req)
    if (typeof sessionId !== 'string' || typeof configId !== 'string' || value === undefined) {
      throw httpError(400, 'sessionId, configId and value required')
    }
    if (cwd !== undefined) await acp.ensureLoaded(sessionId, requireDir(cwd))
    return acp.request('session/set_config_option', { sessionId, configId, value })
  },

  'POST /api/prompt': async (req) => {
    await acp.ensure()
    const { sessionId, cwd, text, images, clientMessageId } = await readBody(req)
    const imgs = Array.isArray(images)
      ? images.filter(i => typeof i?.data === 'string' && typeof i?.mimeType === 'string').slice(0, 8)
      : []
    if (typeof sessionId !== 'string' || (typeof text !== 'string' || text.trim() === '') && imgs.length === 0) {
      throw httpError(400, 'sessionId and text or images required')
    }
    const dir = requireDir(cwd)
    // The browser's explicit send is a controller interjection. It bypasses
    // older deferred work and the local capacity preflight; if Devin rejects
    // it, report the failure to the sender instead of silently queueing it.
    const entry = { sessionId, cwd: dir, text: text ?? '', images: imgs, committed: false,
      attempts: 0, queuedAt: Date.now(), lastError: null, state: 'queued', clientMessageId,
      source: 'gui', priority: true }
    // The prompt resolves when the turn ends — potentially minutes later.
    // Answer immediately and report the outcome over SSE instead.
    entry.attempts++
    void dispatchPrompt(entry)
    return { started: true }
  },

  /**
   * Bridge turn contract — the REST equivalent of `devin --print [--resume]`.
   * start: new or load the session, apply model + mode (defaults swe-2-high /
   * bypass = CLI's dangerous), mark the session auto-approve, then dispatch on
   * the same resident acp. The response is only sent after the busy refcount
   * is up, so the bridge can admit inside its global capacity lock.
   * clientTurnId is an idempotency key: repeating it returns the same turn.
   */
  'POST /api/bridge/turn/start': async (req) => {
    const { sessionId: requestedSid, cwd, text, images, model, modeId, clientTurnId, clientMessageId, priority } = await readBody(req)
    if (typeof clientTurnId === 'string' && clientTurnIds.has(clientTurnId)) {
      const turn = bridgeTurns.get(clientTurnIds.get(clientTurnId))
      if (turn !== undefined) return { ...turnView(turn), deduped: true }
      clientTurnIds.delete(clientTurnId)
    }
    const dir = requireDir(cwd)
    const imgs = Array.isArray(images)
      ? images.filter(i => typeof i?.data === 'string' && typeof i?.mimeType === 'string').slice(0, 8)
      : []
    if (typeof text !== 'string' || (text.trim() === '' && imgs.length === 0)) throw httpError(400, 'text or images required')
    const modelId = typeof model === 'string' && model !== '' ? model : 'swe-2-high'
    const mode = typeof modeId === 'string' && modeId !== '' ? modeId : 'bypass'
    await acp.ensure()
    let created
    if (typeof requestedSid === 'string' && requestedSid !== '') {
      created = { ...(await acp.ensureLoaded(requestedSid, dir) ?? {}), sessionId: requestedSid }
    } else {
      created = await acp.newSession(dir)
    }
    const sessionId = created.sessionId
    // Model evidence: the agent's own configOptions is the honest proof level
    // (a selected value, not a per-generation model_name like CLI --export).
    const cfgOptions = Array.isArray(created.configOptions) ? created.configOptions : []
    const modelOpt = cfgOptions.find(o => o?.id === 'model' || o?.category === 'model')
    if (Array.isArray(modelOpt?.options) && !modelOpt.options.some(o => o?.value === modelId)) {
      throw httpError(422, `model not offered by this agent: ${modelId}`)
    }
    const setResult = await acp.request('session/set_config_option', { sessionId, configId: 'model', value: modelId })
    await acp.request('session/set_mode', { sessionId, modeId: mode })
    autoApproveSessions.add(sessionId)
    // Read the model evidence AFTER the set succeeded: if the agent echoes
    // updated configOptions their currentValue is the honest post-set value;
    // otherwise the accepted set-request is the strongest proof available.
    const postCfg = Array.isArray(setResult?.configOptions) ? setResult.configOptions : []
    const postModelOpt = postCfg.find(o => o?.id === 'model' || o?.category === 'model')
    const observedModel = postModelOpt?.currentValue ?? modelId
    const modelEvidence = postModelOpt?.currentValue !== undefined ? 'session-config-option' : 'set-request'
    const turn = newBridgeTurn({ clientTurnId, sessionId })
    const entry = {
      sessionId, cwd: dir, text, images: imgs, committed: false, attempts: 0,
      queuedAt: Date.now(), lastError: null, state: 'queued',
      turnId: turn.turnId, clientMessageId, source: 'bridge',
      priority: priority === true && typeof requestedSid === 'string' && requestedSid !== '',
    }
    if (!entry.priority && deferred.some(queued => queued.sessionId === sessionId)) {
      deferPrompt(entry, '同一会话中有更早的待发送消息')
      return { ...turnView(turn), observedModel, modelEvidence, mode, busy: acp.busy.get(sessionId) ?? 0 }
    }
    entry.attempts++
    turn.attempts = entry.attempts
    void dispatchPrompt(entry)
    return {
      turnId: turn.turnId, sessionId,
      observedModel, modelEvidence,
      mode, status: 'running', busy: acp.busy.get(sessionId) ?? 0,
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      ...(typeof clientTurnId === 'string' ? { clientTurnId } : {}),
    }
  },

  /**
   * Poll a bridge turn, optionally long-polling up to ~30s for the next state
   * change. Unknown turnId is 404 — turns are memory-only, so after a restart
   * the bridge must treat the outcome as uncertain, never assume silent loss.
   */
  'GET /api/bridge/turn/status': async (_req, query) => {
    const turn = bridgeTurns.get(query.get('turnId') ?? '')
    if (turn === undefined) throw httpError(404, 'unknown turnId')
    if (!TURN_TERMINAL.has(turn.status)) {
      const waitMs = Math.min(30_000, Math.max(0, Number(query.get('waitMs') ?? 0) || 0))
      if (waitMs > 0) {
        await new Promise((resolvePromise) => {
          // Self-removing: both timeout and wake must clean the waiter out of
          // the Set or long-running turns accumulate dead callbacks.
          const done = () => { clearTimeout(timer); turn.waiters.delete(done); resolvePromise() }
          const timer = setTimeout(done, waitMs)
          turn.waiters.add(done)
        })
      }
    }
    return turnView(turn)
  },

  /**
   * Cancel one bridge turn. A merely-deferred turn only loses its own queued
   * retry — no session-level cancel. An in-flight turn needs session/cancel,
   * which aborts EVERY in-flight prompt of that session: if other prompts are
   * running alongside (e.g. a GUI interjection), refuse with 409 and keep the
   * turn running rather than kill work we do not own.
   */
  'POST /api/bridge/turn/cancel': async (req) => {
    const { turnId } = await readBody(req)
    const turn = bridgeTurns.get(turnId)
    if (turn === undefined) throw httpError(404, 'unknown turnId')
    if (TURN_TERMINAL.has(turn.status)) return turnView(turn)
    if (turn.status === 'running') {
      const sessionBusy = acp.busy.get(turn.sessionId) ?? 0
      const others = Math.max(0, sessionBusy - 1) // ours contributes exactly one
      if (others > 0) {
        throw httpError(409,
          `session has ${others} other in-flight prompt(s); refusing session-level cancel`,
          { conflict: true, sessionBusy, ...turnView(turn) })
      }
      const before = deferred.length
      deferred = deferred.filter(e => e.turnId !== turn.turnId)
      if (deferred.length !== before) { saveQueue(); acp.emit({ kind: 'queue', pending: deferred.length }) }
      acp.notify('session/cancel', { sessionId: turn.sessionId })
      turnSet(turn, 'cancelled')
      return turnView(turn)
    }
    // deferred: this turn is not in flight — drop only its own queued retry.
    const before = deferred.length
    deferred = deferred.filter(e => e.turnId !== turn.turnId)
    if (deferred.length !== before) { saveQueue(); acp.emit({ kind: 'queue', pending: deferred.length }) }
    turnSet(turn, 'cancelled')
    return turnView(turn)
  },

  'GET /api/queue': async () => ({
    pending: queueView(),
    features: { item: true, send: true },
    capacity: lastCapacity,
    pollMs: RETRY_POLL_MS,
    limit: CAPACITY_FALLBACK_LIMIT,
  }),

  /** Full text is fetched only when someone opens an item, so regular queue
   * refreshes do not repeatedly transfer a long bridge task prompt. */
  'GET /api/queue/item': async (_req, query) => {
    const entry = deferred.find(e => e.queueId === query.get('queueId'))
    if (entry === undefined) throw httpError(404, 'queued prompt not found')
    return { queueId: entry.queueId, sessionId: entry.sessionId, text: entry.text,
      imageCount: Array.isArray(entry.images) ? entry.images.length : 0 }
  },

  /** An explicit click can advance one queued item; later items in the same
   * session keep their order. This bypasses the suggested retry time only for
   * this one attempt, while backend rejection still re-defers normally. */
  'POST /api/queue/send': async (req) => {
    const { queueId } = await readBody(req)
    if (typeof queueId !== 'string' || queueId === '') throw httpError(400, 'queueId required')
    const index = deferred.findIndex(e => e.queueId === queueId)
    if (index < 0) throw httpError(404, 'queued prompt not found')
    const entry = deferred[index]
    if (entry.state !== 'queued') throw httpError(409, '该消息正在发送中')
    if (deferred.slice(0, index).some(e => e.sessionId === entry.sessionId)) {
      throw httpError(409, '请先处理本会话更早的排队消息')
    }
    entry.state = 'sending'
    entry.attempts = (Number(entry.attempts) || 0) + 1
    entry.lastAttemptAt = Date.now()
    saveQueue()
    acp.emit({ kind: 'prompt-dispatch', sessionId: entry.sessionId, queueId,
      attempt: entry.attempts,
      ...(entry.clientMessageId !== undefined ? { clientMessageId: entry.clientMessageId } : {}) })
    if (entry.turnId !== undefined) {
      const turn = bridgeTurns.get(entry.turnId)
      if (turn !== undefined) turnSet(turn, 'running', { attempts: entry.attempts, retryAt: undefined, queueId: undefined, lastError: undefined })
    }
    log(`manually dispatching deferred prompt for ${entry.sessionId} (attempt ${entry.attempts})`)
    void dispatchPrompt(entry)
    return { started: true, queueId }
  },

  'GET /api/capacity': async () => {
    const cap = await capacitySnapshot()
    lastCapacity = cap === null ? { error: 'capacity check failed', at: Date.now() } : cap
    return cap ?? { error: 'capacity check failed', limit: CAPACITY_FALLBACK_LIMIT }
  },

  /**
   * Drop queued entries (state 'queued'). An entry already 'sending' has been
   * handed to the agent — cancel the session's turn instead of queue-dropping.
   */
  'POST /api/queue/drop': async (req) => {
    const { queueId, sessionId } = await readBody(req)
    const before = deferred.length
    deferred = deferred.filter(e => e.state === 'sending'
      || !(e.queueId === queueId || (queueId === undefined && e.sessionId === sessionId)))
    if (deferred.length !== before) {
      saveQueue()
      acp.emit({ kind: 'queue', pending: deferred.length })
      if (queueId !== undefined) {
        // A dropped bridge-turn retry cancels the turn itself.
        for (const turn of bridgeTurns.values()) {
          if (turn.queueId === queueId && !TURN_TERMINAL.has(turn.status)) turnSet(turn, 'cancelled')
        }
      }
    }
    return { removed: before - deferred.length, pending: deferred.length }
  },

  'POST /api/cancel': async (req) => {
    await acp.ensure()
    const { sessionId } = await readBody(req)
    if (typeof sessionId !== 'string') throw httpError(400, 'sessionId required')
    acp.notify('session/cancel', { sessionId })
    const dropped = deferred.length
    deferred = deferred.filter(e => e.sessionId !== sessionId)
    if (deferred.length !== dropped) { saveQueue(); acp.emit({ kind: 'queue', pending: deferred.length }) }
    cancelTurnsForSession(sessionId)
    return { ok: true }
  },

  'POST /api/permission': async (req) => {
    await acp.ensure()
    const { requestId, optionId, cancel } = await readBody(req)
    if (typeof requestId !== 'string') throw httpError(400, 'requestId required')
    const outcome = cancel === true
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId } }
    if (!acp.answer(requestId, outcome)) throw httpError(404, 'permission request not pending')
    acp.emit({ kind: 'permission-done', requestId })
    return { ok: true }
  },

  'POST /api/pick-folder': async () => {
    // Serialize concurrent opens so only one native dialog is up at a time.
    pickInflight ??= pickFolderNative().finally(() => { pickInflight = undefined })
    return pickInflight
  },

  /**
   * Stage a pasted image to a local file so prompts can reference it by path
   * instead of embedding bytes — keeps image payloads out of the conversation.
   * Two wire forms: a raw binary body with `Content-Type: image/*` (skips the
   * FileReader→base64→JSON round-trip) and the legacy JSON `{dataUrl}`.
   * Raster bodies are magic-byte verified against the declared type; an
   * over-cap or type-mismatched upload is rejected before any file exists.
   */
  'POST /api/attach': async (req) => {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (mime.startsWith('image/')) {
      const ext = ATTACH_EXT[mime]
      if (ext === undefined) throw httpError(415, `unsupported image type: ${mime}`)
      const buf = await readRawBody(req, IMAGE_BYTES_CAP)
      if (buf.length === 0) throw httpError(400, 'empty image body')
      if (mime !== 'image/svg+xml' && IMAGE_MIME[sniffImageKind(buf)] !== mime) {
        throw httpError(415, 'body is not the declared image type')
      }
      mkdirSync(ATTACH_DIR, { recursive: true })
      const file = join(ATTACH_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
      writeFileSync(file, buf)
      return { path: file }
    }
    const { dataUrl } = await readBody(req)
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl ?? '')
    if (!m) throw httpError(400, 'image dataUrl required')
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > IMAGE_BYTES_CAP) throw httpError(400, 'image too large')
    mkdirSync(ATTACH_DIR, { recursive: true })
    const ext = ATTACH_EXT[m[1]] ?? '.img'
    const file = join(ATTACH_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    writeFileSync(file, buf)
    return { path: file }
  },

  /**
   * Raw bytes of a local raster image for thumbnail rendering. The path must
   * be absolute, an existing regular file within the size cap, and actually
   * sniff as a supported raster type — SVG/markup never passes (same-origin
   * script execution risk). Response is nosniff + CSP 'none'.
   */
  'GET /api/image-preview': async (_req, query) => {
    const raw = query.get('path')
    if (typeof raw !== 'string' || !isAbsolute(raw)) throw httpError(400, 'absolute path required')
    const resolved = resolve(raw)
    let st
    try { st = statSync(resolved) } catch { throw httpError(404, 'not found') }
    if (!st.isFile()) throw httpError(404, 'not a regular file')
    if (st.size === 0 || st.size > IMAGE_BYTES_CAP) throw httpError(413, 'image size out of range')
    const buf = readFileSync(resolved)
    const kind = sniffImageKind(buf)
    if (kind === undefined) throw httpError(415, 'not a supported raster image')
    return { __raw: buf, contentType: IMAGE_MIME[kind] }
  },

  /**
   * Local raster-image paths mentioned in a loaded session's chat text —
   * user and assistant message bodies only (never tool-call output), deduped
   * in first-appearance order, filtered to files that still exist. Images
   * that only ever traveled as base64 have no local path and are skipped.
   */
  'GET /api/session-images': async (_req, query) => {
    const sid = query.get('sessionId') ?? ''
    const history = acp.histories.get(sid)
    if (history === undefined) throw httpError(404, 'session not loaded in this process')
    const seen = new Set()
    const images = []
    for (const u of history.updates) {
      if (u.sessionUpdate !== 'user_message_chunk' && u.sessionUpdate !== 'agent_message_chunk') continue
      const text = u.content?.text
      if (typeof text !== 'string') continue
      for (const m of text.matchAll(RASTER_PATH_RE)) {
        const p = resolve(m[0])
        const key = p.toLowerCase()
        if (seen.has(key)) continue
        try {
          if (!statSync(p).isFile()) continue
          // Head-bytes sniff: a non-raster file merely named *.png is skipped.
          const fd = openSync(p, 'r')
          const head = Buffer.alloc(12)
          const n = readSync(fd, head, 0, 12, 0)
          closeSync(fd)
          if (sniffImageKind(head.subarray(0, n)) === undefined) continue
        } catch { continue }
        seen.add(key)
        images.push({ path: p, name: basename(p) })
      }
    }
    return { images }
  },

  'POST /api/pick-file': async () => {
    pickInflight ??= pickFileNative().finally(() => { pickInflight = undefined })
    return pickInflight
  },

  /**
   * Windows clipboard file list (CF_HDROP) — real absolute paths for files the
   * user Ctrl+C'd in Explorer. Browsers strip local paths from paste events;
   * reading the clipboard natively is the workaround for path references.
   */
  'POST /api/clipboard-files': async () => clipboardFilesNative(),

  /**
   * External helpers (e.g. the dropzone window) push local file paths here;
   * they reach the page as an SSE attach-paths event and become {{tokens}}.
   */
  'POST /api/attach-paths': async (req) => {
    const { paths } = await readBody(req)
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && existsSync(p))
    if (list.length === 0) throw httpError(400, 'paths must be existing local files/folders')
    acp.emit({ kind: 'attach-paths', paths: list })
    return { ok: true, count: list.length }
  },

  /**
   * Distill a loaded session's buffered tail into a bridge prompt for 续接:
   * last user intent + trailing assistant output + latest plan. devin acp has
   * no compaction/summarize method, so a fresh session carrying the summary
   * is the escape hatch for context-full sessions.
   */
  'GET /api/bridge-text': async (_req, query) => {
    const sid = query.get('sessionId') ?? ''
    const history = acp.histories.get(sid)
    const cwd = acp.loaded.get(sid)
    if (!history || !cwd) throw httpError(404, 'session not loaded in this process')
    return { text: bridgeText(sid, cwd, history.updates), cwd }
  },

  'GET /api/browse': async (_req, query) => {
    // Bare drive roots like "D:" need a trailing separator to be absolute.
    let dir = query.get('path') ?? ''
    if (/^[A-Za-z]:$/.test(dir)) dir = `${dir}\\`
    // An invalid or vanished path walks up to its nearest existing ancestor
    // instead of failing, so the picker never dead-ends on a stale input.
    while (dir !== '') {
      try {
        if (isAbsolute(dir) && statSync(dir).isDirectory()) break
      } catch { /* keep climbing */ }
      const parent = resolve(dir, '..')
      if (parent === dir) { dir = ''; break }
      dir = parent
    }
    if (dir === '') {
      // Drive letters on Windows.
      const drives = []
      for (let c = 67; c <= 90; c++) {
        const letter = `${String.fromCharCode(c)}:\\`
        if (existsSync(letter)) drives.push(letter)
      }
      return { path: '', entries: drives.map(d => ({ name: d, path: d })) }
    }
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$'))
      .map(entry => ({ name: entry.name, path: join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = resolve(dir, '..')
    return {
      path: dir,
      parent: parent === dir ? undefined : parent,
      entries,
    }
  },
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra })
}

let pickInflight = undefined

/** Open the Windows-native folder picker (FolderBrowserDialog) via PowerShell. */
function pickFolderNative() {
  return new Promise((resolvePromise) => {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择 devin-lite 工作目录'",
      '$d.ShowNewFolderButton = $true',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      '$owner.Dispose()',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* best effort */ } }, 180_000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolvePromise({ cancelled: true }) })
    child.on('close', () => {
      clearTimeout(timer)
      const path = out.trim()
      resolvePromise(path ? { path } : { cancelled: true })
    })
  })
}

/** Open the Windows-native file picker (OpenFileDialog, multi-select) via PowerShell. */
function pickFileNative() {
  return new Promise((resolvePromise) => {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Title = '选择要引用的文件'",
      "$d.Filter = '所有文件 (*.*)|*.*'",
      '$d.Multiselect = $true',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }',
      '$owner.Dispose()',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* best effort */ } }, 180_000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolvePromise({ cancelled: true }) })
    child.on('close', () => {
      clearTimeout(timer)
      const paths = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      resolvePromise(paths.length > 0 ? { paths } : { cancelled: true })
    })
  })
}

/** Read the clipboard's file-drop list (instant, no dialog). */
function clipboardFilesNative() {
  return new Promise((resolvePromise) => {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$l = [System.Windows.Forms.Clipboard]::GetFileDropList()',
      'if ($l) { $l | ForEach-Object { [Console]::Out.WriteLine($_) } }',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* best effort */ } }, 10_000)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolvePromise({ paths: [] }) })
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise({ paths: out.split(/\r?\n/).map(l => l.trim()).filter(p => p !== '' && existsSync(p)) })
    })
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler !== undefined) {
      const out = await handler(req, url.searchParams)
      if (out !== null && typeof out === 'object' && Buffer.isBuffer(out.__raw)) {
        // Binary payload route (image preview): bytes + sniffed type, with
        // hardening so the response can't become an executable document.
        res.writeHead(200, {
          'Content-Type': out.contentType ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'private, max-age=60',
        })
        res.end(out.__raw)
        return
      }
      json(res, 200, out)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = join(PUBLIC_DIR, rel)
      if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
        json(res, 404, { error: 'not found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(readFileSync(file))
      return
    }
    json(res, 404, { error: 'not found' })
  } catch (error) {
    json(res, error.status ?? 500, {
      error: String(error.message ?? error),
      ...(typeof error.extra === 'object' && error.extra !== null ? error.extra : {}),
    })
  }
})

server.on('error', (error) => {
  // A second launch is not a failure: the launcher still opens the browser.
  if (error.code === 'EADDRINUSE') {
    log(`already running at http://127.0.0.1:${PORT} — exiting duplicate`)
    process.exit(0)
  }
  throw error
})

/**
 * The acp child never outlives this server: on exit we kill its process tree
 * and clear the pid marker. A force-killed server skips these handlers, which
 * is exactly the case spawn()'s stale-pid reaping covers on the next launch.
 */
function shutdownChild() {
  const pid = acp.child?.pid
  if (pid === undefined) return
  killTree(pid)
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(pid)) unlinkSync(PID_FILE)
  } catch { /* marker already gone */ }
}
process.on('exit', shutdownChild)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => process.exit(0))
}
process.on('uncaughtException', (error) => {
  log('uncaught:', error?.stack ?? error)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`)
})
