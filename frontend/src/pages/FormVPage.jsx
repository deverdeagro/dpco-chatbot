import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

const STATUS_LABELS = {
  pending:        'Starting…',
  running:        'Running',
  waiting_review: 'Waiting for your review',
  done:           'Completed',
  failed:         'Failed',
}

const TERMINAL_STATUSES = ['done', 'failed']

export default function FormVPage() {
  const { apiFetch } = useAuth()
  const [job, setJob]           = useState(null)
  const [file, setFile]         = useState(null)
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const logRef  = useRef(null)
  const pollRef = useRef(null)

  // Auto-scroll log to bottom as new lines arrive
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [job?.log])

  // Poll job status while active
  const pollJob = useCallback(async (id) => {
    const res = await apiFetch(`/api/v1/form5/jobs/${id}/`)
    if (res.ok) {
      const data = await res.json()
      setJob(data)
      return data.status
    }
    return null
  }, [apiFetch])

  useEffect(() => {
    if (!job?.id || TERMINAL_STATUSES.includes(job.status)) {
      clearInterval(pollRef.current)
      return
    }
    pollRef.current = setInterval(() => pollJob(job.id), 2000)
    return () => clearInterval(pollRef.current)
  }, [job?.id, job?.status, pollJob])

  // File handling
  const acceptFile = (f) => {
    if (f && f.name.endsWith('.xlsx')) setFile(f)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    acceptFile(e.dataTransfer.files[0])
  }

  const handleFileChange = (e) => acceptFile(e.target.files[0])

  // Start filing job
  const startFiling = async () => {
    if (!file || starting) return
    setStarting(true)
    try {
      const formData = new FormData()
      formData.append('excel_file', file)
      const res = await apiFetch('/api/v1/form5/jobs/', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start job')
      setJob(data)
    } catch (err) {
      alert(err.message)
    } finally {
      setStarting(false)
    }
  }

  // Continue after user submits a group in the browser
  const continueJob = async () => {
    if (!job || continuing) return
    setContinuing(true)
    try {
      const res = await apiFetch(`/api/v1/form5/jobs/${job.id}/continue/`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Continue failed')
      setJob((prev) => ({ ...prev, status: 'running' }))
    } catch (err) {
      alert(err.message)
    } finally {
      setContinuing(false)
    }
  }

  const reset = () => { setJob(null); setFile(null) }

  return (
    <div className="admin-page formv-page">
      <div className="admin-header">
        <div>
          <h2>Form V Filing</h2>
          <p className="page-subtitle">Automated MRP revision on NPPA IPDMS portal</p>
        </div>
        {job && TERMINAL_STATUSES.includes(job.status) && (
          <button className="btn-secondary" onClick={reset}>New Job</button>
        )}
      </div>

      {/* ── Upload state ─────────────────────────────── */}
      {!job && (
        <div className="formv-upload">
          <div
            className={`drop-zone ${dragging ? 'drop-zone-active' : ''} ${file ? 'drop-zone-ready' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById('formv-file-input').click()}
          >
            <input
              id="formv-file-input"
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            {file ? (
              <>
                <span className="drop-zone-icon">📊</span>
                <p className="drop-zone-filename">{file.name}</p>
                <p className="drop-zone-hint">Click to change file</p>
              </>
            ) : (
              <>
                <span className="drop-zone-icon">📂</span>
                <p className="drop-zone-label">Drop your Excel file here</p>
                <p className="drop-zone-hint">or click to browse · .xlsx only · sheet "MRP Rev"</p>
              </>
            )}
          </div>

          {file && (
            <button
              className="btn-primary formv-start-btn"
              onClick={startFiling}
              disabled={starting}
            >
              {starting ? <span className="spinner" /> : 'Start Filing'}
            </button>
          )}
        </div>
      )}

      {/* ── Active job ────────────────────────────────── */}
      {job && (
        <div className="formv-job">
          <div className="formv-status-bar">
            <span className={`formv-badge formv-badge-${job.status}`}>
              {STATUS_LABELS[job.status] || job.status}
            </span>
            {job.current_group && job.status === 'waiting_review' && (
              <span className="formv-group-label">Group: <strong>{job.current_group}</strong></span>
            )}
          </div>

          {job.status === 'waiting_review' && (
            <div className="formv-review-prompt">
              <div className="formv-review-text">
                <span className="formv-review-icon">👆</span>
                <div>
                  <p><strong>Action required</strong></p>
                  <p>Review the entries for <strong>{job.current_group}</strong> in the browser window, then click <strong>Submit</strong> on the portal. Once submitted, click Continue below.</p>
                </div>
              </div>
              <button className="btn-primary formv-continue-btn" onClick={continueJob} disabled={continuing}>
                {continuing ? <span className="spinner" /> : '✓ Submitted — Continue to next group'}
              </button>
            </div>
          )}

          <div className="formv-log-section">
            <p className="formv-log-label">Live output</p>
            <pre className="formv-log" ref={logRef}>
              {job.log || 'Waiting for process to start…'}
            </pre>
          </div>

          {job.flagged_rows?.length > 0 && (
            <div className="formv-flagged">
              <h3 className="formv-flagged-title">
                Flagged rows ({job.flagged_rows.length}) — could not be auto-processed
              </h3>
              <div className="table-wrapper">
                <table className="users-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Brand Name</th>
                      <th>Manufacturer</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.flagged_rows.map((r, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{r.srNo}</td>
                        <td style={{ fontWeight: 500 }}>{r.brandName}</td>
                        <td style={{ color: 'var(--text-2)' }}>{r.manufacturer}</td>
                        <td className="error-text">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
