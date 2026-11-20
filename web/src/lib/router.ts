import { useEffect, useState } from 'react';

/**
 * Minimal client-side router.
 *
 * The server already falls back to index.html for unknown paths, so a couple
 * of history calls are all the dashboard needs. No router dependency.
 */
export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return path;
}

export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
