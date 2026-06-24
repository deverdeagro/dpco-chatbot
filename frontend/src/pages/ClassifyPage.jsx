import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

const TERMINAL = ['done', 'failed']

const LABELS = {
  scheduled:       { text: 'Scheduled',     color: '#15803d', bg: '#dcfce7' },
  'non scheduled': { text: 'Non-Scheduled', color: '#b45309', bg: '#fef3c7' },
  'new drug':      { text: 'New Drug',      color: '#1d4ed8', bg: '#dbeafe' },
}

function Badge({ label }) {
  const s = LABELS[label] || { text: label, color: '#475569', bg: '#e2e8f0' }
  return (
    <span style={{
      color: s.color, background: s.bg, padding: '2px 10px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{s.text}</span>
  )
}

export default function ClassifyPage() {
  const { apiFetch } = useAuth()
  const [job, setJob] = useState(null)
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [filter, setFilter] = useState('all')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [history, setHistory] = useState([])
  const pollRef = useRef(null)
  const chatBottomRef = useRef(null)

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const loadHistory = useCallback(async () => {
    const res = await apiFetch('/api/v1/reports/')
    if (res.ok) setHistory(await res.json())
  }, [apiFetch])

  // Refresh the history list whenever we're on the upload screen.
  useEffect(() => { if (!job) loadHistory() }, [job, loadHistory])

  const openReport = async (id) => {
    const res = await apiFetch(`/api/v1/reports/${id}/`)
    if (res.ok) { setJob(await res.json()); setMessages([]); setFilter('all') }
  }

  const pollJob = useCallback(async (id) => {
    const res = await apiFetch(`/api/v1/reports/${id}/`)
    if (res.ok) setJob(await res.json())
  }, [apiFetch])

  useEffect(() => {
    if (!job?.id || TERMINAL.includes(job.status)) { clearInterval(pollRef.current); return }
    pollRef.current = setInterval(() => pollJob(job.id), 2000)
    return () => clearInterval(pollRef.current)
  }, [job?.id, job?.status, pollJob])

  const acceptFile = (f) => { if (f && f.name.endsWith('.xlsx')) setFile(f) }
  const handleDrop = (e) => { e.preventDefault(); setDragging(false); acceptFile(e.dataTransfer.files[0]) }

  const start = async () => {
    if (!file || starting) return
    setStarting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await apiFetch('/api/v1/reports/', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      setJob(data)
    } catch (err) { alert(err.message) } finally { setStarting(false) }
  }

  const reset = () => { setJob(null); setFile(null); setMessages([]); setFilter('all') }

  const download = async () => {
    if (!job?.download_url) return
    const res = await apiFetch(job.download_url)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (job.original_name || 'report').replace(/\.xlsx$/, '') + '-classified.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }

  const sendChat = async () => {
    const q = input.trim()
    if (!q || chatLoading) return
    setMessages((p) => [...p, { role: 'user', content: q }])
    setInput('')
    setChatLoading(true)
    try {
      const res = await apiFetch(`/api/v1/reports/${job.id}/chat/`, {
        method: 'POST', body: JSON.stringify({ question: q }),
      })
      const data = await res.json()
      setMessages((p) => [...p, { role: 'assistant', content: data.answer || '', error: data.error || null }])
    } catch {
      setMessages((p) => [...p, { role: 'assistant', content: '', error: 'Network error.' }])
    } finally { setChatLoading(false) }
  }

  const counts = job?.summary?.counts || {}
  const rows = job?.rows || []
  const shown = filter === 'all' ? rows : rows.filter((r) => r.classification === filter)
  const pct = job?.total ? Math.round((job.processed / job.total) * 100) : 0

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h2>Classify Report</h2>
          <p className="page-subtitle">Drop a price sheet — classify each product as Scheduled, Non-Scheduled, or New Drug against NLEM</p>
        </div>
        {job && <button className="btn-secondary" onClick={reset}>New Report</button>}
      </div>

      {/* Upload */}
      {!job && (
        <div className="formv-upload">
          <div
            className={`drop-zone ${dragging ? 'drop-zone-active' : ''} ${file ? 'drop-zone-ready' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById('report-file-input').click()}
          >
            <input id="report-file-input" type="file" accept=".xlsx"
              onChange={(e) => acceptFile(e.target.files[0])} style={{ display: 'none' }} />
            {file ? (
              <>
                <span className="drop-zone-icon">📊</span>
                <p className="drop-zone-filename">{file.name}</p>
                <p className="drop-zone-hint">Click to change file</p>
              </>
            ) : (
              <>
                <span className="drop-zone-icon">📂</span>
                <p className="drop-zone-label">Drop your report here</p>
                <p className="drop-zone-hint">or click to browse · .xlsx only</p>
              </>
            )}
          </div>
          {file && (
            <button className="btn-primary formv-start-btn" onClick={start} disabled={starting}>
              {starting ? <span className="spinner" /> : 'Classify'}
            </button>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <h3 style={{ marginBottom: 12 }}>Recent reports</h3>
              <div className="table-wrapper">
                <table className="users-table">
                  <thead>
                    <tr><th>Report</th><th>When</th><th>Status</th><th>Breakdown</th><th></th></tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td style={{ fontWeight: 600 }}>{h.original_name}</td>
                        <td style={{ fontSize: 13, color: '#64748b' }}>{new Date(h.created_at).toLocaleString()}</td>
                        <td>
                          {h.status === 'done'
                            ? <span style={{ color: '#15803d', fontWeight: 600 }}>Done</span>
                            : h.status === 'failed'
                              ? <span className="error-text">Failed</span>
                              : <span style={{ color: '#b45309' }}>Running…</span>}
                        </td>
                        <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {h.status === 'done'
                            ? ['scheduled', 'non scheduled', 'new drug'].map((k) =>
                                (h.counts?.[k] ? <Badge key={k} label={k} /> : null))
                            : <span style={{ color: '#94a3b8', fontSize: 13 }}>—</span>}
                          {h.status === 'done' && <span style={{ fontSize: 12, color: '#64748b' }}>
                            {Object.entries(h.counts || {}).map(([k, v]) => `${v}`).join(' / ')}
                          </span>}
                        </td>
                        <td>
                          {h.status === 'done' && (
                            <button className="btn-secondary" onClick={() => openReport(h.id)}>Open</button>
                          )}
                          {h.status === 'running' && (
                            <button className="btn-secondary" onClick={() => openReport(h.id)}>View progress</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Running */}
      {job && !TERMINAL.includes(job.status) && (
        <div style={{ marginTop: 24 }}>
          <p style={{ marginBottom: 8, color: '#475569' }}>
            Classifying <strong>{job.original_name}</strong> — {job.processed}/{job.total || '…'} rows
          </p>
          <div style={{ height: 10, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: '#2563eb', transition: 'width .3s' }} />
          </div>
          <p className="drop-zone-hint" style={{ marginTop: 8 }}>
            This runs an LLM per row — large reports take a few minutes. Rows appear below as they’re classified.
          </p>

          {/* Live results as rows finish */}
          {rows.length > 0 && (
            <div className="table-wrapper" style={{ maxHeight: 480, overflow: 'auto', marginTop: 16 }}>
              <table className="users-table">
                <thead>
                  <tr><th>Brand</th><th>Composition</th><th>Classification</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row}>
                      <td style={{ fontWeight: 600 }}>{r.brand || '—'}</td>
                      <td style={{ fontSize: 13, color: '#475569' }}>{r.composition}</td>
                      <td><Badge label={r.classification} /></td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Failed */}
      {job?.status === 'failed' && (
        <div className="error-text" style={{ marginTop: 24 }}>Failed: {job.error || 'unknown error'}</div>
      )}

      {/* Done */}
      {job?.status === 'done' && (
        <div style={{ marginTop: 20, display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Results */}
          <div style={{ flex: '1 1 560px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              {['all', 'scheduled', 'non scheduled', 'new drug'].map((k) => (
                <button key={k} className={`btn-secondary ${filter === k ? '' : ''}`}
                  onClick={() => setFilter(k)}
                  style={{ opacity: filter === k ? 1 : 0.6, fontWeight: filter === k ? 700 : 500 }}>
                  {k === 'all' ? `All ${job.total}` : `${LABELS[k].text} ${counts[k] || 0}`}
                </button>
              ))}
              <button className="btn-primary" style={{ marginLeft: 'auto' }} onClick={download}>⬇ Download Excel</button>
            </div>
            <div className="table-wrapper" style={{ maxHeight: 560, overflow: 'auto' }}>
              <table className="users-table">
                <thead>
                  <tr><th>Brand</th><th>Composition</th><th>Classification</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.row}>
                      <td style={{ fontWeight: 600 }}>{r.brand || '—'}</td>
                      <td style={{ fontSize: 13, color: '#475569' }}>{r.composition}</td>
                      <td><Badge label={r.classification} /></td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Chat */}
          <div style={{ flex: '1 1 320px', minWidth: 300, display: 'flex', flexDirection: 'column',
            height: 600, border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 600 }}>
              Ask about this report
            </div>
            <div className="message-list" style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {messages.length === 0 && (
                <p className="drop-zone-hint">e.g. “How many new drugs?”, “List the scheduled products”, “Why is Amloclav new drug?”</p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`message ${m.role === 'user' ? 'message-user' : 'message-assistant'}`}>
                  <div className="bubble">
                    {m.error ? <span className="error-text">{m.error}</span> : <span className="content-text">{m.content}</span>}
                  </div>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>
            <div className="chat-input-bar" style={{ position: 'static' }}>
              <div className="chat-input-inner">
                <textarea className="input-textarea" value={input} rows={1}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                  placeholder="Ask about the results…" disabled={chatLoading} />
                <button className="send-button" onClick={sendChat} disabled={chatLoading || !input.trim()}>
                  {chatLoading ? <span className="spinner" /> : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
