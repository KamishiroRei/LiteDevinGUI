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
  queueItems: [],       // only prompts awaiting another send; active turns use the session running state
  queueActionsReady: false, // old host stays readable until it can safely restart
  queueExpanded: new Set(), // queueIds with full text open
  queueFullText: new Map(), // fetched only for expanded queue items
  queueActionPending: new Set(),
  queueCollapsed: false,
  archiveRows: [],      // server-owned archived session metadata
  archiveReady: false,
  configOptions: [],     // select-type session config options (mode, model, …)
  pendingEchoes: [], // optimistic prompts awaiting ACP echoes; several can run on one session
  pendingSends: new Map(), // clientMessageId -> optimistic bubble and draft for precise failure feedback
  earliestTurn: 0,       // first rendered history turn index
  totalTurns: 0,
  loadingEarlier: false,
  attachments: [],        // legacy drafts may still contain attachment tokens
  imageRefs: [],          // current session's path-backed image mentions
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
const providerOf = (sessionId) => typeof sessionId === 'string' && sessionId.startsWith('cursor:') ? 'cursor' : 'devin'
const providerName = (provider) => provider === 'cursor' ? 'Cursor' : 'Devin'
function selectedDevinModelKind() {
  const option = state.configOptions.find(o => o?.id === 'model' || o?.category === 'model')
  const id = option?.currentValue
  const label = option?.options?.find(o => o.value === id)?.name ?? ''
  const text = `${id ?? ''} ${label}`.toLowerCase()
  if (/(^|[^a-z])swe(?:[-_\s\d]|$)/.test(text)) return 'swe'
  if (/(?:sonnet|opus)[^\n]{0,40}5[.\-_\s]?5(?:\b|$)/.test(text)) return 'other'
  return 'unknown'
}

const IMAGE_BOOKS_KEY = 'devin-lite:image-refs'
const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i
const IMAGE_TOKEN_RE = /@图片(\d+)/g
const imageBooks = new Map()
try {
  for (const [sessionId, rows] of JSON.parse(localStorage.getItem(IMAGE_BOOKS_KEY) ?? '[]')) {
    if (typeof sessionId !== 'string' || !Array.isArray(rows)) continue
    imageBooks.set(sessionId, rows.filter(r => r && typeof r.path === 'string' && /^图片\d+$/.test(r.label))
      .map(r => ({ path: r.path, label: r.label, committed: r.committed === true })))
  }
} catch { /* malformed old browser state does not block the UI */ }

function imageRefsFor(sessionId) {
  if (!imageBooks.has(sessionId)) imageBooks.set(sessionId, [])
  return imageBooks.get(sessionId)
}

function persistImageRefs() {
  try {
    localStorage.setItem(IMAGE_BOOKS_KEY, JSON.stringify([...imageBooks].map(([id, rows]) =>
      [id, rows.filter(r => r.path).map(({ path, label, committed }) => ({ path, label, committed: committed === true }))])))
  } catch { /* the current page still keeps the references */ }
}

function nextImageLabel(rows) {
  const used = new Set(rows.map(r => Number(r.label.slice(2))))
  let number = 1
  while (used.has(number)) number++
  return `图片${number}`
}

function registerImagePath(path, sessionId = state.active?.sessionId, committed = false) {
  if (!sessionId || typeof path !== 'string' || !IMAGE_PATH_RE.test(path)) return null
  const rows = imageRefsFor(sessionId)
  let ref = rows.find(r => r.path?.toLowerCase() === path.toLowerCase())
  if (!ref) {
    ref = { path, label: nextImageLabel(rows), committed }
    rows.push(ref)
    persistImageRefs()
  } else if (committed && !ref.committed) {
    ref.committed = true
    persistImageRefs()
  }
  if (state.active?.sessionId === sessionId) {
    state.imageRefs = rows
    renderChips()
  }
  return ref
}

function pruneUnusedDraftImages(sessionId, text) {
  if (!sessionId) return
  const used = new Set([...text.matchAll(IMAGE_TOKEN_RE)].map(m => `图片${m[1]}`))
  const rows = imageRefsFor(sessionId)
  let changed = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const ref = rows[i]
    if (ref.committed || ref.sentPending || used.has(ref.label)) continue
    ref.removed = true
    ref.controller?.abort()
    if (ref.objectUrl) URL.revokeObjectURL(ref.objectUrl)
    rows.splice(i, 1)
    changed = true
  }
  if (changed) persistImageRefs()
}

async function refreshSessionImages(sessionId, seq) {
  try {
    const res = await api('GET', `/api/session-images?sessionId=${encodeURIComponent(sessionId)}`)
    if (seq !== state.openSeq) return
    for (const image of res.images ?? []) registerImagePath(image.path, sessionId, true)
    // Render paths from history only after the image book is populated.
  } catch { /* older service versions may not offer image discovery */ }
}

function toast(text, cls = '') {
  const item = document.createElement('div')
  item.className = `toast ${cls}`
  item.textContent = text
  $('toastRegion').appendChild(item)
  setTimeout(() => item.remove(), cls === 'error' ? 9000 : 5000)
}

function showEmptyState() {
  $('transcript').innerHTML = '<div class="empty-state"><img src="favicon.svg" width="42" height="42" alt=""><h1>开始一个会话</h1><p>选择工作区，然后开始与 Devin 对话。</p><button class="primary empty-new" type="button">新建会话</button></div>'
}

function queueStatus(entry) {
  const until = entry.retryAt ? new Date(entry.retryAt).getTime() - Date.now() : 0
  return until > 0 ? `约 ${Math.ceil(until / 1000)} 秒后重试` : '等待并发空位'
}

function updateQueueTimes() {
  for (const el of $('queueList').querySelectorAll('[data-queue-status]')) {
    const entry = state.queueItems.find(item => item.queueId === el.dataset.queueStatus)
    if (entry) el.textContent = queueStatus(entry)
  }
}

function queueButton(label, action, disabled = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'queue-action'
  button.textContent = label
  button.disabled = disabled
  button.addEventListener('click', action)
  return button
}

