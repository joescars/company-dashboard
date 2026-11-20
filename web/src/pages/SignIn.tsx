import type { AuthStatus } from '../lib/api.js';

const AUTH_ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled at Google.',
  state_mismatch: 'The sign-in attempt expired. Try again.',
  unauthorized: 'That Google account is not on the allowlist for this dashboard.',
  session_error: 'Could not establish a session. Try again.',
};

/**
 * Signed-out state. Google login is only possible when the instance has OAuth
 * credentials and an admin allowlist; otherwise the page says exactly which
 * variables are missing rather than showing a dead button.
 */
export function SignIn({ auth }: { auth: AuthStatus }) {
  const params = new URLSearchParams(window.location.search);
  const errorKey = params.get('auth');
  const error = errorKey ? AUTH_ERRORS[errorKey] ?? 'Sign-in failed.' : null;

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh', padding: '2rem' }}>
      <div className="md-card" style={{ maxWidth: 460, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>Sign in</h2>
        <p style={{ color: 'var(--md-on-surface-variant)', marginTop: 0 }}>
          This dashboard shows private company metrics. Sign in with an allowlisted Google account.
        </p>

        {error ? (
          <p
            role="alert"
            style={{
              background: 'var(--md-error-container)',
              color: 'var(--md-error)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1rem',
              margin: '0 0 1rem',
            }}
          >
            {error}
          </p>
        ) : null}

        {auth.configured ? (
          <a className="md-button" href="/api/auth/login" style={{ textDecoration: 'none' }}>
            Sign in with Google
          </a>
        ) : (
          <div
            style={{
              background: 'var(--md-surface-container-high)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1rem',
            }}
          >
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Login is not configured</strong>
            <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>
              Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>,{' '}
              <code>GOOGLE_CALLBACK_URL</code> and <code>ADMIN_EMAILS</code>, then restart the
              container.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
