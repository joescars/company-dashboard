import express from 'express';

import { loadConfig } from './lib/config.js';
import { securityHeaders } from './lib/security.js';
import { shellHandler } from './lib/shell.js';
import { configRouter } from './routes/config.js';
import { healthRouter } from './routes/health.js';

/**
 * Assemble middleware and routes. Kept as a factory so tests can build an
 * app without binding a port, and so the config is resolved per instance.
 */
export function createApp({ config = loadConfig() } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(express.json({ limit: '256kb' }));

  // Public, non-sensitive API.
  app.use('/api/health', healthRouter());
  app.use('/api/config', configRouter(config));

  // SPA: serves the built bundle and falls back to index.html for client routes.
  app.use(shellHandler(config));

  return app;
}