function updateQueueBanner() {
  const panel = $('queueBanner')
  const items = state.queueItems
  panel.hidden = items.length === 0
  if (!items.length) return
  const current = items.filter(entry => entry.sessionId === state.active?.sessionId).length
  $('queueText').textContent = `待发送消息 ${items.length} 条${current ? ` · 当前会话 ${current} 条` : ''}${state.queueActionsReady ? '' : ' · 服务端待重启'}`
  $('queueText').title = state.queueActionsReady ? '' : '当前宿主仍在运行旧版接口；会话空闲并重启后可查看全文和手动重试'
  $('queueToggle').textContent = state.queueCollapsed ? '展开' : '收起'
  $('queueToggle').setAttribute('aria-expanded', String(!state.queueCollapsed))
  $('queueList').hidden = state.queueCollapsed
  if (state.queueCollapsed) return
  const list = $('queueList')
  list.replaceChildren()
  for (const entry of items) {
    const row = document.createElement('article')
    row.className = 'queue-item'
    const top = document.createElement('div')
    top.className = 'queue-item-top'
    const identity = document.createElement('span')
    identity.className = 'queue-identity'
    const session = state.sessions.find(s => s.sessionId === entry.sessionId)
      ?? state.archiveRows.find(s => s.sessionId === entry.sessionId)
    const source = entry.source === 'bridge' ? '协作消息' : entry.source === 'gui' ? '网页消息' : '待处理消息'
    identity.textContent = `${source} · ${session ? sessionTitle(session.sessionId, session.title) : entry.sessionId}`
    identity.title = entry.sessionId
    top.append(identity)
    const status = document.createElement('span')
    status.className = 'queue-status'
    status.dataset.queueStatus = entry.queueId
    status.textContent = queueStatus(entry)
    top.append(status)
    row.append(top)
    const content = document.createElement('div')
    content.className = 'queue-content'
    const full = state.queueFullText.get(entry.queueId)
    const expanded = state.queueExpanded.has(entry.queueId)
    content.textContent = expanded && full !== undefined ? full : entry.preview || (entry.imageCount ? `图片 ${entry.imageCount} 张` : '空消息')
    if (!expanded && (entry.textLength > (entry.preview?.length ?? 0)
      || !state.queueActionsReady && (entry.preview?.length ?? 0) >= 120)) content.textContent += '…'
    row.append(content)
    const meta = document.createElement('div')
    meta.className = 'queue-meta'
    const details = [entry.imageCount ? `图片 ${entry.imageCount} 张` : '',
      `第 ${entry.attempts || 0} 次尝试`, entry.lastError ?? ''].filter(Boolean)
    meta.textContent = details.join(' · ')
    if (details.length) row.append(meta)
    const actions = document.createElement('div')
    actions.className = 'queue-actions'
    if (state.queueActionsReady && entry.textLength > (entry.preview?.length ?? 0)) {
      actions.append(queueButton(expanded ? '收起全文' : '查看全文', async () => {
        if (expanded) state.queueExpanded.delete(entry.queueId)
        else {
          try {
            if (!state.queueFullText.has(entry.queueId)) {
              const data = await api('GET', `/api/queue/item?queueId=${encodeURIComponent(entry.queueId)}`)
              state.queueFullText.set(entry.queueId, data.text ?? '')
            }
            state.queueExpanded.add(entry.queueId)
          } catch (err) { toast(`读取消息失败：${err.message}`, 'error') }
        }
        updateQueueBanner()
      }))
    }
    if (session?.cwd) actions.append(queueButton('打开会话', () => openSession(session)))
    const pending = state.queueActionPending.has(entry.queueId)
    actions.append(queueButton('立即重试', () => queueAction(entry.queueId, 'send'), pending || !state.queueActionsReady))
    actions.append(queueButton('取消排队', () => queueAction(entry.queueId, 'drop'), pending))
    row.append(actions)
    list.append(row)
  }
}

async function queueAction(queueId, action) {
  if (state.queueActionPending.has(queueId)) return
  state.queueActionPending.add(queueId)
  updateQueueBanner()
  try {
    const path = action === 'send' ? '/api/queue/send' : '/api/queue/drop'
    const response = await api('POST', path, { queueId })
    if (action === 'drop' && response.removed !== 1) throw new Error('该消息已开始发送或已离开队列')
    toast(action === 'send' ? '已开始重试这条消息' : '已取消这条排队消息')
  } catch (err) { toast(`${action === 'send' ? '重试' : '取消'}失败：${err.message}`, 'error') }
  finally { state.queueActionPending.delete(queueId); await refreshQueue() }
}

let queueRefreshSeq = 0
async function refreshQueue() {
  const seq = ++queueRefreshSeq
  try {
    const data = await api('GET', '/api/queue')
    if (seq !== queueRefreshSeq) return
    state.queueActionsReady = data.features?.item === true && data.features?.send === true
    // Lite retains in-flight retry records until the ACP turn settles. They
    // have already left the waiting queue; the transcript and running badge
    // represent that turn, even when an older server includes them in pending.
    state.queueItems = Array.isArray(data.pending)
      ? data.pending.filter(entry => entry.state === 'queued') : []
    const ids = new Set(state.queueItems.map(e => e.queueId))
    for (const id of state.queueFullText.keys()) if (!ids.has(id)) { state.queueFullText.delete(id); state.queueExpanded.delete(id) }
    updateQueueBanner()
    renderSessions()
  } catch (err) { toast(`读取排队状态失败：${err.message}`, 'error') }
}

