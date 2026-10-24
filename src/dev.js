// /dev: a pretend Shopify for testing on your laptop (DEV_TEST_CLIENT=true).
// Runs the exact flow Shopify runs and shows what Shopify would receive.
import express from 'express';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { db } from './db.js';
import { devPage } from './pages.js';

const CLIENT_ID = 'dev-test-client';

export async function devRouter() {
  const secret = crypto.createHash('sha256').update(`dev:${config.cookieKeys[0]}`).digest('base64url');
  const callback = `${config.issuer}/dev/callback`;
  await db().collection('oidc_client').updateOne({ _id: CLIENT_ID }, {
    $set: {
      payload: {
        client_id: CLIENT_ID,
        client_secret: secret,
        client_name: 'Local test (acts like Shopify)',
        redirect_uris: [callback],
        post_logout_redirect_uris: [`${config.issuer}/dev?signed_out=1`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    },
  }, { upsert: true });

  const router = express.Router();
  const jwks = createRemoteJWKSet(new URL(`${config.issuer}/jwks`));
  const send = (res, data) => res.type('html').send(devPage(data));

  router.get('/dev', async (req, res) => {
    const users = await db().collection('users').find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: -1 }).limit(20).toArray();
    send(res, { users, signedOut: req.query.signed_out === '1' });
  });

  router.get('/dev/start', (req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    res.cookie('dev_state', JSON.stringify({ state, nonce }), { httpOnly: true, signed: true, sameSite: 'lax', path: '/dev', maxAge: 30 * 60_000 });
    const u = new URL(`${config.issuer}/authorize`);
    u.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'openid email profile phone address offline_access',
      state,
      nonce,
      ...(req.query.prompt ? { prompt: String(req.query.prompt) } : {}),
    });
    res.redirect(303, u.toString());
  });

  router.get('/dev/callback', async (req, res) => {
    let saved;
    try { saved = JSON.parse(req.signedCookies.dev_state || 'null'); } catch { saved = null; }
    res.clearCookie('dev_state', { path: '/dev' });
    if (req.query.error) return send(res, { error: `${req.query.error}: ${req.query.error_description || ''}` });
    if (!saved || saved.state !== req.query.state) return send(res, { error: 'State mismatch — start again from /dev.' });
    try {
      const r = await fetch(`${config.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: callback, client_id: CLIENT_ID, client_secret: secret,
        }),
      });
      const tokens = await r.json();
      if (!r.ok) throw new Error(`${tokens.error}: ${tokens.error_description}`);
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: config.issuer, audience: CLIENT_ID });
      if (payload.nonce !== saved.nonce) throw new Error('nonce mismatch');
      return send(res, {
        claims: payload,
        shopifyOk: Boolean(payload.email) && payload.email_verified === true,
        hasRefresh: Boolean(tokens.refresh_token),
        logoutUrl: `${config.issuer}/logout?${new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: `${config.issuer}/dev?signed_out=1` })}`,
      });
    } catch (e) {
      return send(res, { error: e.message });
    }
  });

  return router;
}
