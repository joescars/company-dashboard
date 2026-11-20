import { useEffect, useState } from 'react';

import { AppShell } from './components/AppShell.js';
import { useAuth } from './hooks/useAuth.js';
import { useConfig } from './hooks/useConfig.js';
import { usePath } from './lib/router.js';
import { applyAccent, applyThemeMode, readThemeMode, type ThemeMode } from './lib/theme.js';
import { AdminEnv } from './pages/AdminEnv.js';
import { Dashboard } from './pages/Dashboard.js';
import { SignIn } from './pages/SignIn.js';

export function App() {
  const configState = useConfig();
  const authState = useAuth();
  const path = usePath();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());

  // Apply the theme choice on first paint and whenever it changes.
  useEffect(() => {
    applyThemeMode(themeMode);
  }, [themeMode]);

  // The instance accent color is configuration, not a hardcoded brand color.
  useEffect(() => {
    if (configState.status === 'ready') {
      applyAccent(configState.config.theme.accent);
      document.title = configState.config.companyName;
    }
  }, [configState]);

  const toggleTheme = () => setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'));

  const shellProps = {
    config: configState.status === 'ready' ? configState.config : undefined,
    auth: authState.state.status === 'ready' ? authState.state.auth : null,
    themeMode,
    onToggleTheme: toggleTheme,
    onSignOut: authState.state.status === 'ready' ? authState.logout : undefined,
  };

  if (configState.status === 'loading' || authState.state.status === 'loading') {
    return (
      <AppShell {...shellProps}>
        <p style={{ padding: '2rem' }}>Loading…</p>
      </AppShell>
    );
  }

  if (configState.status === 'error') {
    return (
      <AppShell {...shellProps}>
        <div className="md-card" style={{ margin: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>Configuration unavailable</h2>
          <p style={{ color: 'var(--md-on-surface-variant)' }}>{configState.error.message}</p>
        </div>
      </AppShell>
    );
  }

  if (authState.state.status === 'error') {
    return (
      <AppShell {...shellProps}>
        <div className="md-card" style={{ margin: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>Could not check sign-in status</h2>
          <p style={{ color: 'var(--md-on-surface-variant)' }}>{authState.state.error.message}</p>
        </div>
      </AppShell>
    );
  }

  const { config } = configState;
  const { auth } = authState.state;

  if (!auth.user) {
    return (
      <AppShell {...shellProps}>
        <SignIn auth={auth} />
      </AppShell>
    );
  }

  if (path === '/admin') {
    return (
      <AppShell {...shellProps}>
        <AdminEnv csrfToken={auth.csrfToken} />
      </AppShell>
    );
  }

  return (
    <AppShell {...shellProps}>
      <Dashboard config={config} />
    </AppShell>
  );
}
