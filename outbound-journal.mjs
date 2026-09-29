import { appendFileSync, readFileSync } from 'node:fs'

/** Display-only record of prompts Lite attempted to hand to ACP. */
export class OutboundJournal {
  constructor(file) {
    this.file = file
    this.rows = new Map()
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.kind === 'message' && typeof event.id === 'string' && typeof event.sessionId === 'string') {
            this.rows.set(event.id, event)
          } else if (event.kind === 'status' && this.rows.has(event.id)) {
            Object.assign(this.rows.get(event.id), { status: event.status, error: event.error, changedAt: event.at })
          }
        } catch { /* a partial final line must not hide earlier messages */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    // A request in flight when the host died cannot be called delivered or failed.
    for (const row of this.rows.values()) if (['sending', 'cancel_requested'].includes(row.status)) row.status = 'unknown'
  }

  append(event) { appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8') }

  record(row) {
    const existing = this.rows.get(row.id)
    if (existing) {
      if (existing.sessionId !== row.sessionId || existing.text !== row.text) throw new Error('outbound message ID collision')
      return existing
    }
    const value = { kind: 'message', ...row, createdAt: new Date().toISOString() }
    this.append(value)
    this.rows.set(value.id, value)
    return value
  }

  setStatus(id, status, error) {
    const row = this.rows.get(id)
    if (!row || (row.status === status && row.error === error)) return row
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return row
    const at = new Date().toISOString()
    this.append({ kind: 'status', id, status, error, at })
    Object.assign(row, { status, error, changedAt: at })
    return row
  }

  forSession(sessionId) {
    return [...this.rows.values()].filter(row => row.sessionId === sessionId)
  }

  /**
   * ACP session/load should replay user messages. Annotate matching echoes;
   * if an agent omits one, restore only its visible row at its recorded index.
   * This never sends a prompt to ACP.
   */
  mergeReplay(sessionId, replay) {
    const updates = [...replay]
    const used = new Set()
    for (const row of this.forSession(sessionId)) {
      let match = -1
      for (let i = 0; i < updates.length; i++) {
        if (used.has(i) || updates[i].lite || updates[i].sessionUpdate !== 'user_message_chunk') continue
        let text = ''
        for (let j = i; j < updates.length && updates[j].sessionUpdate === 'user_message_chunk'; j++) {
          if (updates[j].content?.type !== 'text' || used.has(j)) break
          text += updates[j].content.text ?? ''
          if (text === row.text) { match = i; for (let k = i; k <= j; k++) used.add(k); break }
          if (!row.text.startsWith(text)) break
        }
        if (match >= 0) break
      }
      const lite = { id: row.id, source: row.source, status: row.status, error: row.error,
        createdAt: row.createdAt, changedAt: row.changedAt }
      if (match >= 0) {
        updates[match] = { ...updates[match], lite }
      } else {
        const at = Math.max(0, Math.min(Number(row.historyIndex) || 0, updates.length))
        updates.splice(at, 0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: row.text }, lite })
        const shifted = [...used].map(index => index >= at ? index + 1 : index)
        used.clear()
        for (const index of shifted) used.add(index)
        used.add(at)
      }
    }
    return updates
  }
}
