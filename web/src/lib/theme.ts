export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'cd.theme';

/** Pick the stored preference, else the operating system's. */
export function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem(STORAGE_KEY, mode);
}

/**
 * The accent comes from instance configuration. It is set as a source color;
 * the theme derives the correct light/dark primary from it in CSS.
 */
export function applyAccent(accent: string): void {
  document.documentElement.style.setProperty('--md-accent', accent);
}
