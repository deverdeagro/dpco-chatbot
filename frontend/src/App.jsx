import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import ChatPage from './pages/ChatPage'
import AdminUsersPage from './pages/AdminUsersPage'
import FormVPage from './pages/FormVPage'
import ClassifyPage from './pages/ClassifyPage'
import './App.css'

function PrivateRoute({ children, adminOnly = false }) {
  const { auth, isSuperAdmin } = useAuth()
  if (!auth) return <Navigate to="/login" replace />
  if (adminOnly && !isSuperAdmin) return <Navigate to="/chat" replace />
  return children
}

function AppLayout({ children }) {
  const { auth, logout, isSuperAdmin } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">💊</span>
          <span className="brand-text">DPCO</span>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/chat" className={({ isActive }) => `nav-item ${isActive ? 'nav-active' : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Chat
          </NavLink>

          <NavLink to="/classify" className={({ isActive }) => `nav-item ${isActive ? 'nav-active' : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            Classify
          </NavLink>

          <NavLink to="/form5" className={({ isActive }) => `nav-item ${isActive ? 'nav-active' : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            Form V
          </NavLink>

          {isSuperAdmin && (
            <NavLink to="/admin/users" className={({ isActive }) => `nav-item ${isActive ? 'nav-active' : ''}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Users
            </NavLink>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <span className="user-avatar">{auth?.name?.[0]?.toUpperCase() || '?'}</span>
            <div>
              <p className="user-name">{auth?.name}</p>
              <p className="user-role">{auth?.role === 'superadmin' ? 'Super Admin' : 'User'}</p>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout} title="Sign out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      <main className="main-content">
        {children}
      </main>
    </div>
  )
}

function AppRoutes() {
  const { auth, isSuperAdmin } = useAuth()

  return (
    <Routes>
      <Route path="/login" element={auth ? <Navigate to={isSuperAdmin ? '/admin/users' : '/chat'} replace /> : <LoginPage />} />
      <Route path="/chat" element={
        <PrivateRoute>
          <AppLayout><ChatPage /></AppLayout>
        </PrivateRoute>
      } />
      <Route path="/classify" element={
        <PrivateRoute>
          <AppLayout><ClassifyPage /></AppLayout>
        </PrivateRoute>
      } />
      <Route path="/form5" element={
        <PrivateRoute>
          <AppLayout><FormVPage /></AppLayout>
        </PrivateRoute>
      } />
      <Route path="/admin/users" element={
        <PrivateRoute adminOnly>
          <AppLayout><AdminUsersPage /></AppLayout>
        </PrivateRoute>
      } />
      <Route path="*" element={<Navigate to={auth ? (isSuperAdmin ? '/admin/users' : '/chat') : '/login'} replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
