/* devin-lite front end — talks to server.mjs (REST + SSE), renders ACP updates. */
'use strict'

const $ = (id) => document.getElementById(id)
const api = async (method, path, body) => {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error('无法连接 devin-lite 服务（服务可能未运行——重新双击 devin-lite 启动）')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status}`)
  return data
}

const state = {
  sessions: [],          // SessionInfo rows from session/list
  nextCursor: undefined,
  active: undefined,     // { sessionId, cwd, title }
  busy: false,
  busySessions: new Set(), // sessionIds with an in-flight prompt (stop button follows the session, not the page)
  queueItems: [],       // persistent deferred prompts from /api/queue
  archiveRows: [],      // server-owned archived session metadata
  archiveReady: false,
  configOptions: [],     // select-type session config options (mode, model, …)
  echoPending: undefined, // text of the just-sent prompt, for echo suppression
  earliestTurn: 0,       // first rendered history turn index
  totalTurns: 0,
  loadingEarlier: false,
  attachments: [],        // legacy drafts may still contain attachment tokens
  openSeq: 0,             // increments per session switch; stale async renders bail
  stream: freshStream(),
}

function freshStream() {
  return {
    agentEl: undefined, agentBuf: '', agentMsgId: undefined,
    thinkEl: undefined, thinkBuf: '',
    userEl: undefined, userBuf: '',
    tools: new Map(),   // toolCallId -> { el, statusEl, detailEl, nameEl }
    toolRun: undefined, // open <details> grouping consecutive tool cards
    toolRunBody: undefined,
    inHistory: false,   // true while rendering buffered pages (runs stay closed)
    planEl: undefined,
    permEls: new Map(), // requestId -> element
    lastKind: '',       // last rendered update kind — closes open runs on switch
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

/** Minimal markdown: fences, headings, lists, paragraphs, inline marks. */
function md(src) {
  return src.split(/\n{2,}/).map((block) => {
    const fence = /^```(\w*)\n?([\s\S]*?)```$/s.exec(block.trim())
    if (fence) return `<pre><code>${esc(fence[2])}</code></pre>`
    const head = /^(#{1,6})\s+([\s\S]*)$/s.exec(block.trim())
    if (head) return `<h3>${inline(esc(head[2]))}</h3>`
    const lines = block.split('\n')
    if (lines.length >= 2 && /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(lines[1])) {
      const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inline(esc(cell.trim())))
      const headCells = cells(lines[0]).map(cell => `<th>${cell}</th>`).join('')
      const bodyRows = lines.slice(2).filter(line => line.includes('|')).map(line => `<tr>${cells(line).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
      return `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
    }
    if (lines.length > 1 && lines.every(l => /^[ \t]*\d+[.)] |\s*$/.test(l))) {
      const items = lines.filter(l => l.trim()).map(l => `<li>${inline(esc(l.replace(/^[ \t]*\d+[.)] /, '')))}</li>`).join('')
      return `<ol>${items}</ol>`
    }
    if (lines.length > 1 && lines.every(l => /^[ \t]*[-*] |\s*$/.test(l))) {
      const items = lines.filter(l => l.trim()).map(l => `<li>${inline(esc(l.replace(/^[ \t]*[-*] /, '')))}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    return `<p>${inline(esc(block)).replace(/\n/g, '<br>')}</p>`
  }).join('')
}

function fmtTime(iso) {
  if (!iso) return ''
  const t = new Date(iso)
  const mins = Math.floor((Date.now() - t.getTime()) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  if (mins < 1440) return `${Math.floor(mins / 60)} 小时前`
  return `${t.getMonth() + 1}/${t.getDate()}`
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) }
  catch {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    document.execCommand('copy'); ta.remove()
  }
}

function scrollBottom(force = false) {
  const t = $('transcript')
  if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 220) t.scrollTop = t.scrollHeight
}

function addNote(text, cls = '') {
  const div = document.createElement('div')
  div.className = `note ${cls}`
  div.textContent = text
  $('transcript').appendChild(div)
  scrollBottom()
  return div
}

function toast(text, cls = '') {
  const item = document.createElement('div')
  item.className = `toast ${cls}`
  item.textContent = text
  $('toastRegion').appendChild(item)
  setTimeout(() => item.remove(), cls === 'error' ? 9000 : 5000)
}

function showEmptyState() {
  $('transcript').innerHTML = '<div class="empty-state"><img src="favicon.svg" width="42" height="42" alt=""><h1>开始一个会话</h1><p>选择左侧会话，或在工作区中新建会话。</p></div>'
}

function updateQueueBanner() {
  const banner = $('queueBanner')
  const items = state.queueItems.filter(e => e.sessionId === state.active?.sessionId)
  banner.hidden = items.length === 0
  if (items.length === 0) return
  const first = items[0]
  const until = first.retryAt ? new Date(first.retryAt).getTime() - Date.now() : 0
  const sending = first.state === 'sending'
  const when = sending ? '正在发送' : until > 0 ? `约 ${Math.ceil(until / 1000)} 秒后重发` : '等待并发空位，自动重发'
  $('queueText').textContent = `消息${sending ? '' : '已排队'}${items.length > 1 ? `（共 ${items.length} 条）` : ''} · ${when}${!sending && first.lastError ? ` · ${first.lastError}` : ''}`
  $('queueText').title = first.preview ?? ''
  $('queueCancel').hidden = sending
  $('queueCancel').dataset.queueId = sending ? '' : first.queueId
}

async function refreshQueue() {
  try {
    const data = await api('GET', '/api/queue')
    state.queueItems = Array.isArray(data.pending) ? data.pending : []
    updateQueueBanner()
    renderSessions()
  } catch (err) { toast(`读取排队状态失败：${err.message}`, 'error') }
}

/**
 * Close the currently open run when a different kind of update arrives.
 * Contiguous same-kind chunks share one element; a kind switch (or a new
 * messageId) opens a fresh element so messages never merge into one blob.
 */
function closeRun(st, kind) {
  if (st.lastKind === kind) return
  // A finished tool run collapses itself — live progress stays visible while
  // streaming and folds once the agent moves on.
  if (st.toolRun) { st.toolRun.open = false; st.toolRun = undefined; st.toolRunBody = undefined }
  st.userEl = undefined
  st.userBuf = ''
  st.agentEl = undefined
  st.agentBuf = ''
  st.agentMsgId = undefined
  st.thinkEl = undefined
  st.thinkBuf = ''
  st.planEl = undefined
  st.lastKind = kind
}

// ---------------------------------------------------------------------------
// transcript rendering for ACP session/update
// ---------------------------------------------------------------------------

function appendAgentText(text, st, container, messageId) {
  closeRun(st, 'agent')
  if (st.agentEl && messageId !== undefined && st.agentMsgId !== undefined && messageId !== st.agentMsgId) {
    st.agentEl = undefined
    st.agentBuf = ''
  }
  if (messageId !== undefined) st.agentMsgId = messageId
  st.agentBuf += text
  if (!st.agentEl) {
    const div = document.createElement('div')
    div.className = 'msg assistant'
    div.innerHTML = '<div class="body"></div><button class="copy-msg" type="button" title="复制回复">复制</button>'
    div.querySelector('.copy-msg').addEventListener('click', async () => { await copyText(div._raw ?? ''); toast('已复制回复') })
    container.appendChild(div)
    st.agentEl = div.querySelector('.body')
  }
  st.agentEl.parentElement._raw = st.agentBuf
  st.agentEl.innerHTML = md(st.agentBuf)
}

function appendThought(text, st, container) {
  closeRun(st, 'think')
  st.thinkBuf += text
  if (!st.thinkEl) {
    const det = document.createElement('details')
    det.className = 'think'
    det.innerHTML = '<summary>思考过程</summary><div class="think-body"></div>'
    container.appendChild(det)
    st.thinkEl = det.querySelector('.think-body')
  }
  st.thinkEl.textContent = st.thinkBuf
}

const KIND_ICON = { read: '📄', edit: '✏️', delete: '🗑', move: '↔', search: '🔍', execute: '▶', think: '💭', fetch: '🌐', switch_mode: '🔀', other: '🔧' }

