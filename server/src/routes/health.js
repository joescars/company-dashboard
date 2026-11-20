import { Router } from 'express';

export function healthRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return router;
}