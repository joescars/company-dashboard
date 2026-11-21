import type { ReactNode } from 'react';

import type { AuthStatus, PublicConfig } from '../lib/api.js';
import { navigate, usePath } from '../lib/router.js';
import type { ThemeMode } from '../lib/theme.js';

/**
 * Material 3 top app bar plus content area. The company name and logo come
 * entirely from configuration; navigation and account controls only appear
 * once the operator is signed in.
 */
export function AppShell({
  config,
  auth,
  themeMode,
  onToggleTheme,
  onSignOut,
  children,
}: {
  config?: PublicConfig;
  auth?: AuthStatus | null;
  themeMode?: ThemeMode;
  onToggleTheme?: () => void;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const path = usePath();
  const name = config?.companyName ?? '';
  const logo = config?.logoUrl;
  const signedIn = Boolean(auth?.user);

  const navLink = (label: string, to: string) => {
    const active = path === to;
    return (
      <button
        key={to}
        type="button"
        className="md-state-layer"
        onClick={() => navigate(to)}
        aria-current={active ? 'page' : undefined}
        style={{
          font: 'inherit',
          fontWeight: active ? 600 : 500,
          border: 'none',
          background: active ? 'var(--md-primary-container)' : 'transparent',
          color: active ? 'var(--md-on-primary-container)' : 'var(--md-on-surface-variant)',
          borderRadius: 'var(--radius-full)',
          padding: '0.375rem 0.875rem',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        className="app-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          padding: '0.75rem 1.5rem',
          background: 'var(--md-surface)',
          borderBottom: '1px solid var(--md-outline-variant)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
          {logo ? (
            <img src={logo} alt="" height={28} style={{ borderRadius: 'var(--radius-xs)' }} />
          ) : null}
          <span style={{ fontSize: '1.125rem', fontWeight: 500, whiteSpace: 'nowrap' }}>
            {name}
          </span>
        </div>

        {signedIn ? (
          <nav style={{ display: 'flex', gap: '0.25rem', marginLeft: '0.5rem' }}>
            {navLink('Overview', '/')}
            {navLink('Environment', '/admin')}
          </nav>
        ) : null}

        <div
          className="app-header__actions"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}
        >
          {onToggleTheme ? (
            <button
              type="button"
              className="md-state-layer"
              onClick={onToggleTheme}
              aria-label={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`}
              style={{
                font: 'inherit',
                border: 'none',
                background: 'transparent',
                color: 'var(--md-on-surface-variant)',
                borderRadius: 'var(--radius-full)',
                padding: '0.5rem',
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              {themeMode === 'dark' ? '☀' : '☾'}
            </button>
          ) : null}

          {signedIn && auth?.user ? (
            <>
              <span
                className="app-header__user"
                style={{
                  fontSize: '0.875rem',
                  color: 'var(--md-on-surface-variant)',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={auth.user.email}
              >
                {auth.user.name || auth.user.email}
              </span>
              {onSignOut ? (
                <button
                  type="button"
                  className="md-button"
                  data-variant="tonal"
                  onClick={onSignOut}
                  style={{ padding: '0.375rem 1rem' }}
                >
                  Sign out
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <main style={{ flex: 1 }}>{children}</main>
    </div>
  );
}