function toolCard(update, st, container) {
  closeRun(st, 'tool')
  // Consecutive tool updates group under one collapsible run — a turn can hold
  // hundreds of calls and must not flood the transcript with bare cards.
  if (!st.toolRun) {
    const det = document.createElement('details')
    det.className = 'toolrun'
    det.open = st.inHistory !== true // history runs start folded; live runs stream open
    det.innerHTML = '<summary></summary><div class="tr-body"></div>'
    container.appendChild(det)
    st.toolRun = det
    st.toolRunBody = det.querySelector('.tr-body')
  }
  let rec = st.tools.get(update.toolCallId)
  if (!rec) {
    const el = document.createElement('div')
    el.className = 'tool'
    el.innerHTML = `<div class="head"><span class="kind"></span><span class="name"></span><span class="status"></span></div><div class="detail"></div>`
    el.querySelector('.head').addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('open') })
    st.toolRunBody.appendChild(el)
    rec = { el, nameEl: el.querySelector('.name'), kindEl: el.querySelector('.kind'), statusEl: el.querySelector('.status'), detailEl: el.querySelector('.detail'), rawInput: undefined, detail: [] }
    st.tools.set(update.toolCallId, rec)
  }
  // Merge semantics: an update only replaces a field it actually carries —
  // devin sends '' (not null) for absent fields, which must not blank the card.
  const name = update.name || update.title || ''
  const title = update.title || ''
  if (name || title) rec.nameEl.textContent = title && title !== name ? `${name} — ${title}` : (name || title)
  else if (!rec.nameEl.textContent) {
    // Orphaned update (its tool_call was paged out): label by tool name, not
    // the raw opaque id which reads as a meaningless bar.
    rec.nameEl.textContent = update._meta?.['cognition.ai/inferenceToolName']
      ?? ((update.toolCallId ?? '').split(/[:#]/)[0] || '工具调用')
  }
  if (update.kind) rec.kindEl.textContent = `${KIND_ICON[update.kind] ?? '🔧'} ${update.kind}`
  if (update.rawInput !== undefined) rec.rawInput = update.rawInput
  const locs = (update.locations ?? []).map(l => l.path).join('\n')
  if (update.status) {
    rec.statusEl.textContent = { pending: '排队', in_progress: '运行中…', completed: '完成', failed: '失败' }[update.status] ?? update.status
    rec.statusEl.className = `status ${update.status}`
  }
  for (const item of update.content ?? []) rec.detail.push(item)
  renderToolDetail(rec, locs)
  const count = st.toolRunBody.childElementCount
  const last = st.toolRunBody.lastElementChild?.querySelector('.name')?.textContent
  st.toolRun.querySelector('summary').textContent = `🔧 工具调用 × ${count}${last ? ` — ${last}` : ''}`
}

function renderToolDetail(rec, locs) {
  const parts = []
  if (locs) parts.push(locs)
  if (rec.rawInput !== undefined) {
    try { parts.push(JSON.stringify(rec.rawInput, null, 2).slice(0, 8000)) } catch { /* skip */ }
  }
  for (const item of rec.detail.slice(-8)) {
    if (item.type === 'diff') parts.push(`--- ${item.path}\n${(item.newText ?? '').slice(0, 4000)}`)
    else if (item.type === 'terminal') parts.push(`terminal ${item.terminalId}`)
    else if (item.type === 'content' && item.content?.type === 'text') parts.push(item.content.text.slice(0, 4000))
    else if (item.type === 'content') parts.push(`[${item.content?.type ?? '?'}]`)
  }
  rec.detailEl.textContent = parts.join('\n\n') || '(无详情)'
}

function renderPlan(entries, st, container) {
  closeRun(st, 'plan')
  if (!st.planEl) {
    const div = document.createElement('div')
    div.className = 'plan'
    container.appendChild(div)
    st.planEl = div
  }
  st.planEl.innerHTML = entries.map(e => {
    const cls = e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'doing' : ''
    const mark = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'
    return `<div class="p ${cls}"><span class="mark">${mark}</span><span>${esc(e.content ?? '')}</span></div>`
  }).join('')
}

function renderPermission(ev) {
  const st = state.stream
  const div = document.createElement('div')
  div.className = 'perm'
  const title = ev.toolCall?.title ?? '权限请求'
  const opts = (ev.options ?? []).map(o =>
    `<button class="mini" data-opt="${esc(o.optionId)}">${esc(o.name ?? o.optionId)}</button>`).join('')
  div.innerHTML = `<div class="q">${esc(title)}</div><div class="opts">${opts}<button class="mini" data-opt="">拒绝</button></div>`
  div.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    const opt = btn.dataset.opt
    api('POST', '/api/permission', { requestId: ev.requestId, optionId: opt || undefined, cancel: !opt }).catch(() => {})
    div.remove()
  }))
  st.permEls.set(ev.requestId, div)
  $('transcript').appendChild(div)
  scrollBottom()
}

function renderRefText(span, text) {
  // Keep path references and the words around them exactly as sent. A compact
  // chip can accidentally swallow adjacent Chinese prose such as “.pvf来理解”.
  span.textContent = text
}

/**
 * Render one transcript-producing update into `container` using run state `st`.
 * Session-level metadata is handled separately by {@link applyMetaUpdate}.
 */
function renderUpdate(u, st, container) {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (u.content?.type === 'text') appendAgentText(u.content.text, st, container, u.messageId ?? undefined)
      break
    case 'agent_thought_chunk':
      if (u.content?.type === 'text') appendThought(u.content.text, st, container)
      break
    case 'user_message_chunk': {
      const c = u.content ?? (typeof u.text === 'string' ? { type: 'text', text: u.text } : undefined)
      if (c?.type !== 'text' && c?.type !== 'image' && c?.type !== 'resource_link' && c?.type !== 'resource') break
      closeRun(st, 'user')
      if (!st.userEl) {
        const div = document.createElement('div')
        div.className = 'msg user'
        div.innerHTML = '<div class="body"></div>'
        container.appendChild(div)
        st.userEl = div.querySelector('.body')
      }
      if (c.type === 'text') {
        st.userBuf += c.text
        st.userEl.querySelector('.utext')?.remove()
        const span = document.createElement('span')
        span.className = 'utext'
        renderRefText(span, st.userBuf)
        st.userEl.appendChild(span)
      } else if (c.type === 'image') {
        const img = document.createElement('img')
        img.className = 'uimg'
        img.src = `data:${c.mimeType};base64,${c.data}`
        // Async image layout changes scrollHeight — re-follow if still near bottom.
        img.addEventListener('load', () => scrollBottom(), { once: true })
        st.userEl.appendChild(img)
      } else {
        // resource_link / embedded resource: render as an attachment line.
        const span = document.createElement('span')
        span.className = 'utext ures'
        const label = c.name ?? c.uri ?? c.resource?.uri ?? '附件'
        span.textContent = `📎 ${label}`
        span.title = c.uri ?? c.resource?.uri ?? ''
        st.userEl.appendChild(span)
      }
      break
    }
    case 'tool_call':
    case 'tool_call_update': toolCard(u, st, container); break
    case 'plan': renderPlan(u.entries ?? [], st, container); break
    case 'compaction_update': {
      closeRun(st, 'note')
      const div = document.createElement('div')
      div.className = 'note warn'
      div.textContent = '上下文压缩中…'
      container.appendChild(div)
      break
    }
    default: break // metadata updates carry no transcript body
  }
}

/** Session-level updates: title, mode/config options, context usage. */
function applyMetaUpdate(u) {
  switch (u.sessionUpdate) {
    case 'session_info_update': {
      if (typeof u.title === 'string' && state.active) {
        state.active.title = u.title
        $('chatTitle').textContent = sessionTitle(state.active.sessionId, u.title)
        const row = state.sessions.find(s => s.sessionId === state.active.sessionId)
        if (row) { row.title = u.title; renderSessions() }
      }
      break
    }
    case 'current_mode_update': {
      const opt = state.configOptions.find(o => o.id === 'mode' || o.category === 'mode')
      if (opt) opt.currentValue = u.currentModeId
      renderOptionBar()
      break
    }
    case 'config_option_update': {
      state.configOptions = u.configOptions ?? []
      renderOptionBar()
      break
    }
    case 'usage_update': {
      const b = $('usageBadge')
      if (u.used != null && u.size) {
        const pct = u.used / u.size
        b.textContent = `${u.used}/${u.size} tok`
        b.className = pct > 0.95 ? 'crit' : pct > 0.8 ? 'warn' : ''
        b.title = `点击发送 /compact 压缩当前上下文${pct > 0.8 ? '（接近上限，建议压缩或开新会话）' : ''}`
      } else b.textContent = ''
      break
    }
    default: break
  }
}

