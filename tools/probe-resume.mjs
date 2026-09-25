// Probe: can session/resume (or a _meta force flag) open a locked session?
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const SESSION_ID = process.argv[2] ?? 'liberating-chip'
const CWD = process.argv[3] ?? 'D:\\UE5Project\\UGIT\\ExceedCavalier'

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(ELECTRON_|WINDSURF_|VSCODE_|ACP_)/.test(key)) delete env[key]
}
const child = spawn('devin', ['acp'], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] })
const rl = createInterface({ input: child.stdout })
let nextId = 0
const pending = new Map()
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
const request = (method, params) => new Promise((res, rej) => {
  const id = `c-${++nextId}`
  pending.set(id, { res, rej })
  send({ jsonrpc: '2.0', id, method, params })
})
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    m.error ? rej(Object.assign(new Error(m.error.message), m.error)) : res(m.result)
  }
})
const attempt = async (label, method, params) => {
  try { console.log(label, '=>', JSON.stringify(await request(method, params)).slice(0, 300)) }
  catch (e) { console.log(label, '=> ERR', e.code, e.message) }
}

await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '0' } })
await attempt('session/load', 'session/load', { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] })
await attempt('session/resume', 'session/resume', { sessionId: SESSION_ID, cwd: CWD })
await attempt('session/load force', 'session/load', { sessionId: SESSION_ID, cwd: CWD, mcpServers: [], _meta: { 'cognition.ai/force': true } })
await attempt('session/resume force', 'session/resume', { sessionId: SESSION_ID, cwd: CWD, _meta: { 'cognition.ai/force': true } })
child.kill()
process.exit(0)
