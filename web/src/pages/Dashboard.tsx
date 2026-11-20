import type { PublicConfig, SourceKey } from '../lib/api.js';

const SOURCE_LABELS: Record<SourceKey, { title: string; blurb: string }> = {
  azure: { title: 'Azure', blurb: 'Cost Management and Monitor spend.' },
  openrouter: { title: 'OpenRouter', blurb: 'Per-key usage and balance.' },
  searchConsole: { title: 'Search Console', blurb: 'Search positions and impressions.' },
  ga4: { title: 'Google Analytics', blurb: 'Sessions, users and page views.' },
  adsense: { title: 'AdSense', blurb: 'Ad revenue and RPM.' },
  simpleAnalytics: { title: 'Simple Analytics', blurb: 'Privacy-friendly traffic totals.' },
};

/**
 * Overview page. Tiles are driven by the enabled sources in configuration;
 * a source without credentials is not rendered at all, so a half-configured
 * instance never shows a broken tile.
 */
export function Dashboard({ config }: { config: PublicConfig }) {
  const enabled = (Object.keys(config.sources) as SourceKey[]).filter(
    (key) => config.sources[key].enabled,
  );

  return (
    <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem', maxWidth: 1100 }}>
      <header>
        <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.75rem', fontWeight: 500 }}>
          {config.companyName}
        </h1>
        <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>
          {config.siteUrl ?? 'No site URL configured'}
        </p>
      </header>

      {enabled.length === 0 ? (
        <div className="md-card">
          <h2 style={{ marginTop: 0, fontSize: '1.125rem' }}>No sources configured yet</h2>
          <p style={{ margin: 0, color: 'var(--md-on-surface-variant)' }}>
            Add credentials for at least one source in the environment, then restart. Enabled
            sources appear here as live tiles.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: '1rem',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}
        >
          {enabled.map((key) => {
            const label = SOURCE_LABELS[key];
            return (
              <section key={key} className="md-card" aria-label={label.title}>
                <h2 style={{ margin: '0 0 0.25rem', fontSize: '1rem', fontWeight: 500 }}>
                  {label.title}
                </h2>
                <p style={{ margin: '0 0 0.75rem', color: 'var(--md-on-surface-variant)' }}>
                  {label.blurb}
                </p>
                <span
                  style={{
                    display: 'inline-block',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--md-primary-container)',
                    color: 'var(--md-on-primary-container)',
                    padding: '0.125rem 0.75rem',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                  }}
                >
                  Connected
                </span>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
