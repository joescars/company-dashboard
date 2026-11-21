/**
 * Display formatters. Everything here is null-safe: a source that has not been
 * fetched yet, or whose payload is missing a field, renders an em dash rather
 * than "undefined" or "NaN" in a metric position.
 */

const DASH = '—';

export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Compact integer/count: 1,284 · 12.4K · 3.1M */
export function count(value: unknown): string {
  const n = num(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1_000)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Money. Falls back to a plain number when no currency code is known. */
export function money(value: unknown, currency?: string | null): string {
  const n = num(value);
  if (n === null) return DASH;
  if (!currency) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  try {
    return n.toLocaleString(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    // An unknown/invalid ISO code must not throw inside render.
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** A rate that arrives as a ratio (0.5123 → 51.2%). */
export function percentFromRatio(value: unknown, digits = 1): string {
  const n = num(value);
  if (n === null) return DASH;
  return `${trim(n * 100, digits)}%`;
}

/** A rate that already arrives as a percentage number (51.23 → 51.2%). */
export function percent(value: unknown, digits = 1): string {
  const n = num(value);
  if (n === null) return DASH;
  return `${trim(n, digits)}%`;
}

/** Seconds → 2m 14s */
export function duration(seconds: unknown): string {
  const n = num(seconds);
  if (n === null) return DASH;
  const total = Math.round(n);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

/** Position-style average, one decimal. */
export function position(value: unknown): string {
  const n = num(value);
  if (n === null) return DASH;
  return n.toFixed(1);
}

/** Absolute date-time, short. */
export function dateTime(iso?: string | null): string {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "4 minutes ago" — coarse on purpose; this is a dashboard, not a clock. */
export function relativeTime(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'never';
  const diffMs = now - date.getTime();
  const futureSlack = -60_000;
  if (diffMs < futureSlack) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return dateTime(iso);
}

/** "2026-11-01 … 2026-11-21" → "Nov 1 – Nov 21" */
export function periodLabel(start?: string | null, end?: string | null): string | null {
  const fmt = (value?: string | null) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const from = fmt(start);
  const to = fmt(end);
  if (!from && !to) return null;
  if (from && to) return `${from} – ${to}`;
  return from ?? to;
}

function trim(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits));
  return rounded.toLocaleString(undefined, { maximumFractionDigits: digits });
}