/** Live path: filter, suppress the echoed prompt, render, keep scroll pinned. */
function handleUpdate(ev) {
  if (ev.sessionId !== state.active?.sessionId) return
  let u = ev.update
  applyMetaUpdate(u)
  if (u.sessionUpdate === 'user_message_chunk' && u.content?.type === 'text') {
    const echoBuf = (state.stream.echoBuf ?? '') + u.content.text
    if (state.echoPending !== undefined && state.echoPending.startsWith(echoBuf)) {
      state.stream.echoBuf = echoBuf
      if (echoBuf === state.echoPending) { state.echoPending = undefined; state.stream.echoBuf = '' }
      return // devin echoed our prompt back
    }
    state.stream.echoBuf = ''
    if (echoBuf !== u.content.text) u = { ...u, content: { ...u.content, text: echoBuf } }
  }
  renderUpdate(u, state.stream, $('transcript'))
  scrollBottom()
}

// ---------------------------------------------------------------------------
// paged history (turns, oldest-first)
// ---------------------------------------------------------------------------

/** Turns rendered on first open; older pages stream in on scroll-up. */
const INITIAL_TURNS = 2
const PAGE_TURNS = 5

/** Render one turn's updates into `container`; meta applies only on the tail page. */
function renderTurn(updates, st, container, applyMeta) {
  st.inHistory = true
  try {
    for (const u of updates) {
      try {
        if (applyMeta) applyMetaUpdate(u)
        renderUpdate(u, st, container)
      } catch (err) {
        // One malformed update must not abort the rest of the page.
        console.warn('renderUpdate failed', u.sessionUpdate, err)
      }
    }
  } finally {
    st.inHistory = false
  }
}

/** A thin separator between turns. */
function turnSep(container, index, st) {
  // A turn boundary also closes the open run — without this, two user messages
  // with nothing between them (silent/unresponsive turns) merge into one bubble.
  if (st) closeRun(st, 'sep')
  const div = document.createElement('div')
  div.className = 'turn-sep'
  container.appendChild(div)
}

/** "加载更早" row pinned at the transcript top. */
function renderLoadEarlier() {
  let row = $('loadEarlier')
  if (state.earliestTurn <= 0) { row?.remove(); return }
  if (!row) {
    row = document.createElement('div')
    row.className = 'note'
    row.id = 'loadEarlier'
    row.innerHTML = '<button class="mini"></button>'
    row.querySelector('button').addEventListener('click', loadEarlier)
    $('transcript').prepend(row)
  }
  row.querySelector('button').textContent = `↑ 加载更早的 ${Math.min(PAGE_TURNS, state.earliestTurn)} 轮（共 ${state.totalTurns} 轮）`
}

/** Render turns appended at the end (initial tail). */
function renderTurnsTail(turns, from) {
  const st = state.stream
  const t = $('transcript')
  turns.forEach((updates, i) => {
    if (t.childElementCount > 0 && updates.length > 0) turnSep(t, from + i, st)
    renderTurn(updates, st, t, true)
  })
  // Anchor at the true end: sync, next frame, and a beat later for async
  // layout (images, fonts) that grow scrollHeight after the first pass.
  scrollBottom(true)
  requestAnimationFrame(() => scrollBottom(true))
  setTimeout(() => scrollBottom(true), 200)
}

async function loadEarlier() {
  if (!state.active || state.loadingEarlier || state.earliestTurn <= 0) return
  state.loadingEarlier = true
  const seq = state.openSeq
  const sessionId = state.active.sessionId
  const btn = $('loadEarlier')?.querySelector('button')
  if (btn) btn.textContent = '加载中…'
  try {
    const data = await api('GET', `/api/history?sessionId=${encodeURIComponent(sessionId)}&to=${state.earliestTurn}&count=${PAGE_TURNS}`)
    if (seq !== state.openSeq || state.active?.sessionId !== sessionId) return
    // Render into a detached container, then insert before the load-earlier row.
    const frag = document.createElement('div')
    const st = freshStream()
    const prevHeight = $('transcript').scrollHeight
    data.turns.forEach((updates, i) => {
      if (frag.childElementCount > 0) turnSep(frag, data.from + i, st)
      renderTurn(updates, st, frag, false)
    })
    const row = $('loadEarlier')
    const t = $('transcript')
    // Keep a separator between the prepended page and what follows.
    if (data.turns.length > 0 && row && row.nextSibling) turnSep(frag, data.to, st)
    while (frag.firstChild) t.insertBefore(frag.firstChild, row ?? null)
    state.earliestTurn = data.from
    renderLoadEarlier()
    t.scrollTop += t.scrollHeight - prevHeight // keep viewport anchored
  } catch (err) {
    addNote(`加载更早历史失败：${err.message}`, 'error')
  } finally {
    state.loadingEarlier = false
    renderLoadEarlier()
  }
}

async function renderHistoryTail() {
  const seq = state.openSeq
  const sessionId = state.active.sessionId
  const data = await api('GET', `/api/history?sessionId=${encodeURIComponent(sessionId)}&tail=${INITIAL_TURNS}`)
  if (seq !== state.openSeq || state.active?.sessionId !== sessionId) return
  $('transcript').innerHTML = ''
  state.stream = freshStream()
  state.earliestTurn = data.from
  state.totalTurns = data.totalTurns
  renderLoadEarlier()
  renderTurnsTail(data.turns, data.from)
  if (data.totalTurns === 0) addNote('（空会话）')
}

// ---------------------------------------------------------------------------
// session list + chat switching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sidebar: workspace-grouped session tree (DSH-style)
// ---------------------------------------------------------------------------

const GROUP_ROW_LIMIT = 5

/** Collapsed group keys + fully-expanded row lists, persisted. */
const groupUi = {
  collapsed: new Set(JSON.parse(localStorage.getItem('devin-lite:collapsed') ?? '[]')),
  expanded: new Set(JSON.parse(localStorage.getItem('devin-lite:expanded') ?? '[]')),
  save() {
    localStorage.setItem('devin-lite:collapsed', JSON.stringify([...this.collapsed]))
    localStorage.setItem('devin-lite:expanded', JSON.stringify([...this.expanded]))
  },
}

const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const baseName = (p) => {
  const clean = p.replace(/[\\/]+$/, '')
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return i >= 0 ? clean.slice(i + 1) : clean
}

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 16 16" width="12" height="12"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="folder" viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 2H13A1.5 1.5 0 0 1 14.5 6.5v5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7z" fill="currentColor" opacity=".85"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M2.5 4h11M6.5 4V2.8A.8.8 0 0 1 7.3 2h1.4a.8.8 0 0 1 .8.8V4M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4L12 4M6.5 7v5M9.5 7v5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  fork: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="5" cy="3.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="12.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 5.2v5.6M5 5.2c0 2.4 2 3.7 4.3 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  rename: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2.5 13.5l.8-3.2L10 3.6a1.3 1.3 0 0 1 1.8 0l.6.6a1.3 1.3 0 0 1 0 1.8l-6.7 6.7-3.2.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  box: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 5.5L8 2l6 3.5v5L8 14l-6-3.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2 5.5l6 3.5 6-3.5M8 9v5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  resume: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 8a5 5 0 0 1 8.4-3.6M13 8a5 5 0 0 1-8.4 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.8 1.8v2.7H9.1M4.2 14.2v-2.7h2.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

// Older builds kept archive IDs in one browser's localStorage. Migrate them
// once to the server, resolving cwd/title through the agent's paged list.
const legacyArchiveIds = new Set(JSON.parse(localStorage.getItem('devin-lite:archived') ?? '[]'))
const archivedIds = new Set(legacyArchiveIds)
let sessionView = localStorage.getItem('devin-lite:session-view') === 'archived' ? 'archived' : 'active'
function setSessionView(view) {
  sessionView = view
  localStorage.setItem('devin-lite:session-view', view)
  renderSessions()
  if (view === 'archived') void refreshArchives()
}

async function findLegacyArchiveMetadata(ids) {
  const found = new Map(state.sessions.filter(s => ids.has(s.sessionId)).map(s => [s.sessionId, s]))
  if (found.size === ids.size) return found
  let cursor
  const seen = new Set()
  for (let page = 0; page < 200 && found.size < ids.size; page++) {
    const params = new URLSearchParams({ includeArchived: '1' })
    if (cursor) params.set('cursor', cursor)
    const data = await api('GET', `/api/sessions?${params}`)
    for (const s of data.sessions ?? []) if (ids.has(s.sessionId)) found.set(s.sessionId, s)
    if (!data.nextCursor || seen.has(data.nextCursor)) break
    cursor = data.nextCursor
    seen.add(cursor)
  }
  return found
}

