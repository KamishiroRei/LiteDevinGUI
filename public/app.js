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
  configOptions: [],     // select-type session config options (mode, model, …)
  echoPending: undefined, // text of the just-sent prompt, for echo suppression
  earliestTurn: 0,       // first rendered history turn index
  totalTurns: 0,
  loadingEarlier: false,
  attachments: [],        // pending { name, mimeType, dataUrl } image chips
  openSeq: 0,             // increments per session switch; stale async renders bail
  stream: freshStream(),
}

function freshStream() {
  return {
    agentEl: undefined, agentBuf: '', agentMsgId: undefined,
    thinkEl: undefined, thinkBuf: '',
    userEl: undefined, userBuf: '',
    tools: new Map(),   // toolCallId -> { el, statusEl, detailEl, nameEl }
    planEl: undefined,
    permEls: new Map(), // requestId -> element
    lastKind: '',       // last rendered update kind — closes open runs on switch
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

/** Minimal markdown: fences, headings, lists, paragraphs, inline marks. */
function md(src) {
  return src.split(/\n{2,}/).map((block) => {
    const fence = /^```(\w*)\n?([\s\S]*?)```$/s.exec(block.trim())
    if (fence) return `<pre><code>${esc(fence[2])}</code></pre>`
    const head = /^(#{1,6})\s+([\s\S]*)$/s.exec(block.trim())
    if (head) return `<h3>${inline(esc(head[2]))}</h3>`
    const lines = block.split('\n')
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

/**
 * Close the currently open run when a different kind of update arrives.
 * Contiguous same-kind chunks share one element; a kind switch (or a new
 * messageId) opens a fresh element so messages never merge into one blob.
 */
function closeRun(st, kind) {
  if (st.lastKind === kind) return
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
    div.innerHTML = '<div class="body"></div>'
    container.appendChild(div)
    st.agentEl = div.querySelector('.body')
  }
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
  let rec = st.tools.get(update.toolCallId)
  if (!rec) {
    const el = document.createElement('div')
    el.className = 'tool'
    el.innerHTML = `<div class="head"><span class="kind"></span><span class="name"></span><span class="status"></span></div><div class="detail"></div>`
    el.querySelector('.head').addEventListener('click', () => el.classList.toggle('open'))
    container.appendChild(el)
    rec = { el, nameEl: el.querySelector('.name'), kindEl: el.querySelector('.kind'), statusEl: el.querySelector('.status'), detailEl: el.querySelector('.detail'), rawInput: undefined, detail: [] }
    st.tools.set(update.toolCallId, rec)
  }
  // Merge semantics: an update only replaces a field it actually carries —
  // devin sends '' (not null) for absent fields, which must not blank the card.
  const name = update.name || update.title || ''
  const title = update.title || ''
  if (name || title) rec.nameEl.textContent = title && title !== name ? `${name} — ${title}` : (name || title)
  else if (!rec.nameEl.textContent) rec.nameEl.textContent = update.toolCallId
  if (update.kind) rec.kindEl.textContent = `${KIND_ICON[update.kind] ?? '🔧'} ${update.kind}`
  if (update.rawInput !== undefined) rec.rawInput = update.rawInput
  const locs = (update.locations ?? []).map(l => l.path).join('\n')
  if (update.status) {
    rec.statusEl.textContent = { pending: '排队', in_progress: '运行中…', completed: '完成', failed: '失败' }[update.status] ?? update.status
    rec.statusEl.className = `status ${update.status}`
  }
  for (const item of update.content ?? []) rec.detail.push(item)
  renderToolDetail(rec, locs)
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
      const c = u.content
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
        span.textContent = st.userBuf
        st.userEl.appendChild(span)
      } else if (c.type === 'image') {
        const img = document.createElement('img')
        img.className = 'uimg'
        img.src = `data:${c.mimeType};base64,${c.data}`
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
      $('usageBadge').textContent = u.used != null ? `${u.used}/${u.size} tok` : ''
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
  for (const u of updates) {
    if (applyMeta) applyMetaUpdate(u)
    renderUpdate(u, st, container)
  }
}

/** A thin separator between turns. */
function turnSep(container, index) {
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
    if (t.childElementCount > 0 && updates.length > 0) turnSep(t, from + i)
    renderTurn(updates, st, t, true)
  })
  scrollBottom(true)
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
      if (frag.childElementCount > 0) turnSep(frag, data.from + i)
      renderTurn(updates, st, frag, false)
    })
    const row = $('loadEarlier')
    const t = $('transcript')
    // Keep a separator between the prepended page and what follows.
    if (data.turns.length > 0 && row && row.nextSibling) turnSep(frag, data.to)
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
  lock: '<svg viewBox="0 0 16 16" width="11" height="11"><rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  fork: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="5" cy="3.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="12.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 5.2v5.6M5 5.2c0 2.4 2 3.7 4.3 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  rename: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2.5 13.5l.8-3.2L10 3.6a1.3 1.3 0 0 1 1.8 0l.6.6a1.3 1.3 0 0 1 0 1.8l-6.7 6.7-3.2.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
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
  await api('POST', '/api/sessions/delete', { sessionId: s.sessionId }).catch(err => alert(err.message))
  if (state.active?.sessionId === s.sessionId) clearActive()
  refreshSessions()
}

let menuEl = null
function closeMenu() { menuEl?.remove(); menuEl = null }

function openRowMenu(anchor, s) {
  closeMenu()
  const items = [
    { icon: ICON.copy, label: '复制会话 ID', run: () => copyText(s.sessionId) },
    { icon: ICON.rename, label: '重命名', run: () => renameSession(s) },
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

function sessionRow(s) {
  const locked = s._meta?.['cognition.ai/isLocked'] === true
  const div = document.createElement('div')
  div.className = 'sess' + (state.active?.sessionId === s.sessionId ? ' active' : '')
  div.dataset.sid = s.sessionId
  div.innerHTML = `
    <div class="title"></div>
    <div class="meta"><span class="run" hidden><i class="run-dot"></i>运行中</span><span class="time"></span></div>
    <div class="ops">
      <button class="icon-btn" data-op="menu" title="会话操作">${ICON.dots}</button>
    </div>`
  div.querySelector('.title').textContent = sessionTitle(s.sessionId, s.title)
  // 运行中 = 本进程在途 prompt(_busy)，或在其他实例打开(isLocked≈正在运行)
  if (s._busy || locked) div.querySelector('.run').hidden = false
  if (locked) {
    div.querySelector('.meta').insertAdjacentHTML('afterbegin', `<span title="已在其他 devin 实例中打开" style="color:var(--yellow);display:inline-flex">${ICON.lock}</span>`)
    div.title = '已在其他 devin 实例中打开（桌面端/网页/另一进程），需先在那里关闭'
  } else if (titleOverrides.has(s.sessionId)) {
    div.title = `原标题：${s.title ?? s.sessionId}`
  } else {
    div.title = s.cwd ?? ''
  }
  div.querySelector('.time').textContent = fmtTime(s.updatedAt)
  div.querySelector('[data-op=menu]').addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(e.currentTarget, s) })
  div.addEventListener('click', () => openSession(s))
  return div
}

function renderSessions() {
  const list = $('sessionList')
  list.innerHTML = ''
  const q = $('searchInput').value.trim().toLowerCase()

  // Group by normalized cwd, sorted by each group's freshest session.
  const groups = new Map()
  for (const s of state.sessions) {
    if (q && !`${s.title ?? ''} ${s.sessionId}`.toLowerCase().includes(q)) continue
    const key = normalizePath(s.cwd ?? '') || 'ungrouped'
    if (!groups.has(key)) groups.set(key, { key, cwd: s.cwd ?? '', sessions: [] })
    groups.get(key).sessions.push(s)
  }
  const arr = [...groups.values()].sort((a, b) =>
    (b.sessions[0]?.updatedAt ?? '').localeCompare(a.sessions[0]?.updatedAt ?? ''))

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
    if (g.sessions.some(s => s._busy)) head.querySelector('.gcount').insertAdjacentHTML('beforebegin', '<i class="run-dot" title="有会话正在运行"></i>')
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

async function refreshSessions(append = false) {
  try {
    const params = new URLSearchParams()
    if (append && state.nextCursor) params.set('cursor', state.nextCursor)
    const data = await api('GET', `/api/sessions?${params}`)
    state.sessions = append ? state.sessions.concat(data.sessions ?? []) : (data.sessions ?? [])
    state.sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    state.nextCursor = data.nextCursor ?? undefined
    renderSessions()
  } catch (err) { addNote(`会话列表失败：${err.message}`, 'error') }
}

function setActive(session, configOptions) {
  if (state.active) saveDraft(state.active.sessionId)
  state.active = { sessionId: session.sessionId, cwd: session.cwd, title: session.title }
  state.stream = freshStream()
  state.busy = false
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
  $('busyBadge').hidden = true
  $('stopBtn').hidden = true
  state.configOptions = configOptions ?? []
  renderOptionBar()
  renderSessions()
  $('input').focus()
}

function clearActive() {
  state.active = undefined
  state.stream = freshStream()
  $('transcript').innerHTML = ''
  $('chatTitle').textContent = '未选择会话'
  $('chatId').textContent = ''
  $('input').disabled = true
  $('sendBtn').disabled = true
  $('stopBtn').hidden = true
  $('busyBadge').hidden = true
  state.configOptions = []
  renderOptionBar()
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

/** Render one select per session config option (mode, model, …) in the header. */
function renderOptionBar() {
  const bar = $('optionBar')
  bar.innerHTML = ''
  for (const opt of state.configOptions) {
    if (!Array.isArray(opt.options)) continue
    const sel = document.createElement('select')
    sel.title = opt.description ?? opt.name ?? opt.id
    sel.style.cssText = 'font-size:12px;padding:3px 6px;max-width:200px'
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
  try { save(drafts) }
  catch {
    // Attachment data URLs can exceed the quota; degrade to text-only.
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
  $('input').value = d?.text ?? ''
  state.attachments = d?.attachments ?? []
  renderChips()
}

// ---------------------------------------------------------------------------
// image attachments (paste / drop → ACP image content blocks)
// ---------------------------------------------------------------------------

// Attachments: images travel as base64 blocks; other files are referenced by
// path only — devin reads local files itself, no byte copies.
function addAttachment(file) {
  if (!file || !file.type.startsWith('image/') || state.attachments.length >= 8) return
  const rd = new FileReader()
  rd.onload = () => {
    state.attachments.push({ kind: 'image', name: file.name || 'image', mimeType: file.type, dataUrl: rd.result })
    renderChips()
  }
  rd.readAsDataURL(file)
}

function addPathRef(path) {
  if (state.attachments.length >= 8) return
  const name = path.split(/[\\/]/).pop() || path
  state.attachments.push({ kind: 'path', name, path })
  renderChips()
}

/** Best-effort absolute path extraction from paste/drop data. */
function droppedPaths(e) {
  const dt = e.clipboardData ?? e.dataTransfer
  const uri = dt?.getData('text/uri-list') ?? ''
  const plain = dt?.getData('text/plain') ?? ''
  const out = []
  for (const line of `${uri}\n${plain}`.split(/\r?\n/)) {
    const l = line.trim()
    if (/^file:\/\/\/[A-Za-z]:/.test(l)) out.push(decodeURIComponent(l.replace('file:///', '').replaceAll('/', '\\')))
    else if (/^[A-Za-z]:[\\/]/.test(l) || l.startsWith('\\\\')) out.push(l)
  }
  return out
}

function renderChips() {
  const row = $('attachChips')
  row.innerHTML = ''
  row.hidden = state.attachments.length === 0
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span')
    chip.className = 'achip' + (a.kind === 'path' ? ' path' : '')
    chip.title = a.kind === 'path' ? a.path : a.name
    chip.innerHTML = a.kind === 'path'
      ? `<span class="pname">📄 <b></b></span><button title="移除">×</button>`
      : `<img><button title="移除">×</button>`
    if (a.kind === 'path') chip.querySelector('b').textContent = a.name
    else chip.querySelector('img').src = a.dataUrl
    chip.querySelector('button').addEventListener('click', () => { state.attachments.splice(i, 1); renderChips() })
    row.appendChild(chip)
  })
}

$('input').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items ?? [])].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
  const paths = droppedPaths(e)
  if (items.length === 0 && paths.length === 0) return
  e.preventDefault()
  for (const i of items) addAttachment(i.getAsFile())
  for (const p of paths) addPathRef(p)
})
$('composer').addEventListener('dragover', (e) => { e.preventDefault() })
$('composer').addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])]
  const paths = droppedPaths(e)
  if (files.length === 0 && paths.length === 0) return
  e.preventDefault()
  let nonImage = 0
  for (const f of files) f.type.startsWith('image/') ? addAttachment(f) : nonImage++
  for (const p of paths) addPathRef(p)
  if (nonImage > 0 && paths.length === 0) addNote('浏览器拿不到拖放文件的本地路径——请用 📎 按钮选择文件', 'warn')
})
$('attachBtn').addEventListener('click', async () => {
  try {
    const res = await api('POST', '/api/pick-file')
    for (const p of res.paths ?? []) addPathRef(p)
  } catch (err) { addNote(`文件选择失败：${err.message}`, 'error') }
})

