import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/app.css'

/**
 * Last-resort error surface.
 *
 * A dashboard that fails to render used to leave a completely blank page: the
 * component threw, React unmounted the tree, and there was nothing on screen to
 * say why. That is the worst possible failure mode for a demo, and the hardest
 * to diagnose. Anything that escapes the app is now written into the DOM — and
 * into the document title, which is visible even in a screenshot.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('AquaSentinel crashed:', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div style={{ padding: 32, fontFamily: 'ui-monospace, monospace', color: '#e8edf4' }}>
        <h1 style={{ fontSize: 18, color: '#ef4444' }}>AquaSentinel failed to render</h1>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#9aa6b6', fontSize: 13 }}>
          {String(error?.stack || error)}
        </pre>
      </div>
    )
  }
}

function fatal(message) {
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = ''
  const pre = document.createElement('pre')
  pre.style.cssText = 'padding:32px;color:#ef4444;font:13px ui-monospace,monospace;white-space:pre-wrap'
  pre.textContent = `AquaSentinel failed to start\n\n${message}`
  root.appendChild(pre)
  document.title = `AquaSentinel — ERROR: ${String(message).slice(0, 120)}`
}

window.addEventListener('error', (e) => fatal(e.error?.stack || e.message))
window.addEventListener('unhandledrejection', (e) => fatal(e.reason?.stack || String(e.reason)))

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
