console.log('>>> [MAIN.JSX] MOUNTED');
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('REACT ERROR BOUNDARY CAUGHT:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, background: '#090a0f', color: '#f87171', height: '100vh', fontFamily: 'monospace', overflow: 'auto' }}>
          <h2 style={{ fontSize: 20, marginBottom: 12, color: '#ef4444' }}>⚠️ UI Render Error</h2>
          <p style={{ color: '#e2e8f0', marginBottom: 16 }}>{this.state.error?.message || String(this.state.error)}</p>
          <pre style={{ background: '#121620', padding: 16, borderRadius: 8, fontSize: 12, color: '#94a3b8', whiteSpace: 'pre-wrap' }}>
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{ marginTop: 20, padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}
          >
            Clear Local Storage &amp; Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
