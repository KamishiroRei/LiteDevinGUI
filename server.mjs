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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(ROOT, 'public')
const PORT = Number(process.env.DEVIN_LITE_PORT ?? process.argv[2] ?? 8317)
const DEVIN_EXE = process.env.DEVIN_EXE ?? 'devin'

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
  /** sessionId -> cwd for sessions loaded/created in this process. */
  loaded = new Map()
  /**
   * sessionId -> buffered update list. `session/load` replays full history as
   * updates; buffering lets the client page in only the turns it renders.
   */
  histories = new Map()
  /** sessionIds mid-replay: their updates buffer instead of broadcasting. */
  loading = new Set()
  /** Sessions with a session/prompt currently in flight in this process. */
  busy = new Set()
  listeners = new Set()

  emit(payload) {
    for (const sink of this.listeners) {
      try { sink(payload) } catch { /* a dead SSE sink is removed on write error */ }
    }
  }

  send(message) {
    this.child?.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method, params) {
    const id = `c-${++this.nextId}`
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
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
    if (this.child !== undefined) return
    this.starting ??= this.spawn()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async spawn() {
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
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trimEnd()
      if (line.length > 0) log('devin stderr:', line.slice(0, 300))
    })
    child.on('error', (error) => {
      log('devin spawn error:', error.message)
      this.teardown(error)
    })
    child.on('close', (code, signal) => {
      log('devin acp exited', code ?? signal)
      this.teardown(new Error(`devin acp exited (code ${code ?? signal})`))
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => this.onLine(line))

    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'devin-lite', version: '0.1.0' },
    })
    this.capabilities = init.agentCapabilities ?? {}
    this.authMethods = init.authMethods ?? []
    this.agentInfo = init.agentInfo ?? {}
    log('devin acp ready:', this.agentInfo.name ?? 'agent', this.agentInfo.version ?? '')
  }

  teardown(error) {
    const failed = this.pending
    this.pending.clear()
    this.inbound.clear()
    this.loaded.clear()
    this.histories.clear()
    this.loading.clear()
    this.child = undefined
    for (const { reject } of failed.values()) reject(error)
    this.emit({ kind: 'agent-down', message: String(error.message ?? error) })
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
      const history = this.histories.get(params.sessionId)
      if (history !== undefined) {
        history.updates.push(params.update)
        if (history.updates.length > HISTORY_CAP) {
          history.updates.splice(0, history.updates.length - HISTORY_CAP)
          history.truncated = true
        }
      }
      // While a session is loading its replay is buffered, not broadcast; the
      // client pages it in via /api/history after load resolves.
      if (!this.loading.has(params.sessionId)) {
        this.emit({ kind: 'update', ...params })
      }
    } else {
      this.emit({ kind: 'notification', method: message.method, params: message.params })
    }
  }

  onAgentRequest(message) {
    if (message.method === 'session/request_permission') {
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

  async prompt(sessionId, cwd, text, images = []) {
    await this.ensureLoaded(sessionId, cwd)
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

function requireDir(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw Object.assign(new Error('cwd must be an absolute path'), { status: 400 })
  const resolved = resolve(value)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${resolved}`), { status: 400 })
  }
  return resolved
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const routes = {
  'GET /api/status': async () => {
    await acp.ensure()
    return {
      agentInfo: acp.agentInfo,
      capabilities: acp.capabilities,
      authed: acp.authed,
    }
  },

  'GET /api/sessions': async (_req, query) => {
    await acp.ensure()
    const params = {}
    if (query.get('cursor')) params.cursor = query.get('cursor')
    if (query.get('cwd')) params.cwd = query.get('cwd')
    const result = await acp.request('session/list', params)
    for (const s of result.sessions ?? []) s._busy = acp.busy.has(s.sessionId)
    return result
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
    const { sessionId, cwd, text, images } = await readBody(req)
    const imgs = Array.isArray(images)
      ? images.filter(i => typeof i?.data === 'string' && typeof i?.mimeType === 'string').slice(0, 8)
      : []
    if (typeof sessionId !== 'string' || (typeof text !== 'string' || text.trim() === '') && imgs.length === 0) {
      throw httpError(400, 'sessionId and text or images required')
    }
    const dir = requireDir(cwd)
    // The prompt resolves when the turn ends — potentially minutes later.
    // Answer immediately and report the outcome over SSE instead.
    acp.busy.add(sessionId)
    acp.emit({ kind: 'busy', sessionId, busy: true })
    void acp.prompt(sessionId, dir, text ?? '', imgs).then(
      (response) => { acp.busy.delete(sessionId); acp.emit({ kind: 'busy', sessionId, busy: false }); acp.emit({ kind: 'prompt-done', sessionId, stopReason: response.stopReason, usage: response.usage }) },
      (error) => { acp.busy.delete(sessionId); acp.emit({ kind: 'busy', sessionId, busy: false }); acp.emit({ kind: 'prompt-done', sessionId, error: String(error.message ?? error), code: error.code }) },
    )
    return { started: true }
  },

  'POST /api/cancel': async (req) => {
    await acp.ensure()
    const { sessionId } = await readBody(req)
    if (typeof sessionId !== 'string') throw httpError(400, 'sessionId required')
    acp.notify('session/cancel', { sessionId })
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

  'POST /api/pick-file': async () => {
    pickInflight ??= pickFileNative().finally(() => { pickInflight = undefined })
    return pickInflight
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

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler !== undefined) {
      json(res, 200, await handler(req, url.searchParams))
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
    json(res, error.status ?? 500, { error: String(error.message ?? error) })
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

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`)
})