let capacitySeq = 0
async function refreshCapacity() {
  const seq = ++capacitySeq
  const badge = $('capacityBadge')
  try {
    const cap = await api('GET', '/api/capacity')
    if (seq !== capacitySeq) return
    if (!Number.isFinite(cap.active) || !Number.isFinite(cap.limit)) throw new Error(cap.error ?? '容量状态不可读')
    const available = Math.max(0, cap.limit - cap.active)
    badge.textContent = `${cap.active}/${cap.limit}`
    badge.classList.toggle('full', available === 0)
    $('newBtn').title = `SWE 运行中 ${cap.active}/${cap.limit}，剩余 ${available}；Sonnet 5.5、Opus 5.5 与 Cursor 不占用 SWE 名额`
    if ($('newSessionProvider').value === 'devin') $('workspaceCapacity').textContent = `当前 SWE 运行 ${cap.active}/${cap.limit} 条；其他 Devin 模型不受此上限约束`
  } catch (err) {
    if (seq !== capacitySeq) return
    badge.textContent = '?/5'
    badge.classList.remove('full')
    $('newBtn').title = `SWE 并发状态暂不可读：${err.message}`
    if ($('newSessionProvider').value === 'devin') $('workspaceCapacity').textContent = 'SWE 并发状态暂不可读；其他 Devin 模型仍可用'
  }
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

function imagePreviewUrl(ref) {
  return ref.objectUrl || (ref.path ? `/api/image-preview?path=${encodeURIComponent(ref.path)}` : '')
}

const cursorRequests = new Map()
let cursorDialog
function showCursorRequest() {
  if (cursorDialog || cursorRequests.size === 0) return
  const [requestId, ev] = cursorRequests.entries().next().value
  const dialog = document.createElement('dialog')
  cursorDialog = dialog
  dialog.dataset.requestId = requestId
  dialog.className = 'cursor-request-dialog'
  const heading = document.createElement('h2')
  heading.textContent = ev.method === 'cursor/create_plan' ? 'Cursor 请求批准方案' : 'Cursor 需要你的选择'
  dialog.appendChild(heading)
  const form = document.createElement('form')
  form.addEventListener('submit', e => e.preventDefault())
  dialog.appendChild(form)
  const params = ev.params ?? {}
  const questionFields = new Map()
  if (ev.method === 'cursor/create_plan') {
    const name = document.createElement('p')
    name.textContent = params.name ?? params.overview ?? '请查看以下方案。'
    const plan = document.createElement('pre')
    plan.textContent = params.plan ?? ''
    form.append(name, plan)
  } else {
    for (const q of params.questions ?? []) {
      const field = document.createElement('fieldset')
      questionFields.set(q.id, field)
      const legend = document.createElement('legend')
      legend.textContent = q.prompt ?? q.id
      field.appendChild(legend)
      for (const opt of q.options ?? []) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = q.allowMultiple ? 'checkbox' : 'radio'
        input.name = `question-${q.id}`
        input.value = opt.id
        label.append(input, document.createTextNode(` ${opt.label ?? opt.id}`))
        field.appendChild(label)
      }
      form.appendChild(field)
    }
  }
  const actions = document.createElement('div')
  actions.className = 'cursor-request-actions'
  const button = (label, outcome) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', async () => {
      let result
      if (outcome === 'answered') {
        const answers = (params.questions ?? []).map(q => ({
          questionId: q.id,
          selectedOptionIds: [...(questionFields.get(q.id)?.querySelectorAll('input:checked') ?? [])].map(x => x.value),
        }))
        if (answers.some(a => a.selectedOptionIds.length === 0)) { toast('请先回答每个问题，或选择跳过', 'warn'); return }
        result = { outcome: { outcome, answers } }
      } else result = { outcome: { outcome } }
      try {
        await api('POST', '/api/cursor/respond', { requestId, result })
        cursorRequests.delete(requestId)
        if (dialog.open) dialog.close()
      } catch (error) { toast(`无法回复 Cursor：${error.message}`, 'error') }
    })
    actions.appendChild(b)
  }
  if (ev.method === 'cursor/create_plan') {
    button('拒绝', 'rejected')
    button('接受方案', 'accepted')
  } else {
    button('跳过', 'skipped')
    button('提交选择', 'answered')
  }
  form.appendChild(actions)
  dialog.addEventListener('cancel', e => e.preventDefault())
  dialog.addEventListener('close', () => {
    dialog.remove()
    cursorDialog = undefined
    showCursorRequest()
  })
  document.body.appendChild(dialog)
  dialog.showModal()
}
function receiveCursorRequest(ev) {
  if (!ev?.requestId || cursorRequests.has(ev.requestId)) return
  cursorRequests.set(ev.requestId, ev)
  showCursorRequest()
}
async function refreshCursorRequests() {
  try {
    const pending = await api('GET', '/api/agent/pending')
    for (const ev of pending.cursor ?? []) receiveCursorRequest(ev)
  } catch { /* reconnect will retry */ }
}

function hideImagePreview() { $('imageHoverPreview').hidden = true }