// ---------------------------------------------------------------------------
// composer + SSE
// ---------------------------------------------------------------------------

async function send() {
  const paths = state.attachments.filter(a => a.kind === 'path').map(a => a.path)
  const imgs = state.attachments.filter(a => a.kind === 'image')
  const pathRef = paths.length > 0 ? `${paths.length > 1 ? '附加文件' : '附加文件'}：\n${paths.join('\n')}` : ''
  const text = [$('input').value.trim(), pathRef].filter(Boolean).join('\n\n')
  if ((!text && imgs.length === 0) || !state.active) return
  $('input').value = ''
  state.attachments = []
  drafts.delete(state.active.sessionId)
  persistDrafts()
  renderChips()
  state.echoPending = text
  state.stream.echoBuf = ''
  // Optimistic user bubble, visually separated from the previous turn.
  if ($('transcript').childElementCount > 0) turnSep($('transcript'))
  for (const a of imgs) {
    renderUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'image', data: a.dataUrl.split(',')[1], mimeType: a.mimeType } }, state.stream, $('transcript'))
  }
  if (text) renderUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, state.stream, $('transcript'))
  scrollBottom()
  setBusy(true)
  try {
    await api('POST', '/api/prompt', {
      sessionId: state.active.sessionId, cwd: state.active.cwd, text,
      images: imgs.map(a => ({ data: a.dataUrl.split(',')[1], mimeType: a.mimeType })),
    })
  } catch (err) {
    setBusy(false)
    addNote(`发送失败：${err.message}`, 'error')
  }
}

