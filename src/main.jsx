import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class RenderErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[renderer] Uncaught React render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ padding: 32, color: '#7f1d1d', fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ fontSize: 20 }}>C3 could not render this screen</h1>
          <p>The application hit a UI error. Restart C3 after updating; details are available in the renderer log.</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#475569' }}>{this.state.error.message}</pre>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RenderErrorBoundary>
      <App />
    </RenderErrorBoundary>
  </React.StrictMode>
);