let archiveMigrationWarned = false
let archiveRefreshPromise
function refreshArchives() {
  archiveRefreshPromise ??= loadArchives().finally(() => { archiveRefreshPromise = undefined })
  return archiveRefreshPromise
}
async function loadArchives() {
  let rows
  try {
    const data = await api('GET', '/api/archived')
    rows = Array.isArray(data.archived) ? data.archived : []
    state.archiveReady = true
  } catch (err) {
    if (state.archiveReady) toast(`读取归档失败：${err.message}`, 'error')
    return
  }
  const serverIds = new Set(rows.map(s => s.sessionId))
  const missing = new Set([...legacyArchiveIds].filter(id => !serverIds.has(id)))
  if (missing.size > 0) {
    try {
      const meta = await findLegacyArchiveMetadata(missing)
      for (const sessionId of missing) {
        const s = meta.get(sessionId)
        await api('POST', '/api/sessions/archive', { sessionId, cwd: s?.cwd, title: s?.title })
      }
      rows = (await api('GET', '/api/archived')).archived ?? rows
    } catch (err) {
      if (!archiveMigrationWarned) toast(`旧版归档迁移未完成：${err.message}`, 'warn')
      archiveMigrationWarned = true
    }
  }
  const confirmed = new Set(rows.map(s => s.sessionId))
  for (const id of confirmed) legacyArchiveIds.delete(id)
  if (legacyArchiveIds.size) localStorage.setItem('devin-lite:archived', JSON.stringify([...legacyArchiveIds]))
  else localStorage.removeItem('devin-lite:archived')
  state.archiveRows = rows
  archivedIds.clear()
  for (const id of confirmed) archivedIds.add(id)
  for (const id of legacyArchiveIds) archivedIds.add(id)
  renderSessions()
}

async function setArchived(s, on) {
  try {
    await api('POST', on ? '/api/sessions/archive' : '/api/sessions/unarchive', {
      sessionId: s.sessionId, cwd: s.cwd, title: s.title,
    })
    on ? archivedIds.add(s.sessionId) : archivedIds.delete(s.sessionId)
    if (!on && !state.sessions.some(row => row.sessionId === s.sessionId)) state.sessions.unshift(s)
    if (!on) {
      legacyArchiveIds.delete(s.sessionId)
      if (legacyArchiveIds.size) localStorage.setItem('devin-lite:archived', JSON.stringify([...legacyArchiveIds]))
      else localStorage.removeItem('devin-lite:archived')
    }
  } catch (err) { toast(`${on ? '归档' : '恢复'}失败：${err.message}`, 'error'); return }
  renderSessions()
  await refreshArchives()
}

// Local display-name overrides: devin acp has no session/rename, so custom
// titles live in localStorage and only affect devin-lite's rendering.
const titleOverrides = new Map(Object.entries(JSON.parse(localStorage.getItem('devin-lite:titles') ?? '{}')))
const sessionTitle = (id, fallback) => titleOverrides.get(id) ?? fallback ?? id

function renameSession(s) {
  const current = titleOverrides.get(s.sessionId) ?? s.title ?? ''
  const name = prompt('会话显示名（仅本地生效；留空恢复原标题）', current)
  if (name === null) return
  name.trim() ? titleOverrides.set(s.sessionId, name.trim()) : titleOverrides.delete(s.sessionId)
  localStorage.setItem('devin-lite:titles', JSON.stringify(Object.fromEntries(titleOverrides)))
  if (state.active?.sessionId === s.sessionId) $('chatTitle').textContent = sessionTitle(s.sessionId, s.title)
  renderSessions()
}

async function deleteSession(s) {
  if (!confirm(`删除会话 ${s.title || s.sessionId}？`)) return
  try { await api('POST', '/api/sessions/delete', { sessionId: s.sessionId }) }
  catch (err) { toast(`删除失败：${err.message}`, 'error'); return }
  if (state.active?.sessionId === s.sessionId) clearActive()
  titleOverrides.delete(s.sessionId)
  localStorage.setItem('devin-lite:titles', JSON.stringify(Object.fromEntries(titleOverrides)))
  archivedIds.delete(s.sessionId)
  legacyArchiveIds.delete(s.sessionId)
  if (legacyArchiveIds.size) localStorage.setItem('devin-lite:archived', JSON.stringify([...legacyArchiveIds]))
  else localStorage.removeItem('devin-lite:archived')
  void refreshArchives()
  refreshSessions()
}

let menuEl = null
function closeMenu() { menuEl?.remove(); menuEl = null }

