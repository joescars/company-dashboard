import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * Serve the built SPA. In development the web bundle is served by Vite, so a
 * minimal placeholder is returned instead — the API stays usable either way.
 */
export function shellHandler(config) {
  const distDir = path.resolve(process.cwd(), 'web/dist');
  const indexFile = path.join(distDir, 'index.html');

  return function shellMiddleware(req, res, next) {
    if (req.path.startsWith('/api/')) return next();

    if (fs.existsSync(indexFile)) {
      let html = fs.readFileSync(indexFile, 'utf8');
      // Inject the nonce into every emitted script tag so the bundle satisfies
      // the CSP. Vite does not preserve a nonce placeholder, so it is added here.
      const nonce = res.locals.cspNonce || '';
      html = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
      html = html.replaceAll('__COMPANY_NAME__', escapeHtml(config.companyName));
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(html);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(placeholderPage(config));
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function placeholderPage(config) {
  const name = escapeHtml(config.companyName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
<h1>${name}</h1>
<p>The web bundle is not built. In development run <code>npm run dev:web</code>;
in production build with <code>npm run build</code>.</p>
<p><a href="/api/health">/api/health</a> &middot; <a href="/api/config">/api/config</a></p>
</body></html>`;
}