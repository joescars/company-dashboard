import { useCallback, useEffect, useState } from 'react';

import { fetchAuthStatus, signOut, type AuthStatus } from '../lib/api.js';

type AuthState =
  | { status: 'loading' }
  | { status: 'ready'; auth: AuthStatus }
  | { status: 'error'; error: Error };

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const auth = await fetchAuthStatus(signal);
      setState({ status: 'ready', auth });
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: 'error', error: error as Error });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const logout = useCallback(async () => {
    if (state.status !== 'ready') return;
    try {
      await signOut(state.auth.csrfToken);
    } finally {
      await refresh();
    }
  }, [state, refresh]);

  return { state, refresh, logout };
}