function openRowMenu(anchor, s) {
  closeMenu()
  const archived = archivedIds.has(s.sessionId)
  const items = [
    { icon: ICON.copy, label: '复制会话 ID', run: () => copyText(s.sessionId) },
    { icon: ICON.rename, label: '重命名', run: () => renameSession(s) },
    { icon: ICON.box, label: archived ? '取消归档' : '归档', run: () => setArchived(s, !archived) },
    { icon: ICON.resume, label: '续接新会话', disabled: s.cwd ? undefined : '缺少工作目录', run: () => bridgeSession(s) },
    { sep: true },
    { icon: ICON.trash, label: '删除会话', danger: true, run: () => deleteSession(s) },
  ]
  menuEl = document.createElement('div')
  menuEl.className = 'menu'
  for (const it of items) {
    if (it.sep) { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' })); continue }
    const btn = document.createElement('button')
    btn.className = 'menu-item' + (it.danger ? ' danger' : '')
    btn.innerHTML = `${it.icon}<span></span>`
    btn.querySelector('span').textContent = it.label
    if (it.disabled) { btn.disabled = true; btn.title = it.disabled }
    else btn.addEventListener('click', async () => { closeMenu(); await it.run() })
    menuEl.appendChild(btn)
  }
  document.body.appendChild(menuEl)
  const r = anchor.getBoundingClientRect()
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight
  menuEl.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`
  menuEl.style.top = `${r.bottom + mh > innerHeight ? r.top - mh - 4 : r.bottom + 4}px`
}
document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

function isLockedElsewhere(s) { return s._meta?.['cognition.ai/isLocked'] === true }
function displayRunning(s) { return s._busy || isLockedElsewhere(s) }

function sessionRow(s) {
  const locked = isLockedElsewhere(s)
  const div = document.createElement('div')
  div.className = 'sess' + (state.active?.sessionId === s.sessionId ? ' active' : '') + (archivedIds.has(s.sessionId) ? ' archived' : '')
  div.tabIndex = 0
  div.setAttribute('role', 'button')
  div.dataset.sid = s.sessionId
  div.innerHTML = `
    <div class="title"></div>
    <div class="meta"><span class="run" hidden><i class="run-dot"></i>运行中</span><span class="time"></span></div>
    <div class="ops">
      <button class="icon-btn" data-op="menu" title="会话操作">${ICON.dots}</button>
    </div>`
  div.querySelector('.title').textContent = sessionTitle(s.sessionId, s.title)
  // Local busy is confirmed. Another client's lock is shown as running by
  // default, with the source of that inference visible to the user.
  const run = div.querySelector('.run')
  if (displayRunning(s)) run.hidden = false
  if (locked) {
    if (!s._busy) {
      run.append(' · 其他窗口')
      run.title = '其他窗口占用；无法读取那边的实际执行状态，按运行中显示'
    }
    div.title = '已在其他 Devin 实例中打开；无法读取那边的实际执行状态，按运行中显示。需先在那里关闭才能在此接管'
  } else if (titleOverrides.has(s.sessionId)) {
    div.title = `原标题：${s.title ?? s.sessionId}`
  } else {
    div.title = s.cwd ?? ''
  }
  div.querySelector('.time').textContent = fmtTime(s.updatedAt)
  const waiting = state.queueItems.filter(e => e.sessionId === s.sessionId && e.state !== 'sending').length
  const sending = state.queueItems.some(e => e.sessionId === s.sessionId && e.state === 'sending')
  if (waiting > 0 || sending) {
    const badge = document.createElement('span')
    badge.className = 'queued-count'
    badge.textContent = waiting > 0 ? `${waiting} 条排队` : '发送中'
    div.querySelector('.meta').appendChild(badge)
  }
  div.querySelector('[data-op=menu]').addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(e.currentTarget, s) })
  const activate = () => s.cwd ? openSession(s) : toast('这条旧归档缺少工作目录，请先取消归档后从会话列表查找', 'warn')
  div.addEventListener('click', activate)
  div.addEventListener('keydown', (e) => { if (e.target === div && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate() } })
  return div
}

function renderSessions() {
  const list = $('sessionList')
  list.innerHTML = ''
  const q = $('searchInput').value.trim().toLowerCase()
  $('activeSessionsTab').classList.toggle('active', sessionView === 'active')
  $('archivedSessionsTab').classList.toggle('active', sessionView === 'archived')
  $('activeSessionsTab').setAttribute('aria-selected', sessionView === 'active')
  $('archivedSessionsTab').setAttribute('aria-selected', sessionView === 'archived')
  $('archiveCount').textContent = archivedIds.size ? archivedIds.size : ''

  // Group by normalized cwd, sorted by each group's freshest session.
  // Archived sessions leave their groups and collect under one bottom section.
  const groups = new Map()
  const loadedById = new Map(state.sessions.map(s => [s.sessionId, s]))
  const archivedById = new Map(state.archiveRows.filter(s => archivedIds.has(s.sessionId)).map(s => [s.sessionId, s]))
  for (const id of archivedIds) if (!archivedById.has(id)) archivedById.set(id, { sessionId: id })
  const arch = [...archivedById.values()].map(meta => {
    const loaded = loadedById.get(meta.sessionId)
    return {
      ...meta, ...loaded, sessionId: meta.sessionId,
      cwd: loaded?.cwd ?? meta.cwd, title: loaded?.title ?? meta.title,
      updatedAt: meta.archivedAt ?? loaded?.updatedAt,
    }
  }).filter(s => !q || `${sessionTitle(s.sessionId, s.title)} ${s.sessionId} ${s.cwd ?? ''}`.toLowerCase().includes(q))
  for (const s of state.sessions) {
    if (q && !`${sessionTitle(s.sessionId, s.title)} ${s.sessionId} ${s.cwd ?? ''}`.toLowerCase().includes(q)) continue
    if (archivedIds.has(s.sessionId)) continue
    const key = normalizePath(s.cwd ?? '') || 'ungrouped'
    if (!groups.has(key)) groups.set(key, { key, cwd: s.cwd ?? '', sessions: [] })
    groups.get(key).sessions.push(s)
  }
  const arr = [...groups.values()].sort((a, b) =>
    (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''))

  if (sessionView === 'archived') {
    if (arch.length === 0) {
      const div = document.createElement('div')
      div.className = 'sess-none'
      div.textContent = q ? '没有匹配的归档会话' : '暂无归档会话'
      list.appendChild(div)
    }
    for (const s of arch) list.appendChild(sessionRow(s))
    $('moreBtn').hidden = state.archiveReady || !state.nextCursor
    return
  }

  if (arr.length === 0) {
    const div = document.createElement('div')
    div.className = 'sess-none'
    div.textContent = q ? '没有匹配的会话' : '暂无会话'
    list.appendChild(div)
  }

  for (const g of arr) {
    const gEl = document.createElement('div')
    const closed = groupUi.collapsed.has(g.key)
    gEl.className = 'group' + (closed ? ' closed' : '')
    const head = document.createElement('div')
    head.className = 'group-head'
    head.title = g.cwd || '（无工作目录）'
    head.innerHTML = `${ICON.chev}${ICON.folder}<span class="gname"></span><span class="gcount">${g.sessions.length}</span><button class="icon-btn gnew" title="在此目录新建会话">${ICON.plus}</button>`
    head.querySelector('.gname').textContent = g.cwd ? baseName(g.cwd) : '未分组'
    if (g.sessions.some(displayRunning)) head.querySelector('.gcount').insertAdjacentHTML('beforebegin', '<i class="run-dot" title="有会话运行中或被其他窗口占用"></i>')
    head.addEventListener('click', () => {
      groupUi.collapsed.has(g.key) ? groupUi.collapsed.delete(g.key) : groupUi.collapsed.add(g.key)
      groupUi.save()
      gEl.classList.toggle('closed')
    })
    head.querySelector('.gnew').addEventListener('click', (e) => { e.stopPropagation(); newSession(g.cwd || undefined) })
    gEl.appendChild(head)

    const body = document.createElement('div')
    body.className = 'group-body'
    const all = groupUi.expanded.has(g.key)
    const shown = all ? g.sessions : g.sessions.slice(0, GROUP_ROW_LIMIT)
    for (const s of shown) body.appendChild(sessionRow(s))
    if (g.sessions.length > shown.length) {
      const more = document.createElement('button')
      more.className = 'group-more'
      more.textContent = `展开其余 ${g.sessions.length - shown.length} 个会话`
      more.addEventListener('click', () => { groupUi.expanded.add(g.key); groupUi.save(); renderSessions() })
      body.appendChild(more)
    }
    gEl.appendChild(body)
    list.appendChild(gEl)
  }

  $('moreBtn').hidden = !state.nextCursor
}

async function refreshSessions(append = false, preserveLoaded = false) {
  try {
    if (append && !state.nextCursor) return
    let cursor = append ? state.nextCursor : undefined
    let data
    const fetched = []
    // The server filters archived sessions after ACP pagination. Skip empty
    // source pages so the active list never looks empty with more data behind it.
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams()
      if (cursor) params.set('cursor', cursor)
      data = await api('GET', `/api/sessions?${params}`)
      fetched.push(...(data.sessions ?? []))
      cursor = data.nextCursor
      if (fetched.length || !cursor) break
    }
    if (append || preserveLoaded) {
      const seen = new Set(fetched.map(s => s.sessionId))
      state.sessions = fetched.concat(state.sessions.filter(s => !seen.has(s.sessionId)))
    } else state.sessions = fetched
    state.sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    // Seed per-session busy state from the list snapshot.
    for (const s of state.sessions) s._busy ? state.busySessions.add(s.sessionId) : state.busySessions.delete(s.sessionId)
    if (!preserveLoaded) state.nextCursor = cursor ?? undefined
    renderSessions()
  } catch (err) { toast(`会话列表失败：${err.message}`, 'error') }
}

function setActive(session, configOptions) {
  if (state.active) saveDraft(state.active.sessionId)
  state.active = { sessionId: session.sessionId, cwd: session.cwd, title: session.title }
  localStorage.setItem('devin-lite:active', JSON.stringify(state.active))
  state.stream = freshStream()
  state.earliestTurn = 0
  state.totalTurns = 0
  state.loadingEarlier = false
  state.attachments = []
  state.echoPending = undefined
  state.openSeq++
  renderChips()
  $('transcript').innerHTML = ''
  typingEl = null
  $('chatTitle').textContent = sessionTitle(session.sessionId, session.title) || '(无标题)'
  $('chatId').textContent = session.sessionId
  $('input').disabled = false
  $('sendBtn').disabled = false
  loadDraft(session.sessionId)
  // Busy follows the session: switching back to a running one restores the
  // stop button and typing indicator instead of looking idle.
  setBusy(state.busySessions.has(session.sessionId))
  updateQueueBanner()
  state.configOptions = configOptions ?? []
  renderOptionBar()
  renderSessions()
  $('input').focus()
}

function clearActive() {
  state.active = undefined
  localStorage.removeItem('devin-lite:active')
  state.stream = freshStream()
  showEmptyState()
  $('chatTitle').textContent = '开始使用 Devin Lite'
  $('chatId').textContent = ''
  $('input').disabled = true
  $('sendBtn').disabled = true
  $('stopBtn').hidden = true
  $('busyBadge').hidden = true
  state.configOptions = []
  renderOptionBar()
  updateQueueBanner()
}

async function openSession(s) {
  if (state.active?.sessionId === s.sessionId) return
  setActive({ sessionId: s.sessionId, cwd: s.cwd, title: s.title }, undefined)
  const seq = state.openSeq
  addNote('加载会话…')
  try {
    const res = await api('POST', '/api/sessions/load', { sessionId: s.sessionId, cwd: s.cwd })
    if (seq !== state.openSeq) return // superseded by a newer switch
    if (res.configOptions) { state.configOptions = res.configOptions; renderOptionBar() }
    await renderHistoryTail()
  } catch (err) {
    if (seq !== state.openSeq) return
    const msg = /already open in another process/i.test(err.message)
      ? '该会话正被其他 devin 实例占用（桌面端 / 网页 / 另一个进程）。请先在原处关闭它，再在这里打开。'
      : `加载失败：${err.message}`
    addNote(msg, 'error')
    $('input').disabled = true
    $('sendBtn').disabled = true
  }
}

async function newSession(cwd) {
  cwd ??= await pickFolder()
  if (!cwd) return
  try {
    const created = await api('POST', '/api/sessions/new', { cwd })
    setActive({ sessionId: created.sessionId, cwd, title: '(新会话)' }, created.configOptions)
    refreshSessions()
  } catch (err) { alert(`创建失败：${err.message}`) }
}

/**
 * Context-full escape hatch: open a fresh session in the same directory and
 * seed the composer with a distilled bridge prompt from the old session's
 * buffered tail — the user reviews and sends it like a normal message.
 */
async function bridgeSession(s) {
  let bridge
  try { bridge = await api('GET', `/api/bridge-text?sessionId=${encodeURIComponent(s.sessionId)}`) }
  catch (err) { addNote(`摘要生成失败：${err.message}`, 'warn') }
  try {
    const created = await api('POST', '/api/sessions/new', { cwd: s.cwd })
    setActive({ sessionId: created.sessionId, cwd: s.cwd, title: '(新会话)' }, created.configOptions)
    if (bridge?.text) $('input').value = bridge.text
    refreshSessions()
  } catch (err) { alert(`创建失败：${err.message}`) }
}

/** Render one select per session config option (mode, model, …) in the header. */
function renderOptionBar() {
  const bar = $('optionBar')
  bar.innerHTML = ''
  for (const opt of state.configOptions) {
    if (!Array.isArray(opt.options)) continue
    const sel = document.createElement('select')
    sel.title = opt.description ?? opt.name ?? opt.id
    sel.setAttribute('aria-label', opt.name ?? opt.id)
    sel.innerHTML = `<option disabled>${esc(opt.name ?? opt.id)}</option>`
      + opt.options.map(o => `<option value="${esc(o.value)}"${o.value === opt.currentValue ? ' selected' : ''}>${esc(o.name ?? o.value)}</option>`).join('')
    sel.addEventListener('change', () => {
      if (!state.active) return
      api('POST', '/api/sessions/config', { sessionId: state.active.sessionId, configId: opt.id, value: sel.value, cwd: state.active.cwd })
        .catch(err => addNote(`设置 ${opt.name ?? opt.id} 失败：${err.message}`, 'error'))
    })
    bar.appendChild(sel)
  }
}

// ---------------------------------------------------------------------------
// native folder picker (server-side FolderBrowserDialog)
// ---------------------------------------------------------------------------

/** Open the Windows-native folder picker; resolves to the path or undefined. */
async function pickFolder() {
  try {
    const data = await api('POST', '/api/pick-folder')
    return typeof data.path === 'string' && data.path !== '' ? data.path : undefined
  } catch (err) {
    addNote(`打开目录选择框失败：${err.message}`, 'error')
    return undefined
  }
}

// ---------------------------------------------------------------------------
// composer + SSE
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// per-session composer drafts (text + attachments survive session switches)
// ---------------------------------------------------------------------------

/** sessionId -> { text, attachments[] }; persisted to localStorage best-effort. */
const drafts = new Map(JSON.parse(localStorage.getItem('devin-lite:drafts') ?? '[]'))

function persistDrafts() {
  const save = (m) => localStorage.setItem('devin-lite:drafts', JSON.stringify([...m]))
  // Persist paths, never dataUrls — staged files live on disk under
  // devin-lite/attachments/. Older token drafts are migrated on load.
  const stripped = new Map([...drafts].map(([k, v]) => [k, {
    text: v.text,
    attachments: (v.attachments ?? []).map(a => ({ kind: 'path', name: a.name, path: a.path })),
  }]))
  try { save(stripped) }
  catch {
    try { save(new Map([...drafts].map(([k, v]) => [k, { text: v.text, attachments: [] }]))) } catch { /* give up */ }
  }
}

function saveDraft(sessionId) {
  const text = $('input').value
  if (!text.trim() && state.attachments.length === 0) drafts.delete(sessionId)
  else drafts.set(sessionId, { text, attachments: state.attachments })
  persistDrafts()
}

function loadDraft(sessionId) {
  const d = drafts.get(sessionId)
  let text = d?.text ?? ''
  const attachments = d?.attachments ?? []
  for (const a of attachments.filter(a => a.path)) {
    const token = `{{${a.name}}}`
    if (text.includes(token)) text = text.replaceAll(token, a.path)
    else if (!text.includes(a.path)) text = [text, a.path].filter(Boolean).join('\n')
  }
  $('input').value = text
  state.attachments = attachments.filter(a => !a.path)
  if (d && (text !== d.text || state.attachments.length !== attachments.length)) saveDraft(sessionId)
  renderChips()
}

let draftSaveTimer
$('input').addEventListener('input', () => {
  clearTimeout(draftSaveTimer)
  const sessionId = state.active?.sessionId
  if (sessionId) draftSaveTimer = setTimeout(() => {
    if (state.active?.sessionId === sessionId) saveDraft(sessionId)
  }, 250)
})
window.addEventListener('beforeunload', () => {
  if (state.active) saveDraft(state.active.sessionId)
})

// ---------------------------------------------------------------------------
// File paths in the composer
// ---------------------------------------------------------------------------

function insertAtCursor(value) {
  if (!state.active) { toast('请先打开会话', 'warn'); return false }
  const ta = $('input')
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s
  ta.setRangeText(value, s, e, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
  return true
}

function insertPaths(paths) {
  const list = paths.filter(p => typeof p === 'string' && p !== '')
  if (list.length > 0) insertAtCursor(list.join('\n'))
}

// Native clipboard/file-picker calls are asynchronous. A marker anchors the
// insertion position even if the user keeps typing or changes sessions.
let pendingPathSeq = 0
function beginPathInsert() {
  const sessionId = state.active?.sessionId
  if (!sessionId) { toast('请先打开会话', 'warn'); return null }
  const marker = `⟦正在读取文件路径 ${++pendingPathSeq}⟧`
  if (!insertAtCursor(marker)) return null
  return { sessionId, marker }
}

function finishPathInsert(pending, paths, error) {
  if (!pending) return
  const replacement = (paths ?? []).filter(p => typeof p === 'string' && p !== '').join('\n')
  const ta = $('input')
  if (state.active?.sessionId === pending.sessionId) {
    const at = ta.value.indexOf(pending.marker)
    if (at >= 0) {
      const delta = replacement.length - pending.marker.length
      const move = (pos) => pos <= at ? pos : pos >= at + pending.marker.length ? pos + delta : at + replacement.length
      const s = move(ta.selectionStart), e = move(ta.selectionEnd)
      ta.value = ta.value.slice(0, at) + replacement + ta.value.slice(at + pending.marker.length)
      ta.selectionStart = s; ta.selectionEnd = e
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  } else {
    const draft = drafts.get(pending.sessionId)
    if (draft?.text?.includes(pending.marker)) {
      draft.text = draft.text.replace(pending.marker, replacement)
      if (!draft.text.trim() && (draft.attachments?.length ?? 0) === 0) drafts.delete(pending.sessionId)
      persistDrafts()
    }
  }
  if (!replacement && error) toast(error, 'error')
}

async function stageImageDataUrl(dataUrl, pending) {
  try {
    const res = await api('POST', '/api/attach', { dataUrl })
    if (typeof res.path !== 'string' || !res.path) throw new Error('未返回磁盘路径')
    finishPathInsert(pending, [res.path])
  } catch (err) {
    finishPathInsert(pending, [], `图片保存失败：${err.message}`)
  }
}

async function stageImageFile(file, pending) {
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
      reader.readAsDataURL(file)
    })
    await stageImageDataUrl(dataUrl, pending)
  } catch (err) {
    finishPathInsert(pending, [], `图片读取失败：${err.message}`)
  }
}

function addPathRef(path) { insertPaths([path]) }

/** Best-effort absolute path extraction from a drag payload. */
function droppedPaths(e) {
  const dt = e.clipboardData ?? e.dataTransfer
  const uri = dt?.getData('text/uri-list') ?? ''
  const plain = dt?.getData('text/plain') ?? ''
  const out = []
  for (const line of `${uri}\n${plain}`.split(/\r?\n/)) {
    const l = line.trim()
    if (/^file:\/\/\/[A-Za-z]:/.test(l)) out.push(decodeURIComponent(l.replace('file:///', '').replaceAll('/', '\\')))
    else if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(l)) out.push(l)
  }
  return [...new Set(out)]
}

function renderChips() {
  const row = $('attachChips')
  row.innerHTML = ''
  row.hidden = state.attachments.length === 0
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span')
    const visual = a.kind === 'image' && a.dataUrl // restored drafts keep path only
    chip.className = 'achip' + (visual ? '' : ' path')
    chip.title = `${a.name} — ${a.path ?? a.name}\n点击插入路径到光标处`
    chip.innerHTML = visual
      ? `<img><span class="pname"><b></b></span><button title="移除">×</button>`
      : `<span class="pname">📄 <b></b></span><button title="移除">×</button>`
    if (visual) chip.querySelector('img').src = a.dataUrl
    chip.querySelector('b').textContent = a.name
    chip.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON' && a.path) insertAtCursor(a.path) })
    chip.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation()
      state.attachments.splice(i, 1)
      // Removing the attachment removes its inline token too — no orphan
      // `{{name}}` literal is left to be sent verbatim.
      const ta = $('input')
      ta.value = ta.value.replaceAll(`{{${a.name}}}`, '')
      renderChips()
    })
    row.appendChild(chip)
  })
}

function clipboardPathsMatchFiles(paths, files) {
  if (files.length === 0) return true // some Explorer pastes expose only CF_HDROP
  const expected = files.map(f => f.name.toLowerCase()).sort()
  const actual = paths.map(p => p.split(/[\\/]/).pop().toLowerCase()).sort()
  return expected.length === actual.length && expected.every((name, i) => name && name === actual[i])
}

$('input').addEventListener('paste', async (e) => {
  const dt = e.clipboardData
  const items = [...(dt?.items ?? [])]
  const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
  const plain = dt?.getData('text/plain') ?? ''
  const html = dt?.getData('text/html') ?? ''
  const src = /<img[^>]+src="([^"]+)"/i.exec(html)?.[1]
  if (files.length === 0 && src?.startsWith('file:///')) {
    e.preventDefault()
    insertPaths([decodeURIComponent(src.replace(/^file:\/\/\//, '').replace(/\//g, '\\'))])
    return
  }
  if (files.length === 0 && src?.startsWith('data:image/')) {
    e.preventDefault()
    const pending = beginPathInsert()
    if (pending) await stageImageDataUrl(src, pending)
    return
  }
  if (files.length === 0 && (plain || html)) return // ordinary clipboard content, including a typed path
  e.preventDefault()
  const pending = beginPathInsert()
  if (!pending) return
  // Explorer file objects have their real path in CF_HDROP, even when the
  // browser only exposes a nameless File. This works for any file extension.
  try {
    const res = await api('POST', '/api/clipboard-files')
    if (res.paths?.length && clipboardPathsMatchFiles(res.paths, files)) {
      finishPathInsert(pending, res.paths)
      return
    }
  } catch { /* image clipboard can still be staged below */ }
  if (files.length === 1 && files[0].type.startsWith('image/')) {
    await stageImageFile(files[0], pending)
  } else if (src?.startsWith('data:image/')) {
    await stageImageDataUrl(src, pending)
  } else {
    finishPathInsert(pending, [], '未读取到磁盘路径；请在资源管理器中复制文件后粘贴')
  }
})
$('composer').addEventListener('dragover', (e) => { e.preventDefault() })
$('composer').addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])]
  const paths = droppedPaths(e)
  if (files.length === 0 && paths.length === 0) return
  e.preventDefault()
  if (paths.length) { insertPaths(paths); return }
  if (files.length === 1 && files[0].type.startsWith('image/')) {
    const pending = beginPathInsert()
    if (pending) void stageImageFile(files[0], pending)
  } else toast('浏览器未提供拖入文件的磁盘路径，请在资源管理器复制后粘贴，或使用文件选择按钮', 'warn')
})
$('attachBtn').addEventListener('click', async () => {
  const pending = beginPathInsert()
  if (!pending) return
  try {
    const res = await api('POST', '/api/pick-file')
    finishPathInsert(pending, res.paths ?? [])
  } catch (err) { finishPathInsert(pending, [], `文件选择失败：${err.message}`) }
})

// ---------------------------------------------------------------------------
// composer + SSE
// ---------------------------------------------------------------------------

async function send() {
  if (state.active && state.busySessions.has(state.active.sessionId)) return
  if ($('input').value.includes('⟦正在读取文件路径 ')) {
    toast('正在读取文件路径，请稍候', 'warn')
    return
  }
  if (!state.active) return
  const sessionId = state.active.sessionId
  const cwd = state.active.cwd
  const rawText = $('input').value.trim()
  const atts = [...state.attachments]
  // Migrate old draft attachments to path-only text before sending. No ACP
  // image content block is emitted, including for a previously pasted image.
  for (const a of atts) {
    if (a.path) continue
    if (!a.dataUrl) { toast(`请重新粘贴 ${a.name}，旧附件缺少磁盘路径`, 'error'); return }
    try { a.path = (await api('POST', '/api/attach', { dataUrl: a.dataUrl })).path }
    catch (err) { toast(`文件保存失败：${err.message}`, 'error'); return }
    if (!a.path) { toast('文件保存失败：未返回磁盘路径', 'error'); return }
  }
  if (state.active?.sessionId !== sessionId || $('input').value.trim() !== rawText) return
  let text = rawText.replace(/\{\{(.+?)\}\}/g, (m, name) => {
    const a = atts.find(x => x.name === name.trim())
    return a?.path ?? m
  })
  const unused = atts.filter(a => a.path && !rawText.includes(`{{${a.name}}}`)).map(a => a.path)
  if (unused.length > 0) text = [text, `附加文件：\n${unused.join('\n')}`].filter(Boolean).join('\n\n')
  if (!text) return
  state.lastSent = { text: rawText, atts }
  $('input').value = ''
  state.attachments = []
  drafts.delete(sessionId)
  persistDrafts()
  renderChips()
  state.echoPending = text
  state.stream.echoBuf = ''
  // Optimistic user bubble, visually separated from the previous turn. Only
  // The optimistic echo shows exactly the text and paths sent to Devin.
  if ($('transcript').childElementCount > 0) turnSep($('transcript'), undefined, state.stream)
  else closeRun(state.stream, 'sep')
  renderUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, state.stream, $('transcript'))
  scrollBottom()
  state.busySessions.add(sessionId)
  setBusy(true)
  try {
    const res = await api('POST', '/api/prompt', { sessionId, cwd, text })
    // Queued behind the shared concurrency budget: not running, not failed —
    // the bubble stays and the prompt-dispatch event announces the retry.
    if (res?.deferred) {
      state.busySessions.delete(sessionId)
      if (state.active?.sessionId === sessionId) setBusy(false)
      void refreshQueue()
    }
  } catch (err) {
    state.busySessions.delete(sessionId)
    if (state.active?.sessionId === sessionId) setBusy(false)
    toast(`发送失败：${err.message}`, 'error')
    // Put the draft back — a failed send must not swallow the message.
    drafts.set(sessionId, { text: rawText, attachments: atts })
    persistDrafts()
    if (state.active?.sessionId !== sessionId) return
    $('input').value = rawText
    state.attachments = atts
    renderChips()
    // And roll back the optimistic bubble if nothing arrived after it.
    const ue = state.stream.userEl?.parentElement
    if (ue && $('transcript').lastElementChild === ue) {
      const prev = ue.previousElementSibling
      ue.remove()
      if (prev?.classList.contains('turn-sep')) prev.remove()
    }
  }
}

/**
 * Flag the latest user bubble of a failed turn and offer 撤回 — restores the
 * draft (text + attachments) and removes the bubble. If devin already
 * committed the message this is view-level only; it reappears on reload.
 */
function markLastUserFailed() {
  const bubbles = $('transcript').querySelectorAll('.msg.user')
  const ue = bubbles[bubbles.length - 1]
  if (!ue || ue.querySelector('.undo-btn')) return
  ue.classList.add('failed')
  const btn = document.createElement('button')
  btn.className = 'undo-btn'
  btn.textContent = '↩ 撤回'
  btn.title = '恢复到输入框重新发送（如 devin 已提交该消息，撤回仅移除本地显示）'
  btn.addEventListener('click', () => {
    if (state.lastSent) {
      $('input').value = state.lastSent.text
      state.attachments = state.lastSent.atts
      state.lastSent = undefined
      renderChips()
      $('input').focus()
    }
    const prev = ue.previousElementSibling
    ue.remove()
    if (prev?.classList.contains('turn-sep')) prev.remove()
  })
  ue.appendChild(btn)
}

let typingEl = null
function setBusy(on) {
  state.busy = on
  $('busyBadge').hidden = !on
  $('stopBtn').hidden = !on
  $('sendBtn').disabled = on || !state.active
  if (on) {
    if (!typingEl?.isConnected) { // send() and the busy SSE both call setBusy(true)
      typingEl = document.createElement('div')
      typingEl.className = 'typing'
      typingEl.innerHTML = '<i></i><i></i><i></i><span>devin 正在处理</span>'
      $('transcript').appendChild(typingEl)
    }
    scrollBottom()
  } else {
    typingEl?.remove()
    typingEl = null
  }
}

function connectEvents() {
  const es = new EventSource('/api/events')
  es.onopen = () => { $('connectionDot').className = 'connection-dot online' }
  es.onmessage = (e) => {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    switch (ev.kind) {
      case 'update': handleUpdate(ev); break
      case 'busy': {
        ev.busy ? state.busySessions.add(ev.sessionId) : state.busySessions.delete(ev.sessionId)
        if (ev.sessionId === state.active?.sessionId) setBusy(ev.busy)
        const row = state.sessions.find(s => s.sessionId === ev.sessionId)
        if (row) row._busy = ev.busy
        renderSessions() // covers rows beyond the group limit / collapsed groups
        break
      }
      case 'attach-paths': for (const p of ev.paths ?? []) addPathRef(p); break
      case 'session-archived': {
        if (ev.archived) archivedIds.add(ev.sessionId)
        else {
          archivedIds.delete(ev.sessionId)
          const old = state.archiveRows.find(s => s.sessionId === ev.sessionId)
          if (old && !state.sessions.some(s => s.sessionId === ev.sessionId)) state.sessions.unshift(old)
        }
        renderSessions()
        void refreshArchives()
        break
      }
      case 'permission': if (ev.sessionId === state.active?.sessionId) renderPermission(ev); break
      case 'permission-done': state.stream.permEls.get(ev.requestId)?.remove(); state.stream.permEls.delete(ev.requestId); break
      case 'prompt-deferred': {
        state.busySessions.delete(ev.sessionId)
        const row = state.sessions.find(s => s.sessionId === ev.sessionId)
        if (row) row._busy = false
        if (ev.sessionId === state.active?.sessionId) setBusy(false)
        const when = typeof ev.waitSeconds === 'number' && ev.waitSeconds > 0 ? `约 ${ev.waitSeconds} 秒后重发` : '空位恢复后自动发送'
        toast(`消息已排队（第 ${ev.position} 位）· ${when}`, 'warn')
        void refreshQueue()
        renderSessions()
        break
      }
      case 'prompt-dispatch': {
        toast('排队消息正在发送')
        void refreshQueue()
        break
      }
      case 'prompt-done': {
        state.busySessions.delete(ev.sessionId)
        void refreshQueue()
        if (ev.sessionId !== state.active?.sessionId) break
        setBusy(false)
        // Turn settled — a stale echo token must not swallow future echoes.
        state.echoPending = undefined
        state.stream.echoBuf = ''
        if (ev.error) { addNote(`回合失败：${ev.error}`, 'error'); markLastUserFailed() }
        else if (ev.stopReason && ev.stopReason !== 'end_turn') addNote(`回合结束：${ev.stopReason}`, 'warn')
        break
      }
      case 'agent-down': toast(`Devin CLI 已退出：${ev.message}。请刷新页面后重试。`, 'error'); break
      case 'queue': void refreshQueue(); break
      default: break
    }
  }
  es.onerror = () => { $('connectionDot').className = 'connection-dot offline' } // EventSource auto-reconnects

  // Busy/lock state lives on other processes too — refresh the list snapshot
  // periodically so running indicators and relative times stay truthful.
  setInterval(() => { refreshSessions(false, true).catch(() => {}) }, 20_000)
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

$('sendBtn').addEventListener('click', send)
$('queueCancel').addEventListener('click', async () => {
  const queueId = $('queueCancel').dataset.queueId
  if (!queueId) return
  try {
    await api('POST', '/api/queue/drop', { queueId })
    toast('已取消这条排队消息')
    await refreshQueue()
  } catch (err) { toast(`取消排队失败：${err.message}`, 'error') }
})
setInterval(() => { if (!state.queueItems.length) return; updateQueueBanner() }, 1000)
const savedTheme = localStorage.getItem('devin-lite:theme')
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light'
$('themeBtn').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  localStorage.setItem('devin-lite:theme', theme)
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#171a20' : '#f8f9fb'
})
const toggleSidebar = () => {
  document.body.classList.toggle('sidebar-collapsed')
  const closed = document.body.classList.contains('sidebar-collapsed')
  $('sidebarExpand').hidden = !closed
  localStorage.setItem('devin-lite:sidebar-collapsed', closed ? '1' : '0')
}
$('sidebarToggle').addEventListener('click', toggleSidebar)
$('sidebarExpand').addEventListener('click', toggleSidebar)
if (localStorage.getItem('devin-lite:sidebar-collapsed') === '1') {
  document.body.classList.add('sidebar-collapsed')
  $('sidebarExpand').hidden = false
}
// Click the usage badge to force compaction — devin exposes /compact as a
// slash command, so it rides the normal prompt path as a visible message.
$('usageBadge').addEventListener('click', () => {
  if (!state.active || state.busySessions.has(state.active.sessionId)) return
  $('input').value = '/compact'
  send()
})
$('stopBtn').addEventListener('click', () => {
  if (state.active) api('POST', '/api/cancel', { sessionId: state.active.sessionId }).catch(() => {})
})
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
})
$('newBtn').addEventListener('click', () => newSession())
$('reloadBtn').addEventListener('click', () => { void Promise.all([refreshSessions(), refreshArchives()]) })
$('moreBtn').addEventListener('click', () => refreshSessions(true))
$('activeSessionsTab').addEventListener('click', () => setSessionView('active'))
$('archivedSessionsTab').addEventListener('click', () => setSessionView('archived'))
$('searchToggle').addEventListener('click', () => {
  const row = $('searchRow')
  row.hidden = !row.hidden
  if (!row.hidden) $('searchInput').focus()
  else { $('searchInput').value = ''; renderSessions() }
})
$('searchInput').addEventListener('input', renderSessions)
$('chatId').addEventListener('click', () => { if (state.active) copyText(state.active.sessionId) })
// Scroll-to-top streams in the previous page of turns automatically. The
// armed flag prevents a short prepended page from chain-firing: it must see
// the viewport below the trigger zone once before the next auto-load.
let histArm = true
$('transcript').addEventListener('scroll', () => {
  const top = $('transcript').scrollTop
  if (top > 200) histArm = true
  if (histArm && top < 60 && state.earliestTurn > 0) {
    histArm = false
    loadEarlier()
  }
})

;(async () => {
  connectEvents()
  try {
    const status = await api('GET', '/api/status')
    $('agentInfo').textContent = `${status.agentInfo.name ?? 'devin'} ${status.agentInfo.version ?? ''}`
    $('connectionDot').className = 'connection-dot online'
    await Promise.all([refreshSessions(), refreshQueue()])
    void refreshArchives()
    try {
      const saved = JSON.parse(localStorage.getItem('devin-lite:active') ?? 'null')
      if (saved && typeof saved.sessionId === 'string' && typeof saved.cwd === 'string') {
        const current = state.sessions.find(s => s.sessionId === saved.sessionId) ?? saved
        await openSession(current)
      }
    } catch { localStorage.removeItem('devin-lite:active') }
  } catch (err) {
    void refreshArchives() // server archive metadata is readable even if ACP is down
    $('agentInfo').textContent = `devin acp 不可用：${err.message}`
    $('agentInfo').style.color = 'var(--red)'
    $('connectionDot').className = 'connection-dot offline'
  }
})()
