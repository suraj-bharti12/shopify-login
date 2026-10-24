import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, enabledSocial } from './config.js';
import { connectDb, migrateUsers } from './db.js';
import { stores, initStores } from './stores.js';
import { loadSettings } from './settings.js';
import { adminRouter, initAdmin } from './admin.js';
import { createProvider } from './oidc.js';
import { loginRouter } from './login.js';
import { devRouter } from './dev.js';
import { messagePage } from './pages.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  await connectDb();
  await migrateUsers();
  await loadSettings();
  const provider = await createProvider();
  await initStores();
  await initAdmin();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => res.json({ ok: true, stores: stores.all().map((s) => s.id) }));

  // Login drawer for store themes: fonts + CSS + widget code in one file.
  // The small theme snippet fetches this, so design changes need no theme edit.
  const widgetHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'ngrok-skip-browser-warning',
    'Access-Control-Max-Age': '600',
  };
  app.options('/widget.js', (req, res) => res.set(widgetHeaders).sendStatus(204));
  app.get('/widget.js', (req, res) => {
    const pub = path.join(here, '..', 'public');
    const css = fs.readFileSync(path.join(pub, 'login.css'), 'utf8');
    const js = fs.readFileSync(path.join(pub, 'login.js'), 'utf8');
    const fonts = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap';
    res.set({
      ...widgetHeaders,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': config.isProd ? 'public, max-age=300' : 'no-cache',
    });
    res.send(`(function () {
  var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(fonts)}; document.head.appendChild(l);
  var s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);
})();
${js}`);
  });
  app.use('/static', express.static(path.join(here, '..', 'public'), { maxAge: config.isProd ? '1h' : 0 }));

  // Security headers for our own HTML pages
  const pageHeaders = helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'https:', 'data:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'script-src': ["'self'"],
        'form-action': ["'self'", 'https:', ...(config.isProd ? [] : ['http:'])],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginOpenerPolicy: false,
  });
  app.use(['/interaction', '/login', '/social', '/dev', '/admin'], pageHeaders, (req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  app.use(cookieParser(config.cookieKeys));
  app.use(adminRouter());
  app.use(loginRouter(provider));
  if (config.devTestClient) app.use(await devRouter());

  // Discovery, /authorize, /token, /userinfo, /jwks, /logout
  app.use(provider.callback());

  app.use((err, req, res, next) => {
    console.error('[app] error', err);
    if (res.headersSent) return next(err);
    return res.status(500).type('html').send(messagePage({ title: 'Something went wrong', message: 'Please go back to the store and try again.' }));
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.on('unhandledRejection', (e) => console.error('[crash] unhandledRejection', e));
  process.on('uncaughtException', (e) => console.error('[crash] uncaughtException', e));
  const app = await createApp();
  app.listen(config.port, () => {
    const list = stores.all();
    console.log(`Login server running on :${config.port}`);
    console.log(`Discovery URL: ${config.issuer}/.well-known/openid-configuration`);
    console.log(`Admin panel:   ${config.issuer}/admin`);
    if (config.devTestClient) console.log(`Test page:     ${config.issuer}/dev`);
    console.log(`Stores:        ${list.map((s) => s.id).join(', ') || 'none yet (add one in the admin panel)'}`);
    console.log(`SMS: ${config.sms.provider} | Email: ${config.mail.transport} | Social: ${Object.keys(enabledSocial).filter((k) => enabledSocial[k]).join(', ') || 'none'}`);
  });
}
