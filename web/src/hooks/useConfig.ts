import { useEffect, useState } from 'react';

import { fetchConfig, type PublicConfig } from '../lib/api.js';

type State =
  | { status: 'loading' }
  | { status: 'ready'; config: PublicConfig }
  | { status: 'error'; error: Error };

/** Load instance configuration once at boot. */
export function useConfig(): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    fetchConfig(controller.signal)
      .then((config) => setState({ status: 'ready', config }))
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error });
      });

    return () => controller.abort();
  }, []);

  return state;
}