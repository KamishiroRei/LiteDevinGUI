// Isolated Cursor ACP contract test. The child is a local stub, never Cursor.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('..', import.meta.url))
const PREFIX = 'devin-lite-cursor-test-'
const WORK = mkdtempSync(join(tmpdir(), PREFIX))
let host
let base
const checks = []
const sleep = ms => new Promise(done => setTimeout(done, ms))

function check(name, valid) {
  checks.push(valid)
  console.log(`${valid ? 'PASS' : 'FAIL'} ${name}`)
}
async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}
async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  })
  return { status: response.status, body: await response.json() }
}
async function until(test, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await test()) return } catch { /* wait for server */ }
    await sleep(75)
  }
  throw new Error('test timed out')
}
function start() {
  host = spawn(process.execPath, [join(WORK, 'server.mjs'), String(new URL(base).port)], {
    cwd: WORK,
    env: { ...process.env, DEVIN_EXE: process.execPath,
      CURSOR_AGENT_SCRIPT: join(WORK, 'fake-cursor.ps1') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  host.stdout.on('data', data => process.stdout.write(`  [host] ${data}`))
  host.stderr.on('data', data => process.stdout.write(`  [host!] ${data}`))
}
async function stop() {
  if (!host || host.exitCode !== null) return
  const child = host
  child.kill('SIGTERM')
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)])
  if (child.exitCode === null) child.kill()
  host = undefined
}

try {
  copyFileSync(join(SOURCE, 'server.mjs'), join(WORK, 'server.mjs'))
  copyFileSync(join(SOURCE, 'workspace-skills.mjs'), join(WORK, 'workspace-skills.mjs'))
  copyFileSync(join(SOURCE, 'outbound-journal.mjs'), join(WORK, 'outbound-journal.mjs'))
  copyFileSync(join(SOURCE, 'tests', 'fixtures', 'acp'), join(WORK, 'acp'))
  writeFileSync(join(WORK, 'fake-state.json'), JSON.stringify({ sessions: [] }))
  writeFileSync(join(WORK, 'fake-cursor.ps1'),
    `& '${process.execPath.replaceAll("'", "''")}' "$PSScriptRoot/fake-cursor.cjs"\n`)
  writeFileSync(join(WORK, 'fake-cursor.cjs'), `
const fs = require('fs')
const readline = require('readline')
const log = ${JSON.stringify(join(WORK, 'cursor-prompts.jsonl'))}
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
let blockedPrompt
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line), id=m.id
  const respond=result=>send({jsonrpc:'2.0',id,result})
  if (id === 'cursor-q-1' && m.result) {
    fs.appendFileSync(log, JSON.stringify({ answer: m.result }) + '\\n')
    send({jsonrpc:'2.0',id:blockedPrompt,result:{stopReason:'end_turn'}})
    blockedPrompt = undefined
    return
  }
  if(m.method==='initialize') return respond({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}],agentInfo:{name:'fake-cursor',version:'test'}})
  if(m.method==='session/new') return respond({sessionId:'cursor-raw-1',configOptions:[]})
  if(m.method==='session/load') return respond({configOptions:[]})
  if(m.method==='session/prompt') {
    fs.appendFileSync(log,JSON.stringify(m.params)+'\\n')
    if (m.params.prompt.some(part => part.text === 'ask-me')) {
      blockedPrompt = id
      send({jsonrpc:'2.0',id:'cursor-q-1',method:'cursor/ask_question',params:{
        toolCallId:'tool-1',title:'Choose a mode',questions:[{id:'q1',prompt:'Which?',options:[{id:'a',label:'A'}]}],
      }})
      return
    }
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'stub response'}}}})
    return respond({stopReason:'end_turn'})
  }
  if(m.method==='authenticate') return respond({})
  if(m.method==='session/list') return respond({sessions:[]})
  return send({jsonrpc:'2.0',id,error:{code:-32601,message:'unsupported'}})
})
`)
  base = `http://127.0.0.1:${await freePort()}`
  start()
  await until(async () => (await api('GET', '/api/health')).status === 200)
  const cursor = await api('GET', '/api/status?provider=cursor')
  check('Cursor ACP initializes independently', cursor.status === 200 && cursor.body?.agentInfo?.name === 'fake-cursor')
  const created = await api('POST', '/api/sessions/new', { provider: 'cursor', cwd: WORK })
  check('new Cursor session has a public provider ID', created.status === 200 && created.body?.sessionId === 'cursor:cursor-raw-1')
  const sid = created.body.sessionId
  const rejectedBridge = await api('POST', '/api/bridge/turn/start', {
    sessionId: sid, cwd: WORK, text: 'must not route through Devin',
  })
  check('Codex bridge refuses Cursor IDs', rejectedBridge.status === 400)
  const sent = await api('POST', '/api/prompt', { sessionId: sid, cwd: WORK, text: 'offline stub only' })
  await until(() => {
    try { return readFileSync(join(WORK, 'cursor-prompts.jsonl'), 'utf8').includes('offline stub only') }
    catch { return false }
  })
  check('Cursor prompt uses the raw Cursor ACP ID', sent.status === 200
    && JSON.parse(readFileSync(join(WORK, 'cursor-prompts.jsonl'), 'utf8').trim()).sessionId === 'cursor-raw-1')
  const history = await api('GET', `/api/history?sessionId=${encodeURIComponent(sid)}&tail=2`)
  check('Cursor updates enter the matching Lite history', history.status === 200 && history.body?.totalTurns > 0)
  const asked = await api('POST', '/api/prompt', { sessionId: sid, cwd: WORK, text: 'ask-me' })
  await until(async () => (await api('GET', '/api/agent/pending')).body?.cursor?.length === 1)
  const pending = await api('GET', '/api/agent/pending')
  const answered = await api('POST', '/api/cursor/respond', {
    requestId: pending.body.cursor[0].requestId,
    result: { outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] } },
  })
  await until(() => readFileSync(join(WORK, 'cursor-prompts.jsonl'), 'utf8').includes('selectedOptionIds'))
  check('Cursor blocking question waits for the explicit UI response', asked.status === 200
    && pending.body.cursor[0].method === 'cursor/ask_question' && answered.status === 200)
  await stop()
  start()
  await until(async () => (await api('GET', '/api/health')).status === 200)
  const listed = await api('GET', '/api/sessions')
  check('Cursor session index survives Lite restart', listed.status === 200
    && listed.body?.sessions?.some(row => row.sessionId === sid))
} finally {
  await stop()
  if (resolve(dirname(WORK)).toLowerCase() !== resolve(tmpdir()).toLowerCase()
      || !basename(WORK).startsWith(PREFIX)) throw new Error(`unsafe test cleanup path: ${WORK}`)
  rmSync(WORK, { recursive: true, force: true })
}
console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`)
if (checks.some(ok => !ok)) process.exitCode = 1
