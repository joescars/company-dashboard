import { useEffect, useState } from 'react';

import { fetchEnvManifest, saveEnvValues, type EnvManifest } from '../lib/api.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: EnvManifest }
  | { status: 'error'; error: Error };

/**
 * Operator-only environment editor.
 *
 * The server reports only whether each variable is set — never its value. The
 * inputs therefore start empty and are write-only: leaving a field blank leaves
 * the variable untouched, and typing a value sets it. There is no way to read
 * an existing value back, by design.
 */
export function AdminEnv({ csrfToken }: { csrfToken: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ applied: string[]; restartRequired: string[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchEnvManifest(controller.signal)
      .then((manifest) => setState({ status: 'ready', manifest }))
      .catch((err: Error) => {
        if (!controller.signal.aborted) setState({ status: 'error', error: err });
      });
    return () => controller.abort();
  }, []);

  const onSave = async () => {
    const values = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value.trim() !== ''),
    );
    if (Object.keys(values).length === 0) {
      setError('Enter at least one value to save.');
      return;
    }

    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const response = await saveEnvValues(csrfToken, values);
      setResult(response);
      setDraft({});
      const refreshed = await fetchEnvManifest();
      setState({ status: 'ready', manifest: refreshed });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (state.status === 'loading') {
    return <p style={{ padding: '2rem' }}>Loading environment manifest…</p>;
  }

  if (state.status === 'error') {
    return (
      <div className="md-card" style={{ margin: '2rem' }}>
        <h2 style={{ marginTop: 0 }}>Manifest unavailable</h2>
        <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>{state.error.message}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem', maxWidth: 900 }}>
      <header>
        <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.75rem', fontWeight: 500 }}>
          Environment
        </h1>
        <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>
          Values are write-only. Existing values are never shown; enter a new value to replace one.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          style={{
            background: 'var(--md-error-container)',
            color: 'var(--md-error)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.75rem 1rem',
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div
          role="status"
          style={{
            background: 'var(--md-success-container)',
            color: 'var(--md-success)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.75rem 1rem',
          }}
        >
          <strong style={{ display: 'block' }}>Saved {result.applied.length} variable(s).</strong>
          {result.restartRequired.length > 0 ? (
            <span>Restart the container to apply: {result.restartRequired.join(', ')}</span>
          ) : null}
        </div>
      ) : null}

      {state.manifest.groups.map((group) => (
        <section key={group.key} className="md-card">
          <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.125rem', fontWeight: 500 }}>
            {group.label}
          </h2>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {group.variables.map((variable) => (
              <label key={variable.name} style={{ display: 'grid', gap: '0.25rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.875rem' }}>{variable.name}</code>
                  <span
                    style={{
                      borderRadius: 'var(--radius-full)',
                      padding: '0.0625rem 0.5rem',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      background: variable.set
                        ? 'var(--md-success-container)'
                        : 'var(--md-surface-container-high)',
                      color: variable.set
                        ? 'var(--md-success)'
                        : 'var(--md-on-surface-variant)',
                    }}
                  >
                    {variable.set ? 'set' : 'not set'}
                  </span>
                  {variable.live ? (
                    <span style={{ fontSize: '0.75rem', color: 'var(--md-on-surface-variant)' }}>
                      live
                    </span>
                  ) : null}
                </span>
                <span style={{ fontSize: '0.8125rem', color: 'var(--md-on-surface-variant)' }}>
                  {variable.description}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={variable.set ? 'Set a new value to replace' : 'Not set'}
                  value={draft[variable.name] ?? ''}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [variable.name]: event.target.value }))
                  }
                  style={{
                    font: 'inherit',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--md-outline-variant)',
                    background: 'var(--md-surface)',
                    color: 'var(--md-on-surface)',
                  }}
                />
              </label>
            ))}
          </div>
        </section>
      ))}

      <div>
        <button className="md-button" type="button" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save values'}
        </button>
      </div>
    </div>
  );
}
