import { createContext, useContext, useState, useCallback } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => {
    try {
      const stored = localStorage.getItem('dpco_auth')
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  const login = useCallback((data) => {
    const authData = {
      access: data.access,
      refresh: data.refresh,
      role: data.role,
      username: data.username,
      name: data.name,
    }
    localStorage.setItem('dpco_auth', JSON.stringify(authData))
    setAuth(authData)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('dpco_auth')
    setAuth(null)
  }, [])

  // Attempts to refresh the access token; returns new access token or null
  const refreshAccess = useCallback(async () => {
    const stored = JSON.parse(localStorage.getItem('dpco_auth') || 'null')
    if (!stored?.refresh) return null
    try {
      const res = await fetch('/api/v1/auth/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: stored.refresh }),
      })
      if (!res.ok) { logout(); return null }
      const data = await res.json()
      const updated = { ...stored, access: data.access }
      localStorage.setItem('dpco_auth', JSON.stringify(updated))
      setAuth(updated)
      return data.access
    } catch {
      logout()
      return null
    }
  }, [logout])

  // Authenticated fetch — auto-refreshes on 401
  const apiFetch = useCallback(async (url, options = {}) => {
    const token = auth?.access
    const headers = { 'Content-Type': 'application/json', ...options.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`

    let res = await fetch(url, { ...options, headers })

    if (res.status === 401) {
      const newToken = await refreshAccess()
      if (newToken) {
        headers['Authorization'] = `Bearer ${newToken}`
        res = await fetch(url, { ...options, headers })
      }
    }
    return res
  }, [auth, refreshAccess])

  return (
    <AuthContext.Provider value={{ auth, login, logout, apiFetch, isSuperAdmin: auth?.role === 'superadmin' }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