function showImagePreview(ref, anchor) {
  const src = imagePreviewUrl(ref)
  if (!src) return
  const preview = $('imageHoverPreview')
  preview.replaceChildren()
  const img = document.createElement('img')
  img.src = src
  img.alt = ref.label
  const caption = document.createElement('div')
  caption.className = 'image-preview-caption'
  caption.textContent = ref.path ?? `${ref.label} · 正在保存到磁盘`
  preview.append(img, caption)
  preview.hidden = false
  const rect = anchor.getBoundingClientRect()
  const box = preview.getBoundingClientRect()
  preview.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
  preview.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - box.height - 8))}px`
}

function makeImageChip(ref, composer = false) {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = `image-ref-chip${composer ? ' composer-image-chip' : ''}${ref.pending ? ' pending' : ''}${ref.error ? ' error' : ''}`
  chip.setAttribute('aria-label', `${ref.label}，悬浮预览图片`)
  chip.title = ref.error ? `${ref.label} 保存失败：${ref.error}` : (ref.path ?? `${ref.label} 正在保存`)
  const img = document.createElement('img')
  img.src = imagePreviewUrl(ref)
  img.alt = ''
  const label = document.createElement('span')
  label.textContent = ref.label
  chip.append(img, label)
  chip.addEventListener('pointerenter', () => showImagePreview(ref, chip))
  chip.addEventListener('pointerleave', hideImagePreview)
  chip.addEventListener('focus', () => showImagePreview(ref, chip))
  chip.addEventListener('blur', hideImagePreview)
  chip.addEventListener('click', () => {
    if (ref.error && ref.blob) void uploadImageRef(ref)
    else showImagePreview(ref, chip)
  })
  return chip
}

function renderRefText(span, text) {
  // Only known image paths become chips. Other paths and surrounding prose
  // remain exact text, including a path immediately followed by Chinese.
  const refs = state.imageRefs.filter(r => r.path).sort((a, b) => b.path.length - a.path.length)
  const lower = text.toLowerCase()
  let cursor = 0
  while (cursor < text.length) {
    let found = null
    for (const ref of refs) {
      let at = lower.indexOf(ref.path.toLowerCase(), cursor)
      while (at >= 0 && /[\w.\\/]/.test(text[at + ref.path.length] ?? '')) {
        at = lower.indexOf(ref.path.toLowerCase(), at + 1)
      }
      if (at >= 0 && (!found || at < found.at || (at === found.at && ref.path.length > found.ref.path.length))) found = { at, ref }
    }
    if (!found) break
    if (found.at > cursor) span.appendChild(document.createTextNode(text.slice(cursor, found.at)))
    span.appendChild(makeImageChip(found.ref))
    cursor = found.at + found.ref.path.length
  }
  if (cursor < text.length) span.appendChild(document.createTextNode(text.slice(cursor)))
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
    for (const pending of state.pendingEchoes) {
      if (pending.sessionId !== ev.sessionId) continue
      const next = pending.buf + u.content.text
      if (!pending.text.startsWith(next)) continue
      pending.buf = next
      if (next === pending.text) state.pendingEchoes.splice(state.pendingEchoes.indexOf(pending), 1)
      return // devin echoed an optimistic prompt back
    }
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
  const scope = providerOf(s.sessionId) === 'cursor' ? '从 Lite 列表移除（Cursor 原始会话保留）' : '删除会话'
  if (!confirm(`${scope} ${s.title || s.sessionId}？`)) return
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
  if (providerOf(s.sessionId) === 'cursor') {
    const tag = document.createElement('span')
    tag.className = 'provider-tag'
    tag.textContent = 'Cursor'
    div.querySelector('.meta').prepend(tag)
  }
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
  const waiting = state.queueItems.filter(e => e.sessionId === s.sessionId).length
  if (waiting > 0) {
    const badge = document.createElement('span')
    badge.className = 'queued-count'
    badge.textContent = `${waiting} 条排队`
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
    head.querySelector('.gnew').addEventListener('click', (e) => { e.stopPropagation(); openNewSessionDialog(g.cwd || undefined) })
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
  state.imageRefs = imageRefsFor(session.sessionId)
  state.pendingEchoes = state.pendingEchoes.filter(pending => pending.sessionId !== session.sessionId)
  state.openSeq++
  hideMentionMenu()
  hideImagePreview()
  renderChips()
  $('transcript').innerHTML = ''
  typingEl = null
  $('chatTitle').textContent = sessionTitle(session.sessionId, session.title) || '(无标题)'
  $('chatId').textContent = session.sessionId
  $('composerFoot').textContent = `当前会话通过本机 ${providerName(providerOf(session.sessionId))} CLI 运行 · 结果请自行核对`
  void refreshAgentStatus(providerOf(session.sessionId))
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
  state.imageRefs = []
  state.attachments = []
  hideMentionMenu()
  hideImagePreview()
  renderChips()
  showEmptyState()
  $('chatTitle').textContent = '开始使用 Devin Lite'
  $('chatId').textContent = ''
  $('composerFoot').textContent = '当前会话通过本机 Devin CLI 运行 · 结果请自行核对'
  void refreshAgentStatus('devin')
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
    await refreshSessionImages(s.sessionId, seq)
    if (seq !== state.openSeq) return
    await renderHistoryTail()
  } catch (err) {
    if (seq !== state.openSeq) return
    const msg = /already open in another process/i.test(err.message)
      ? `该会话正被其他 ${providerName(providerOf(s.sessionId))} 实例占用。请先在原处关闭，再在这里打开。`
      : `加载失败：${err.message}`
    addNote(msg, 'error')
    $('input').disabled = true
    $('sendBtn').disabled = true
  }
}

let workspaceBrowseSeq = 0
let workspaceBrowserPath = ''
let workspaceBrowserParent
let workspaceCreating = false

function workspaceError(message = '') {
  $('workspaceError').textContent = message
  $('workspaceError').hidden = !message
}

function knownWorkspacePaths() {
  const seen = new Set()
  const paths = []
  for (const cwd of [state.active?.cwd, ...state.sessions.map(s => s.cwd), ...state.archiveRows.map(s => s.cwd)]) {
    if (typeof cwd !== 'string' || !cwd.trim()) continue
    const key = normalizePath(cwd)
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(cwd)
  }
  return paths
}

function renderKnownWorkspaces() {
  const host = $('knownWorkspaces')
  host.replaceChildren()
  const selected = normalizePath($('workspacePath').value.trim())
  const paths = knownWorkspacePaths()
  if (!paths.length) {
    const empty = document.createElement('p')
    empty.className = 'workspace-none'
    empty.textContent = '还没有已有工作区，可从下方选择磁盘目录或直接输入路径。'
    host.appendChild(empty)
    return
  }
  for (const path of paths) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'known-workspace' + (normalizePath(path) === selected ? ' selected' : '')
    button.title = path
    const name = document.createElement('strong')
    name.textContent = baseName(path)
    const detail = document.createElement('small')
    detail.textContent = path
    button.append(name, detail)
    button.addEventListener('click', () => {
      $('workspacePath').value = path
      workspaceError()
      renderKnownWorkspaces()
      void browseWorkspace(path)
    })
    host.appendChild(button)
  }
}

async function browseWorkspace(path = '', selectCurrent = false) {
  const seq = ++workspaceBrowseSeq
  const inputAtStart = $('workspacePath').value
  const host = $('workspaceEntries')
  host.textContent = '正在读取目录…'
  try {
    const data = await api('GET', `/api/browse?path=${encodeURIComponent(path)}`)
    if (seq !== workspaceBrowseSeq || !$('newSessionDialog').open) return
    workspaceBrowserPath = data.path ?? ''
    workspaceBrowserParent = data.parent
    if (selectCurrent && $('workspacePath').value === inputAtStart) {
      $('workspacePath').value = workspaceBrowserPath
      renderKnownWorkspaces()
    }
    $('workspaceCurrent').textContent = workspaceBrowserPath || '此电脑'
    $('workspaceUp').disabled = !workspaceBrowserPath
    host.replaceChildren()
    for (const entry of data.entries ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'workspace-entry'
      button.innerHTML = ICON.folder
      const label = document.createElement('span')
      label.textContent = entry.name
      button.appendChild(label)
      button.title = entry.path
      button.addEventListener('click', () => {
        $('workspacePath').value = entry.path
        workspaceError()
        renderKnownWorkspaces()
        void browseWorkspace(entry.path)
      })
      host.appendChild(button)
    }
    if (!host.childElementCount) host.textContent = '此目录下没有可选的子文件夹。'
    if (path && normalizePath(path) !== normalizePath(workspaceBrowserPath)) {
      workspaceError(`未找到或无法读取该目录，已定位到 ${workspaceBrowserPath || '磁盘列表'}。`)
    }
  } catch (err) {
    if (seq !== workspaceBrowseSeq || !$('newSessionDialog').open) return
    host.textContent = '目录读取失败。你仍可输入路径并尝试创建。'
    workspaceError(err.message)
  }
}

function updateNewSessionProvider() {
  const cursor = $('newSessionProvider').value === 'cursor'
  $('newSessionHint').textContent = cursor
    ? 'Cursor CLI 将在所选工作区创建独立会话。首次使用需先完成 Cursor 登录。'
    : 'Devin 将在所选工作区创建会话，继续使用当前的统一 ACP 入口。'
  $('workspaceCapacity').textContent = cursor ? 'Cursor 会话不占用 Devin SWE 的 5 条并发名额' : ''
  if (!cursor) void refreshCapacity()
}

function openNewSessionDialog(cwd) {
  const dialog = $('newSessionDialog')
  if (dialog.open) return
  workspaceError()
  $('newSessionCreate').disabled = false
  $('newSessionCreate').textContent = '创建会话'
  const initial = cwd || state.active?.cwd || knownWorkspacePaths()[0] || ''
  $('newSessionProvider').value = providerOf(state.active?.sessionId)
  updateNewSessionProvider()
  $('workspacePath').value = initial
  renderKnownWorkspaces()
  dialog.showModal()
  void refreshCapacity()
  void browseWorkspace(initial)
  $('workspacePath').focus()
}

function closeNewSessionDialog() {
  if (workspaceCreating) return
  ++workspaceBrowseSeq
  $('newSessionDialog').close()
}

async function createNewSession() {
  if (workspaceCreating) return
  const cwd = $('workspacePath').value.trim()
  if (!cwd) { workspaceError('请选择或输入工作区目录。'); $('workspacePath').focus(); return }
  workspaceCreating = true
  workspaceError()
  $('newSessionCreate').disabled = true
  $('newSessionCreate').textContent = '创建中…'
  try {
    const created = await api('POST', '/api/sessions/new', { cwd, provider: $('newSessionProvider').value })
    // The server validates the directory before creating the session.
    setActive({ sessionId: created.sessionId, cwd, title: '(新会话)' }, created.configOptions)
    if (created.persistenceWarning) toast(created.persistenceWarning, 'warn')
    ++workspaceBrowseSeq
    $('newSessionDialog').close()
    void refreshSessions()
  } catch (err) { workspaceError(`创建失败：${err.message}`) }
  finally {
    workspaceCreating = false
    $('newSessionCreate').disabled = false
    $('newSessionCreate').textContent = '创建会话'
  }
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
    const created = await api('POST', '/api/sessions/new', { cwd: s.cwd, provider: providerOf(s.sessionId) })
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
    const selectedOffered = opt.options.some(o => o.value === opt.currentValue)
    const placeholder = opt.id === 'model' || opt.category === 'model' ? '请选择允许的模型' : `请选择${opt.name ?? opt.id}`
    sel.innerHTML = `<option value="" disabled${selectedOffered ? '' : ' selected'}>${esc(selectedOffered ? (opt.name ?? opt.id) : placeholder)}</option>`
      + opt.options.map(o => `<option value="${esc(o.value)}"${o.value === opt.currentValue ? ' selected' : ''}>${esc(o.name ?? o.value)}</option>`).join('')
    sel.addEventListener('change', () => {
      if (!state.active) return
      api('POST', '/api/sessions/config', { sessionId: state.active.sessionId, configId: opt.id, value: sel.value, cwd: state.active.cwd })
        .then(() => { opt.currentValue = sel.value })
        .catch(err => addNote(`设置 ${opt.name ?? opt.id} 失败：${err.message}`, 'error'))
    })
    bar.appendChild(sel)
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
  const sessionId = state.active?.sessionId
  pruneUnusedDraftImages(sessionId, $('input').value)
  renderChips()
  updateMentionMenu()
  clearTimeout(draftSaveTimer)
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
  if (list.length > 0) insertAtCursor(list.map(p => pathAsComposerText(p, state.active?.sessionId)).join('\n'))
}

function pathAsComposerText(path, sessionId) {
  const ref = registerImagePath(path, sessionId)
  return ref ? `@${ref.label}` : path
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

function finishPathInsert(pending, paths, error, replacementOverride) {
  if (!pending) return
  const replacement = replacementOverride ?? (paths ?? []).filter(p => typeof p === 'string' && p !== '')
    .map(p => pathAsComposerText(p, pending.sessionId)).join('\n')
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

function replaceSessionToken(sessionId, oldToken, newToken) {
  const pattern = new RegExp(`${oldToken}(?!\\d)`, 'g')
  if (state.active?.sessionId === sessionId) {
    const ta = $('input')
    const start = ta.value.slice(0, ta.selectionStart).replace(pattern, newToken).length
    const end = ta.value.slice(0, ta.selectionEnd).replace(pattern, newToken).length
    ta.value = ta.value.replace(pattern, newToken)
    ta.selectionStart = start; ta.selectionEnd = end
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    const draft = drafts.get(sessionId)
    if (draft) { draft.text = draft.text.replace(pattern, newToken); persistDrafts() }
  }
}

function beginImageRef(blob, pending) {
  if (!pending) return null
  const rows = imageRefsFor(pending.sessionId)
  const ref = { label: nextImageLabel(rows), blob, objectUrl: URL.createObjectURL(blob), pending: true, sessionId: pending.sessionId }
  rows.push(ref)
  finishPathInsert(pending, [], undefined, `@${ref.label}`)
  if (state.active?.sessionId === pending.sessionId) renderChips()
  return ref
}

function completeImageRef(ref, path, keepLocalPreview = false) {
  if (ref.removed) return
  const rows = imageRefsFor(ref.sessionId)
  const existing = rows.find(r => r !== ref && r.path?.toLowerCase() === path.toLowerCase())
  if (existing) {
    replaceSessionToken(ref.sessionId, `@${ref.label}`, `@${existing.label}`)
    rows.splice(rows.indexOf(ref), 1)
  } else {
    ref.path = path
    ref.pending = false
    ref.error = undefined
    ref.blob = undefined
  }
  if (existing || !keepLocalPreview) {
    if (ref.objectUrl) URL.revokeObjectURL(ref.objectUrl)
    ref.objectUrl = undefined
  }
  persistImageRefs()
  if (state.active?.sessionId === ref.sessionId) renderChips()
}

async function uploadImageRef(ref) {
  if (!ref?.blob || ref.removed || (ref.pending && ref.uploading)) return
  ref.pending = true
  ref.uploading = true
  ref.controller = new AbortController()
  ref.error = undefined
  if (state.active?.sessionId === ref.sessionId) renderChips()
  try {
    const response = await fetch('/api/attach', {
      method: 'POST', headers: { 'Content-Type': ref.blob.type || 'image/png' }, body: ref.blob,
      signal: ref.controller.signal,
    })
    let result = await response.json().catch(() => ({}))
    let legacyService = false
    if (!response.ok && /invalid JSON body/i.test(result.error ?? '')) {
      // A browser may have refreshed before its long-lived local server was
      // restarted. Keep this one compatibility attempt for that old process.
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
        reader.readAsDataURL(ref.blob)
      })
      result = await api('POST', '/api/attach', { dataUrl })
      legacyService = true
    } else if (!response.ok) throw new Error(result.error ?? `${response.status}`)
    if (typeof result.path !== 'string' || !result.path) throw new Error('未返回磁盘路径')
    completeImageRef(ref, result.path, legacyService)
  } catch (err) {
    if (ref.removed || err.name === 'AbortError') return
    ref.pending = false
    ref.error = err.message
    toast(`图片保存失败：${err.message}（点击图片可重试）`, 'error')
    if (state.active?.sessionId === ref.sessionId) renderChips()
  } finally {
    ref.uploading = false
    ref.controller = undefined
  }
}

async function stageImageDataUrl(dataUrl, pending) {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const ref = beginImageRef(blob, pending)
    if (ref) await uploadImageRef(ref)
  } catch (err) { finishPathInsert(pending, [], `图片读取失败：${err.message}`) }
}

async function stageImageFile(file, pending) {
  const ref = beginImageRef(file, pending)
  if (ref) await uploadImageRef(ref)
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

let lastChipsSignature = ''
function renderChips() {
  const labels = new Set([...$('input').value.matchAll(IMAGE_TOKEN_RE)].map(m => `图片${m[1]}`))
  const visibleRefs = [...labels].map(label => state.imageRefs.find(ref => ref.label === label)).filter(Boolean)
  const signature = JSON.stringify([
    state.active?.sessionId,
    state.attachments.map(a => [a.name, a.path, a.kind]),
    visibleRefs.map(r => [r.label, r.path, r.objectUrl, r.pending, r.error]),
  ])
  if (signature === lastChipsSignature) return
  lastChipsSignature = signature
  const row = $('attachChips')
  row.innerHTML = ''
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
  for (const ref of visibleRefs) {
    const wrap = document.createElement('span')
    wrap.className = 'image-chip-wrap'
    wrap.appendChild(makeImageChip(ref, true))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'image-chip-remove'
    remove.textContent = '×'
    remove.title = `移除 ${ref.label} 引用`
    remove.addEventListener('click', () => {
      replaceSessionToken(state.active.sessionId, `@${ref.label}`, '')
      renderChips()
      $('input').focus()
    })
    wrap.appendChild(remove)
    row.appendChild(wrap)
  }
  row.hidden = row.childElementCount === 0
}

let mentionContext = null
function hideMentionMenu() {
  mentionContext = null
  $('imageMentionMenu').hidden = true
}

function updateMentionMenu() {
  const ta = $('input')
  if (!state.active || ta.selectionStart !== ta.selectionEnd) { hideMentionMenu(); return }
  const before = ta.value.slice(0, ta.selectionStart)
  const match = /@([^\s@]{0,32})$/.exec(before)
  if (!match || /^图片\d+$/.test(match[1])) { hideMentionMenu(); return }
  const query = match[1].toLowerCase()
  const refs = state.imageRefs.filter(ref => {
    const name = ref.path?.split(/[\\/]/).pop() ?? ''
    return ref.path && (!query || ref.label.includes(query) || name.toLowerCase().includes(query))
  })
  if (!refs.length) { hideMentionMenu(); return }
  const menu = $('imageMentionMenu')
  menu.replaceChildren()
  const start = ta.selectionStart - match[0].length
  mentionContext = { sessionId: state.active.sessionId, start, end: ta.selectionStart, refs, index: 0 }
  for (const [index, ref] of refs.entries()) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `image-mention-item${index === 0 ? ' active' : ''}`
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
    const img = document.createElement('img')
    img.src = imagePreviewUrl(ref)
    img.alt = ''
    const label = document.createElement('span')
    label.className = 'image-mention-label'
    const strong = document.createElement('strong')
    strong.textContent = ref.label
    const small = document.createElement('small')
    small.textContent = ref.path.split(/[\\/]/).pop()
    label.append(strong, small)
    item.append(img, label)
    item.addEventListener('pointerenter', () => showImagePreview(ref, item))
    item.addEventListener('pointerleave', hideImagePreview)
    item.addEventListener('mousedown', e => e.preventDefault())
    item.addEventListener('click', () => selectMention(index))
    menu.appendChild(item)
  }
  menu.hidden = false
}

function moveMention(delta) {
  if (!mentionContext) return
  mentionContext.index = (mentionContext.index + delta + mentionContext.refs.length) % mentionContext.refs.length
  $('imageMentionMenu').querySelectorAll('.image-mention-item').forEach((item, i) => {
    const active = i === mentionContext.index
    item.classList.toggle('active', active)
    item.setAttribute('aria-selected', String(active))
    if (active) item.scrollIntoView({ block: 'nearest' })
  })
}

function selectMention(index = mentionContext?.index) {
  const context = mentionContext
  if (!context || state.active?.sessionId !== context.sessionId) return
  const ref = context.refs[index]
  if (!ref) return
  const ta = $('input')
  const before = ta.value[context.start - 1] ?? ''
  const after = ta.value[context.end] ?? ''
  const token = `${before && !/\s/.test(before) ? ' ' : ''}@${ref.label}${after && /\s/.test(after) ? '' : ' '}`
  ta.setRangeText(token, context.start, context.end, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  hideMentionMenu()
  ta.focus()
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
  if (files.length === 0 && !html && /^(?:[A-Za-z]:[\\/]|\\\\).+\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(plain.trim())) {
    e.preventDefault()
    insertPaths([plain.trim()])
    return
  }
  if (files.length === 0 && (plain || html)) return // ordinary clipboard content, including a typed path
  e.preventDefault()
  const pending = beginPathInsert()
  if (!pending) return
  const imageRef = files.length === 1 && /^image\/(?:png|jpeg|gif|webp|bmp|avif)$/.test(files[0].type)
    ? beginImageRef(files[0], pending) : null
  // Explorer file objects have their real path in CF_HDROP, even when the
  // browser only exposes a nameless File. This works for any file extension.
  try {
    const res = await api('POST', '/api/clipboard-files')
    if (res.paths?.length && clipboardPathsMatchFiles(res.paths, files)) {
      if (imageRef && res.paths.length === 1) completeImageRef(imageRef, res.paths[0])
      else finishPathInsert(pending, res.paths)
      return
    }
  } catch { /* image clipboard can still be staged below */ }
  if (imageRef) {
    await uploadImageRef(imageRef)
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
  if ($('input').value.includes('⟦正在读取文件路径 ')) {
    toast('正在读取文件路径，请稍候', 'warn')
    return
  }
  if (!state.active) return
  const sessionId = state.active.sessionId
  const wasBusy = state.busySessions.has(sessionId)
  const cwd = state.active.cwd
  const rawText = $('input').value.trim()
  const atts = [...state.attachments]
  // The live page may still be connected to an older server until its active
  // turns finish. Keep that page from starting a sixth turn in the meantime.
  if (providerOf(sessionId) === 'devin' && selectedDevinModelKind() === 'unknown') {
    toast('请先在模型栏选择 SWE、Sonnet 5.5 或 Opus 5.5', 'warn')
    return
  }
  if (providerOf(sessionId) === 'devin' && selectedDevinModelKind() === 'swe' && !wasBusy && (rawText || atts.length)) {
    try {
      const cap = await api('GET', '/api/capacity')
      if (!Number.isInteger(cap.active) || cap.active < 0) throw new Error('并发状态不可读')
      if (cap.active >= 5) { toast('SWE 已运行 5/5 条，请等待空位后发送或改用 Sonnet 5.5、Opus 5.5', 'warn'); return }
    } catch (err) { toast(`无法确认 SWE 并发状态：${err.message}`, 'error'); return }
    if (state.active?.sessionId !== sessionId || $('input').value.trim() !== rawText) return
  }
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
  let missingImage = ''
  text = text.replace(IMAGE_TOKEN_RE, (token, number, offset, source) => {
    const ref = state.imageRefs.find(r => r.label === `图片${number}`)
    if (!ref?.path) { missingImage = ref?.pending ? `${ref.label} 正在保存` : `${ref?.label ?? token} 没有可用的磁盘路径`; return token }
    const before = source[offset - 1] ?? ''
    const after = source[offset + token.length] ?? ''
    return `${before && !/\s/.test(before) ? ' ' : ''}${ref.path}${after && !/\s/.test(after) ? ' ' : ''}`
  })
  if (missingImage) { toast(`${missingImage}，请等待或重新粘贴`, 'warn'); return }
  const unused = atts.filter(a => a.path && !rawText.includes(`{{${a.name}}}`)).map(a => a.path)
  if (unused.length > 0) text = [text, `附加文件：\n${unused.join('\n')}`].filter(Boolean).join('\n\n')
  if (!text) return
  const sentRefs = [...new Set([...rawText.matchAll(IMAGE_TOKEN_RE)].map(m => `图片${m[1]}`))]
    .map(label => imageRefsFor(sessionId).find(ref => ref.label === label)).filter(Boolean)
  for (const ref of sentRefs) ref.sentPending = true
  const clientMessageId = globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
  $('input').value = ''
  hideMentionMenu()
  state.attachments = []
  drafts.delete(sessionId)
  persistDrafts()
  renderChips()
  state.pendingEchoes.push({ id: clientMessageId, sessionId, text, buf: '' })
  // Optimistic user bubble, visually separated from the previous turn. Only
  // The optimistic echo shows exactly the text and paths sent to Devin.
  if ($('transcript').childElementCount > 0) turnSep($('transcript'), undefined, state.stream)
  else closeRun(state.stream, 'sep')
  renderUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, state.stream, $('transcript'))
  state.pendingSends.set(clientMessageId, {
    sessionId, text: rawText, atts, expanded: text, bubble: state.stream.userEl?.parentElement,
  })
  scrollBottom()
  state.busySessions.add(sessionId)
  setBusy(true)
  try {
    const res = await api('POST', '/api/prompt', { sessionId, cwd, text, clientMessageId })
    for (const ref of sentRefs) { ref.sentPending = false; ref.committed = true }
    if (sentRefs.length) persistImageRefs()
    // Queued behind the shared concurrency budget: not running, not failed —
    // the bubble stays and the prompt-dispatch event announces the retry.
    if (res?.deferred) {
      if (!wasBusy) {
        state.busySessions.delete(sessionId)
        if (state.active?.sessionId === sessionId) setBusy(false)
      }
      void refreshQueue()
    }
  } catch (err) {
    state.pendingEchoes = state.pendingEchoes.filter(pending => pending.id !== clientMessageId)
    for (const ref of sentRefs) ref.sentPending = false
    if (!wasBusy) {
      state.busySessions.delete(sessionId)
      if (state.active?.sessionId === sessionId) setBusy(false)
    }
    toast(`发送失败：${err.message}`, 'error')
    // Restore this exact failed message without replacing text typed while
    // its request was in flight; other concurrent bubbles stay untouched.
    const current = state.active?.sessionId === sessionId ? $('input').value : drafts.get(sessionId)?.text ?? ''
    const restored = [rawText, current].filter(Boolean).join('\n\n')
    if (state.active?.sessionId === sessionId) {
      $('input').value = restored
      state.attachments = [...atts, ...state.attachments]
      renderChips()
    }
    drafts.set(sessionId, { text: restored, attachments: atts })
    persistDrafts()
    const pendingSend = state.pendingSends.get(clientMessageId)
    if (pendingSend) pendingSend.restored = true
    if (state.active?.sessionId === sessionId) markUserFailed(clientMessageId)
  }
}

/**
 * Flag the latest user bubble of a failed turn and offer 撤回 — restores the
 * draft (text + attachments) and removes the bubble. If devin already
 * committed the message this is view-level only; it reappears on reload.
 */
function markUserFailed(clientMessageId) {
  const pending = clientMessageId ? state.pendingSends.get(clientMessageId)
    : [...state.pendingSends.values()].reverse().find(entry => entry.sessionId === state.active?.sessionId && !entry.failed)
  if (clientMessageId && (!pending || pending.sessionId !== state.active?.sessionId || !pending.bubble?.isConnected)) return
  const bubbles = $('transcript').querySelectorAll('.msg.user')
  const ue = pending?.bubble?.isConnected ? pending.bubble : bubbles[bubbles.length - 1]
  if (!ue || ue.querySelector('.undo-btn')) return
  if (pending) pending.failed = true
  ue.classList.add('failed')
  const btn = document.createElement('button')
  btn.className = 'undo-btn'
  btn.textContent = '↩ 撤回'
  btn.title = '恢复到输入框重新发送（如 devin 已提交该消息，撤回仅移除本地显示）'
  btn.addEventListener('click', () => {
    if (pending && !pending.restored) {
      $('input').value = [pending.text, $('input').value].filter(Boolean).join('\n\n')
      state.attachments = [...pending.atts, ...state.attachments]
      renderChips()
      $('input').focus()
      saveDraft(pending.sessionId)
    }
    if (clientMessageId) state.pendingSends.delete(clientMessageId)
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
  $('sendBtn').disabled = !state.active
  if (on) {
    if (!typingEl?.isConnected) { // send() and the busy SSE both call setBusy(true)
      typingEl = document.createElement('div')
      typingEl.className = 'typing'
      typingEl.innerHTML = '<i></i><i></i><i></i><span>devin 正在处理</span>'
      $('transcript').appendChild(typingEl)
    }
    else if ($('transcript').lastElementChild !== typingEl) $('transcript').appendChild(typingEl)
    scrollBottom()
  } else {
    typingEl?.remove()
    typingEl = null
  }
}

function showAgentOnline(info, provider = providerOf(state.active?.sessionId)) {
  if (provider !== providerOf(state.active?.sessionId)) return
  $('agentInfo').textContent = `${info?.name ?? providerName(provider)} ${info?.version ?? ''}`.trim()
  $('agentInfo').style.color = ''
  $('connectionDot').className = 'connection-dot online'
  $('restartAgentBtn').title = `重启 ${providerName(provider)}（运行中的回合不可重启）`
}

function showAgentOffline(message, provider = providerOf(state.active?.sessionId)) {
  if (provider !== providerOf(state.active?.sessionId)) return
  $('agentInfo').textContent = message ? `${providerName(provider)} 不可用：${message}` : `${providerName(provider)} 未连接`
  $('agentInfo').style.color = 'var(--red)'
  $('connectionDot').className = 'connection-dot offline'
  $('restartAgentBtn').title = `启动 ${providerName(provider)}`
}

async function refreshAgentStatus(provider = providerOf(state.active?.sessionId)) {
  try {
    const status = await api('GET', `/api/status?provider=${provider}`)
    showAgentOnline(status.agentInfo, provider)
  } catch (error) { showAgentOffline(error.message, provider) }
}

async function restartAgent() {
  const button = $('restartAgentBtn')
  const provider = providerOf(state.active?.sessionId)
  button.disabled = true
  try {
    const status = await api('POST', '/api/agent/restart', { provider })
    showAgentOnline(status.agentInfo, provider)
    await Promise.all([refreshSessions(), refreshQueue(), refreshCapacity()])
    if (state.active && providerOf(state.active.sessionId) === provider) {
      const current = { ...state.active }
      saveDraft(current.sessionId)
      state.active = undefined
      await openSession(current)
    }
    toast(`${providerName(provider)} 已连接`)
  } catch (error) {
    if (!error.message.includes('正在处理回合')) showAgentOffline(error.message, provider)
    toast(`无法重启 ${providerName(provider)}：${error.message}`, 'error')
  } finally {
    button.disabled = false
  }
}

function connectEvents() {
  const es = new EventSource('/api/events')
  // SSE means the Lite host is reachable; only ACP initialization proves
  // that Devin itself is connected. Reconnect also revives a missing child.
  es.onopen = () => {
    void refreshAgentStatus()
    void refreshQueue() // a restarted host may now provide queue detail/actions
    void refreshCursorRequests()
  }
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
        void refreshCapacity()
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
      case 'cursor-request': receiveCursorRequest(ev); break
      case 'cursor-request-done':
        cursorRequests.delete(ev.requestId)
        if (cursorDialog?.dataset.requestId === ev.requestId) cursorDialog.close()
        break
      case 'prompt-deferred': {
        const row = state.sessions.find(s => s.sessionId === ev.sessionId)
        if (row) row._busy = state.busySessions.has(ev.sessionId)
        if (ev.sessionId === state.active?.sessionId) setBusy(state.busySessions.has(ev.sessionId))
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
        void refreshQueue()
        state.pendingEchoes = state.pendingEchoes.filter(pending => ev.clientMessageId
          ? pending.id !== ev.clientMessageId : pending.sessionId !== ev.sessionId)
        if (!ev.error && ev.clientMessageId) state.pendingSends.delete(ev.clientMessageId)
        if (ev.sessionId !== state.active?.sessionId) break
        void refreshSessionImages(ev.sessionId, state.openSeq)
        setBusy(state.busySessions.has(ev.sessionId))
        if (ev.error) { addNote(`回合失败：${ev.error}`, 'error'); markUserFailed(ev.clientMessageId) }
        else if (ev.stopReason && ev.stopReason !== 'end_turn') addNote(`回合结束：${ev.stopReason}`, 'warn')
        break
      }
      case 'agent-down':
        showAgentOffline(ev.message, ev.provider ?? 'devin')
        if ((ev.provider ?? 'devin') === providerOf(state.active?.sessionId))
          toast(`${providerName(ev.provider)} CLI 已退出：${ev.message}。可点左下角重启按钮恢复。`, 'error')
        break
      case 'agent-ready': showAgentOnline(ev.agentInfo, ev.provider ?? 'devin'); break
      case 'queue': void refreshQueue(); break
      default: break
    }
  }
  es.onerror = () => { showAgentOffline('Lite 服务连接中断') } // EventSource auto-reconnects

  // Busy/lock state lives on other processes too — refresh the list snapshot
  // periodically so running indicators and relative times stay truthful.
  setInterval(() => { refreshSessions(false, true).catch(() => {}) }, 20_000)
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

$('sendBtn').addEventListener('click', send)
$('queueToggle').addEventListener('click', () => {
  state.queueCollapsed = !state.queueCollapsed
  updateQueueBanner()
})
setInterval(() => { if (state.queueItems.length) updateQueueTimes() }, 1000)
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
  if (!state.active) return
  $('input').value = '/compact'
  send()
})
$('stopBtn').addEventListener('click', () => {
  if (state.active) api('POST', '/api/cancel', { sessionId: state.active.sessionId }).catch(() => {})
})
$('input').addEventListener('keydown', (e) => {
  if (mentionContext && !$('imageMentionMenu').hidden && !e.isComposing) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(); return }
    if (e.key === 'Escape') { e.preventDefault(); hideMentionMenu(); return }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
})
$('input').addEventListener('click', updateMentionMenu)
$('input').addEventListener('keyup', e => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') updateMentionMenu() })
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#composer')) { hideMentionMenu(); hideImagePreview() }
})
$('newBtn').addEventListener('click', () => openNewSessionDialog())
$('newBtn').addEventListener('pointerenter', () => { void refreshCapacity() })
$('transcript').addEventListener('click', e => { if (e.target.closest('.empty-new')) openNewSessionDialog() })
$('newSessionClose').addEventListener('click', closeNewSessionDialog)
$('newSessionCancel').addEventListener('click', closeNewSessionDialog)
$('newSessionDialog').addEventListener('cancel', e => { if (workspaceCreating) e.preventDefault(); else ++workspaceBrowseSeq })
$('newSessionDialog').addEventListener('click', e => { if (e.target === $('newSessionDialog')) closeNewSessionDialog() })
$('workspacePath').addEventListener('input', () => { workspaceError(); renderKnownWorkspaces() })
$('workspacePath').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void browseWorkspace($('workspacePath').value.trim(), true) } })
$('workspaceLocate').addEventListener('click', () => { void browseWorkspace($('workspacePath').value.trim(), true) })
$('workspaceUp').addEventListener('click', () => { void browseWorkspace(workspaceBrowserParent ?? '', true) })
$('newSessionCreate').addEventListener('click', () => { void createNewSession() })
$('newSessionProvider').addEventListener('change', updateNewSessionProvider)
$('reloadBtn').addEventListener('click', () => { void Promise.all([refreshSessions(), refreshArchives()]) })
$('restartAgentBtn').addEventListener('click', () => { void restartAgent() })
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
    showAgentOnline(status.agentInfo, 'devin')
    await Promise.all([refreshSessions(), refreshQueue(), refreshCapacity()])
    void refreshArchives()
    try {
      const saved = JSON.parse(localStorage.getItem('devin-lite:active') ?? 'null')
      if (saved && typeof saved.sessionId === 'string' && typeof saved.cwd === 'string') {
        const current = state.sessions.find(s => s.sessionId === saved.sessionId) ?? saved
        await openSession(current)
      }
    } catch { localStorage.removeItem('devin-lite:active') }
  } catch (err) {
    void Promise.all([refreshSessions(), refreshArchives(), refreshQueue(), refreshCapacity()])
    showAgentOffline(err.message)
  }
})()
