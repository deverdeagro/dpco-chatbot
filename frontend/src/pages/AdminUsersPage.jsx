import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

function CreateUserModal({ onClose, onCreated, apiFetch }) {
  const [form, setForm] = useState({ username: '', email: '', first_name: '', last_name: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await apiFetch('/api/v1/auth/users/', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.username?.[0] || data.password?.[0] || data.error || 'Failed to create user.'
        setError(msg)
        return
      }
      onCreated(data)
      onClose()
    } catch {
      setError('Network error.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Create User</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          {error && <div className="login-error">{error}</div>}
          <div className="form-row">
            <div className="form-field">
              <label>First name</label>
              <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} disabled={loading} />
            </div>
            <div className="form-field">
              <label>Last name</label>
              <input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} disabled={loading} />
            </div>
          </div>
          <div className="form-field">
            <label>Username <span className="required">*</span></label>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required disabled={loading} />
          </div>
          <div className="form-field">
            <label>Email</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={loading} />
          </div>
          <div className="form-field">
            <label>Password <span className="required">*</span></label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} disabled={loading} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AdminUsersPage() {
  const { apiFetch } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [togglingId, setTogglingId] = useState(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/v1/auth/users/')
      const data = await res.json()
      setUsers(data)
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const handleCreated = (user) => setUsers((prev) => [user, ...prev])

  const toggleActive = async (user) => {
    setTogglingId(user.id)
    try {
      const res = await apiFetch(`/api/v1/auth/users/${user.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !user.is_active }),
      })
      if (res.ok) {
        const updated = await res.json()
        setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)))
      }
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h2>Users</h2>
          <p className="page-subtitle">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Create user</button>
      </div>

      {loading ? (
        <div className="table-loading">Loading…</div>
      ) : (
        <div className="table-wrapper">
          <table className="users-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Email</th>
                <th>Joined</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} className="table-empty">No users yet. Create one to get started.</td></tr>
              )}
              {users.map((user) => (
                <tr key={user.id} className={!user.is_active ? 'row-inactive' : ''}>
                  <td className="cell-name">
                    <span className="avatar">{(user.first_name?.[0] || user.username[0]).toUpperCase()}</span>
                    {user.first_name || user.last_name
                      ? `${user.first_name} ${user.last_name}`.trim()
                      : '—'}
                  </td>
                  <td><code>{user.username}</code></td>
                  <td>{user.email || '—'}</td>
                  <td>{new Date(user.date_joined).toLocaleDateString()}</td>
                  <td>
                    <span className={`status-badge ${user.is_active ? 'status-active' : 'status-inactive'}`}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="cell-actions">
                    <button
                      className={`btn-toggle ${user.is_active ? 'btn-deactivate' : 'btn-activate'}`}
                      onClick={() => toggleActive(user)}
                      disabled={togglingId === user.id}
                    >
                      {togglingId === user.id ? '…' : user.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
          apiFetch={apiFetch}
        />
      )}
    </div>
  )
}
