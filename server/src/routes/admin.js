import { Router } from 'express';

import { ENV_VARIABLES, knownVariableNames, manifestStatus } from '../lib/env-manifest.js';
import { requireOperator } from '../middleware/auth.js';

/**
 * Admin-only environment manifest.
 *
 * Write-only by design. The GET endpoint reports whether each variable is set
 * but never reads or returns a value. The POST endpoint accepts values and
 * applies them to the running process, but its response confirms only which
 * names were applied — never what they were set to.
 *
 * A write applies to process.env immediately. Variables resolved at boot
 * (the whole manifest, currently) still need a restart to take effect, so the
 * response says which names are now pending a restart.
 */
export function adminRouter() {
  const router = Router();
  const known = knownVariableNames();

  router.use(requireOperator);

  router.get('/env', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      groups: manifestStatus(),
      restartRequired: [],
      note: 'Values are never returned. Set a variable to an empty string to clear it.',
    });
  });

  router.post('/env', (req, res) => {
    const body = req.body ?? {};
    const updates = body.variables ?? body;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({
        error: 'invalid_body',
        message: 'Expected an object of { VARIABLE_NAME: value } pairs.',
      });
    }

    const applied = [];
    const unknown = [];
    const restartRequired = [];

    for (const [name, value] of Object.entries(updates)) {
      if (!known.has(name)) {
        unknown.push(name);
        continue;
      }
      if (value === null || value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = String(value);
      }
      applied.push(name);
      const variable = ENV_VARIABLES.find((entry) => entry.name === name);
      if (variable && !variable.live) restartRequired.push(name);
    }

    if (unknown.length) {
      return res.status(400).json({
        error: 'unknown_variables',
        message: 'Some variables are not part of the manifest.',
        unknown,
      });
    }

    // Confirm what changed without echoing any value back to the client.
    return res.json({
      applied,
      restartRequired,
      note: 'Applied to the running process. Restart the container to persist across deployments.',
    });
  });

  return router;
}
