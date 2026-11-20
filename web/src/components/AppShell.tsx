import type { ReactNode } from 'react';

import type { PublicConfig } from '../lib/api.js';

/**
 * Material 3 top app bar plus content area. The company name and logo come
 * entirely from configuration.
 */
export function AppShell({
  config,
  children,
}: {
  config?: PublicConfig;
  children: ReactNode;
}) {
  const name = config?.companyName ?? '';
  const logo = config?.logoUrl;

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.75rem 1.5rem',
          background: 'var(--md-surface)',
          borderBottom: '1px solid var(--md-outline-variant)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        {logo ? (
          <img src={logo} alt="" height={28} style={{ borderRadius: 'var(--radius-xs)' }} />
        ) : null}
        <span style={{ fontSize: '1.125rem', fontWeight: 500 }}>{name}</span>
      </header>
      <main style={{ flex: 1 }}>{children}</main>
    </div>
  );
}