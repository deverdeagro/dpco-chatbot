import { useState, useRef, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

function SqlDisclosure({ sql, rowCount }) {
  if (!sql) return null
  return (
    <details className="sql-disclosure">
      <summary>{rowCount} row{rowCount !== 1 ? 's' : ''} · View SQL</summary>
      <pre><code>{sql}</code></pre>
    </details>
  )
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      <div className="bubble">
        {message.error ? (
          <span className="error-text">{message.error}</span>
        ) : (
          <span className="content-text">{message.content}</span>
        )}
        {!isUser && <SqlDisclosure sql={message.sql} rowCount={message.rowCount} />}
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { apiFetch } = useAuth()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
    }
  }, [input])

  const sendMessage = useCallback(async () => {
    const question = input.trim()
    if (!question || loading) return

    setMessages((prev) => [...prev, { role: 'user', content: question }])
    setInput('')
    setLoading(true)

    const history = messages.map(({ role, content }) => ({ role, content }))

    try {
      const res = await apiFetch('/api/v1/chat/', {
        method: 'POST',
        body: JSON.stringify({ question, messages: history }),
      })
      const data = await res.json()
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.answer ?? '',
          sql: data.sql ?? null,
          rowCount: data.row_count ?? 0,
          error: data.error ?? null,
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '', sql: null, rowCount: 0, error: 'Network error — is the server running?' },
      ])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, apiFetch])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="chat-page">
      <div className="message-list">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Ask anything about DPCO ceiling prices — medicines, prices, years, S.O. numbers.</p>
            <p className="hint">
              Try: "What is the ceiling price of Paracetamol 500mg?" · "Which medicines had the highest price increase in 2022?"
            </p>
          </div>
        )}
        {messages.map((msg, i) => <MessageBubble key={i} message={msg} />)}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-bar">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about DPCO ceiling prices…"
          disabled={loading}
          rows={1}
        />
        <button
          className="send-button"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
        >
          {loading ? (
            <span className="spinner" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
