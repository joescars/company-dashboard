import type { ReactNode } from 'react';

import { relativeTime } from '../lib/format.js';

/**
 * Shared chrome for a source tile. Presentation only — each source page below
 * owns its own metrics, because the six sources have genuinely different
 * shapes and a generic field-mapper would be a lie about that.
 */

export type CardStatus = 'loading' | 'idle' | 'ok' | 'partial' | 'error' | 'disabled';

const STATUS_LABEL: Record<CardStatus, string> = {
  loading: 'Loading',
  idle: 'Not fetched',
  ok: 'Up to date',
  partial: 'Partial data',
  error: 'Failed',
  disabled: 'Not configured',
};

export interface SourceCardProps {
  title: string;
  subtitle?: ReactNode;
  status: CardStatus;
  fetchedAt?: string | null;
  error?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  children?: ReactNode;
}

export function SourceCard({
  title,
  subtitle,
  status,
  fetchedAt,
  error,
  onRefresh,
  refreshing = false,
  children,
}: SourceCardProps) {
  const interactive = typeof onRefresh === 'function';

  return (
    <section
      className="md-card source-card"
      data-status={status}
      aria-busy={status === 'loading' || refreshing}
    >
      <header className="source-card__head">
        <div className="source-card__titles">
          <h2 className="source-card__title">{title}</h2>
          {subtitle ? <p className="source-card__subtitle">{subtitle}</p> : null}
        </div>
        <div className="source-card__meta">
          <span className="source-card__status" data-status={status}>
            <span className="source-card__dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
          {fetchedAt ? (
            <time className="source-card__age" dateTime={fetchedAt} title={fetchedAt}>
              {relativeTime(fetchedAt)}
            </time>
          ) : null}
          {interactive ? (
            <button
              type="button"
              className="md-button md-button--text source-card__refresh"
              onClick={onRefresh}
              disabled={refreshing || status === 'disabled'}
              aria-label={`Refresh ${title}`}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          ) : null}
        </div>
      </header>

      {status === 'disabled' ? (
        <p className="source-card__note">
          Not configured for this instance. Set the credentials described in{' '}
          <code>docs/CREDENTIALS.md</code> to include it.
        </p>
      ) : null}

      {error ? (
        <p className="source-card__error" role="status">
          {error}
        </p>
      ) : null}

      {status === 'loading' ? <SkeletonRows /> : null}

      {children}
    </section>
  );
}

/** A single headline number with a label and optional hint. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Minimal inline sparkline. Values are normalised to the box, so it reads as a
 * shape rather than an axis. Deliberately no library.
 */
export function Sparkline({
  values,
  height = 44,
  label,
}: {
  values: number[];
  height?: number;
  label: string;
}) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return null;

  const width = 240;
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const span = max - min || 1;
  const step = width / (clean.length - 1);

  const points = clean
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const last = clean[clean.length - 1] ?? min;
  const lastX = width;
  const lastY = height - ((last - min) / span) * (height - 4) - 2;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      height={height}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <polyline className="sparkline__line" points={points} fill="none" />
      <circle className="sparkline__dot" cx={lastX} cy={lastY} r="2.5" />
    </svg>
  );
}

/** Compact key/value table used by the list-shaped sections. */
export function DataTable({
  columns,
  rows,
  emptyLabel = 'Nothing to show for this period.',
}: {
  columns: { key: string; label: string; align?: 'start' | 'end' }[];
  rows: Record<string, ReactNode>[];
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <p className="source-card__note">{emptyLabel}</p>;

  return (
    <div className="data-table__scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={{ textAlign: column.align ?? 'start' }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key} style={{ textAlign: column.align ?? 'start' }}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-section failure note, so one broken call doesn't hide the good ones. */
export function SectionError({ children }: { children: ReactNode }) {
  return (
    <p className="source-card__error source-card__error--inline" role="status">
      {children}
    </p>
  );
}

export function SkeletonRows() {
  return (
    <div className="skeleton" aria-hidden="true">
      <span className="skeleton__bar skeleton__bar--wide" />
      <span className="skeleton__bar" />
      <span className="skeleton__bar skeleton__bar--short" />
    </div>
  );
}