let typingEl = null
function setBusy(on) {
  state.busy = on
  $('busyBadge').hidden = !on
  $('stopBtn').hidden = !on
  if (on) {
    typingEl = document.createElement('div')
    typingEl.className = 'typing'
    typingEl.innerHTML = '<i></i><i></i><i></i><span>devin 正在处理</span>'
    $('transcript').appendChild(typingEl)
    scrollBottom()
  } else {
    typingEl?.remove()
    typingEl = null
  }
}

function connectEvents() {
  const es = new EventSource('/api/events')
  es.onmessage = (e) => {
    let ev
    try { ev = JSON.parse(e.data) } catch { return }
    switch (ev.kind) {
      case 'update': handleUpdate(ev); break
      case 'busy': {
        const row = state.sessions.find(s => s.sessionId === ev.sessionId)
        if (row) row._busy = ev.busy
        const el = document.querySelector(`[data-sid="${CSS.escape(ev.sessionId)}"] .run`)
        if (el && row) el.hidden = !(ev.busy || row._meta?.['cognition.ai/isLocked'])
        break
      }
      case 'permission': if (ev.sessionId === state.active?.sessionId) renderPermission(ev); break
      case 'permission-done': state.stream.permEls.get(ev.requestId)?.remove(); state.stream.permEls.delete(ev.requestId); break
      case 'prompt-done': {
        if (ev.sessionId !== state.active?.sessionId) break
        setBusy(false)
        if (ev.error) addNote(`回合失败：${ev.error}`, 'error')
        else if (ev.stopReason && ev.stopReason !== 'end_turn') addNote(`回合结束：${ev.stopReason}`, 'warn')
        break
      }
      case 'agent-down': addNote(`devin acp 已退出：${ev.message} — 刷新后重试`, 'error'); break
      default: break
    }
  }
  es.onerror = () => {} // EventSource auto-reconnects
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

$('sendBtn').addEventListener('click', send)
$('stopBtn').addEventListener('click', () => {
  if (state.active) api('POST', '/api/cancel', { sessionId: state.active.sessionId }).catch(() => {})
})
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
})
$('newBtn').addEventListener('click', () => newSession())
$('reloadBtn').addEventListener('click', () => refreshSessions())
$('moreBtn').addEventListener('click', () => refreshSessions(true))
$('searchToggle').addEventListener('click', () => {
  const row = $('searchRow')
  row.hidden = !row.hidden
  if (!row.hidden) $('searchInput').focus()
  else { $('searchInput').value = ''; renderSessions() }
})
$('searchInput').addEventListener('input', renderSessions)
$('chatId').addEventListener('click', () => { if (state.active) copyText(state.active.sessionId) })
// Scroll-to-top streams in the previous page of turns automatically.
$('transcript').addEventListener('scroll', () => {
  if ($('transcript').scrollTop < 60 && state.earliestTurn > 0) loadEarlier()
})

;(async () => {
  connectEvents()
  try {
    const status = await api('GET', '/api/status')
    $('agentInfo').textContent = `${status.agentInfo.name ?? 'devin'} ${status.agentInfo.version ?? ''}`
    refreshSessions()
  } catch (err) {
    $('agentInfo').textContent = `devin acp 不可用：${err.message}`
    $('agentInfo').style.color = 'var(--red)'
  }
})()
