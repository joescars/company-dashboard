import { Router } from 'express';

import { publicConfig } from '../lib/config.js';

/** The safe subset of configuration the browser needs at boot. */
export function configRouter(config) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicConfig(config));
  });

  return router;
}