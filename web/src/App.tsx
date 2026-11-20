import { useEffect } from 'react';

import { AppShell } from './components/AppShell.js';
import { useConfig } from './hooks/useConfig.js';

export function App() {
  const state = useConfig();

  // Reflect the configured company name in the browser tab.
  useEffect(() => {
    if (state.status === 'ready') {
      document.title = state.config.companyName;
    }
  }, [state]);

  if (state.status === 'loading') {
    return <AppShell><p style={{ padding: '2rem' }}>Loading…</p></AppShell>;
  }

  if (state.status === 'error') {
    return (
      <AppShell>
        <div className="md-card" style={{ margin: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>Configuration unavailable</h2>
          <p style={{ color: 'var(--md-on-surface-variant)' }}>{state.error.message}</p>
        </div>
      </AppShell>
    );
  }

  const { config } = state;

  return (
    <AppShell config={config}>
      <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem' }}>
        <div className="md-card">
          <h2 style={{ marginTop: 0 }}>{config.companyName}</h2>
          <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>
            Dashboard scaffold is running. Metric tiles are added in the next phases.
          </p>
        </div>

        <div className="md-card">
          <h3 style={{ marginTop: 0 }}>Enabled sources</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {Object.entries(config.sources)
              .filter(([, value]) => value.enabled)
              .map(([key]) => (
                <li key={key}>{key}</li>
              ))}
          </ul>
        </div>
      </div>
    </AppShell>
  );
}