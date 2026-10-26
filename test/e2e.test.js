// End-to-end tests. Plays Shopify (the OIDC client), the store page (drawer)
// and the customer's browser. Needs MongoDB:
//   MONGODB_URI=mongodb://127.0.0.1:27017/idp_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRemoteJWKSet, jwtVerify, generateKeyPair, exportJWK, SignJWT,
} from 'jose';

const PORT = 3999;
const ISSUER = `http://localhost:${PORT}`;
const STORE_ORIGIN = 'https://store.example';
const OTHER_ORIGIN = 'https://other.example';

// Two stores, to check they stay separate
const storesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-stores-'));
fs.writeFileSync(path.join(storesDir, 'test-store.json'), JSON.stringify({
  id: 'test-store', name: 'Test Store', shopDomain: 'test-store.myshopify.com', shopId: '111', domains: ['store.example'],
  brand: { name: 'Test Brand', tagline: 'Hello', color: '#123456' }, smsTemplate: 'TEST {otp} CODE',
}));
fs.writeFileSync(path.join(storesDir, 'other-store.json'), JSON.stringify({
  id: 'other-store', shopDomain: 'other-store.myshopify.com', shopId: '222', domains: ['other.example'], brand: { name: 'Other' },
}));

Object.assign(process.env, {
  NODE_ENV: 'test',
  ISSUER,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/idp_test',
  COOKIE_KEYS: 'test-key-1',
  OTP_SECRET: 'test-otp',
  STORES_DIR: storesDir,
  MAIL_TRANSPORT: 'console',
  SMS_PROVIDER: 'console',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  FACEBOOK_APP_ID: 'fb-app',
  FACEBOOK_APP_SECRET: 'fb-secret',
});

// Capture codes printed by the console email/SMS senders
const sent = [];
let adminSetupCode = null;
const origLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  const m = s.match(/To: (\S+)[\s\S]*?(\d{6})/);
  if (s.includes(':console]') && m) sent.push({ to: m[1], code: m[2], text: s });
  else if (s.startsWith('Setup code: ')) adminSetupCode = s.slice(12).trim();
  else if (!s.includes('ADMIN SETUP') && !s.startsWith('Open http') && !/^=+$/.test(s.trim())) origLog(...a);
};
const lastSent = (to) => [...sent].reverse().find((x) => x.to === to);
const lastCode = (to) => lastSent(to)?.code;

// Fake Google + Facebook
const { privateKey: gKey, publicKey: gPub } = await generateKeyPair('RS256', { extractable: true });
const gJwk = { ...(await exportJWK(gPub)), kid: 'gk', alg: 'RS256', use: 'sig' };
const fake = { googleNonce: null, googleUser: null, fbUser: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(input instanceof Request ? input.url : input);
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.host === 'accounts.google.com') {
    const iss = 'https://accounts.google.com';
    if (u.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: iss, authorization_endpoint: `${iss}/auth`, token_endpoint: `${iss}/token`, jwks_uri: `${iss}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (u.pathname === '/jwks') return json({ keys: [gJwk] });
    if (u.pathname === '/token') {
      const id_token = await new SignJWT({ ...fake.googleUser.claims, nonce: fake.googleNonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'gk' }).setIssuer(iss).setAudience('g-client')
        .setSubject(fake.googleUser.sub).setIssuedAt().setExpirationTime('5m').sign(gKey);
      return json({ access_token: 'x', token_type: 'Bearer', expires_in: 3600, id_token });
    }
  }
  if (u.host === 'graph.facebook.com') {
    if (u.pathname.endsWith('/oauth/access_token')) return json({ access_token: 'fbtok' });
    if (u.pathname.endsWith('/me')) return json(fake.fbUser);
  }
  return realFetch(input, init);
};

// FerretDB (used when real MongoDB isn't available) lacks TTL/partial indexes
if (process.env.TEST_FERRETDB) {
  const { Collection } = await import('mongodb');
  const strip = (o = {}) => {
    const { expireAfterSeconds, partialFilterExpression, ...rest } = o;
    if (partialFilterExpression) delete rest.unique;
    return rest;
  };
  const ci = Collection.prototype.createIndex;
  Collection.prototype.createIndex = function createIndex(spec, o) { return ci.call(this, spec, strip(o)); };
  const cis = Collection.prototype.createIndexes;
  Collection.prototype.createIndexes = function createIndexes(specs, o) { return cis.call(this, specs.map((x) => strip(x)), o); };
}

const mongoose = (await import('mongoose')).default;
const { createApp } = await import('../src/server.js');
const { stores } = await import('../src/stores.js');

const SECRET = 'secret_test';
const SHOPIFY_LOGIN = `${STORE_ORIGIN}/customer_authentication/login?return_to=%2Fproducts%2Fshirt`;
let STORE; let SHOPIFY_CALLBACK; let SHOPIFY_LOGOUT;

let server;
before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  const app = await createApp(); // imports the store files from STORES_DIR
  STORE = stores.get('test-store');
  SHOPIFY_CALLBACK = STORE.redirectUris[0];
  SHOPIFY_LOGOUT = STORE.logoutUris[0];
  await mongoose.connection.db.collection('oidc_client').updateOne({ _id: STORE.clientId }, { $set: { 'payload.client_secret': SECRET } });
  server = app.listen(PORT);
});
after(async () => {
  server?.close();
  await mongoose.disconnect();
  fs.rmSync(storesDir, { recursive: true, force: true });
});

// ---------- helpers ----------

// Minimal browser: cookie jar per address + manual redirects
const LOGIN2 = `http://127.0.0.1:${PORT}`; // a store's own login domain in the tests
const SERVER_ORIGINS = new Set([ISSUER, LOGIN2]);
function browser() {
  const jars = new Map();
  const jarFor = (origin) => { if (!jars.has(origin)) jars.set(origin, new Map()); return jars.get(origin); };
  async function req(url, { method = 'GET', form } = {}) {
    const u = new URL(url, ISSUER);
    const jar = jarFor(u.origin);
    const headers = {};
    if (jar.size && SERVER_ORIGINS.has(u.origin)) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { body = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(u, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i); const v = pair.slice(i + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), url: u.toString() };
  }
  // Follow redirects until the browser leaves this server
  async function go(url, opts) {
    let r = await req(url, opts);
    for (let i = 0; i < 15 && r.location; i += 1) {
      const nextUrl = new URL(r.location, r.url);
      if (!SERVER_ORIGINS.has(nextUrl.origin)) return { ...r, final: nextUrl };
      r = await req(nextUrl.toString());
    }
    return r;
  }
  return { req, go, jar: jarFor(ISSUER) };
}

// The login widget's API calls
async function api(pathname, body, origin = STORE_ORIGIN) {
  const res = await fetch(`${ISSUER}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
  });
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), json: await res.json() };
}

function authorizeUrl(extra = {}) {
  return `/authorize?${new URLSearchParams({
    client_id: STORE.clientId, redirect_uri: SHOPIFY_CALLBACK, response_type: 'code',
    scope: 'openid email profile phone offline_access', state: 'st123', nonce: 'n123', ...extra,
  })}`;
}

// Shopify swaps the code for tokens
async function exchange(final) {
  assert.equal(final.origin + final.pathname, SHOPIFY_CALLBACK);
  assert.equal(final.searchParams.get('state'), 'st123');
  const res = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: final.searchParams.get('code'), redirect_uri: SHOPIFY_CALLBACK,
      client_id: STORE.clientId, client_secret: SECRET,
    }),
  });
  const tokens = await res.json();
  assert.equal(res.status, 200, JSON.stringify(tokens));
  const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(`${ISSUER}/jwks`)), { issuer: ISSUER, audience: STORE.clientId });
  assert.equal(payload.nonce, 'n123');
  return { tokens, claims: payload };
}

// After the widget says "done": browser follows the ticket, then Shopify's
// login sends it to /authorize, which must finish without showing a page.
async function finishFromStore(b, redirect) {
  const hop = await b.req(redirect);
  assert.equal(hop.status, 303);
  assert.equal(hop.location, SHOPIFY_LOGIN);
  return b.go(authorizeUrl());
}

async function mobileLogin(mobile, { origin = STORE_ORIGIN, returnTo = SHOPIFY_LOGIN, profile } = {}) {
  const s1 = await api('/api/login/otp/send', { store: 'test-store', returnTo, mobile }, origin);
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  let res = await api('/api/login/otp/verify', { flowId: s1.json.flowId, code: lastCode(`+91${mobile}`) }, origin);
  if (res.json.step === 'profile') {
    assert.ok(profile, `profile needed: ${JSON.stringify(res.json)}`);
    const p = await api('/api/login/profile', { flowId: s1.json.flowId, ...profile }, origin);
    if (p.json.step === 'otp') res = await api('/api/login/otp/verify', { flowId: s1.json.flowId, code: lastCode(profile.email) }, origin);
    else res = p;
  }
  return res;
}

// ---------- tests ----------

test('discovery document has what Shopify needs', async () => {
  const d = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  assert.equal(d.issuer, ISSUER);
  assert.ok(d.authorization_endpoint && d.token_endpoint && d.userinfo_endpoint && d.jwks_uri && d.end_session_endpoint);
  assert.ok(d.token_endpoint_auth_methods_supported.includes('client_secret_post'));
  assert.ok(d.scopes_supported.includes('email'));
});

test('store config: branding per store, CORS only for its own sites', async () => {
  const r = await fetch(`${ISSUER}/api/login/config?store=test-store`, { headers: { origin: STORE_ORIGIN } });
  const c = await r.json();
  assert.equal(r.headers.get('access-control-allow-origin'), STORE_ORIGIN);
  assert.equal(c.brand.name, 'Test Brand');
  assert.equal(c.brand.color, '#123456');
  assert.equal(c.social.google, true);
  const evil = await fetch(`${ISSUER}/api/login/config?store=test-store`, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('hosted page (checkout Sign in): new mobile customer -> name + email -> Shopify', async () => {
  const b = browser();
  const pageRes = await b.go(authorizeUrl());
  assert.equal(pageRes.status, 200, pageRes.text.slice(0, 200));
  assert.match(pageRes.text, /data-mode="page"/);
  assert.match(pageRes.text, /data-store="test-store"/);
  const returnTo = pageRes.text.match(/data-return-to="([^"]+)"/)[1];
  assert.ok(returnTo.startsWith(`${ISSUER}/interaction/`));

  const done = await mobileLogin('9000000001', {
    origin: ISSUER, returnTo, profile: { firstName: 'Asha', lastName: 'K', email: 'asha@example.com' },
  });
  assert.equal(done.json.step, 'done', JSON.stringify(done.json));
  assert.match(lastSent('+919000000001').text, /TEST \d{6} CODE/); // store's own SMS text

  const back = await b.go(done.json.redirect);
  assert.ok(back.final, `expected redirect to Shopify, got ${back.status} ${back.text?.slice(0, 200)}`);
  const { tokens, claims } = await exchange(back.final);
  assert.equal(claims.email, 'asha@example.com');
  assert.equal(claims.email_verified, true);
  assert.equal(claims.given_name, 'Asha');
  assert.equal(claims.phone_number, '+919000000001');
  assert.ok(tokens.refresh_token);

  const refreshed = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: STORE.clientId, client_secret: SECRET }),
  });
  assert.equal(refreshed.status, 200);
  const ui = await (await fetch(`${ISSUER}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
  assert.equal(ui.email, 'asha@example.com');

  // Shopify-initiated logout goes straight back to the store
  const lo = await b.req(`/logout?${new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: SHOPIFY_LOGOUT })}`);
  const xsrf = lo.text.match(/name="xsrf" value="([^"]+)"/)[1];
  const action = lo.text.match(/<form[^>]*action="([^"]+)"/)[1];
  const lo2 = await b.go(action, { method: 'POST', form: { xsrf, logout: 'yes' } });
  assert.ok(lo2.final.toString().startsWith(SHOPIFY_LOGOUT));

  const users = await mongoose.connection.db.collection('users').find({ email: 'asha@example.com' }).toArray();
  assert.deepEqual(users[0].stores, ['test-store']);
});

test('store drawer: returning customer logs in with just the OTP, silently', async () => {
  const res = await mobileLogin('9000000001');
  assert.equal(res.json.step, 'done');
  assert.equal(res.cors, STORE_ORIGIN);
  const done = await finishFromStore(browser(), res.json.redirect);
  assert.ok(done.final, done.text?.slice(0, 200));
  const { claims } = await exchange(done.final);
  assert.equal(claims.email, 'asha@example.com');
  // ticket is single-use
  assert.equal((await browser().req(res.json.redirect)).status, 400);
});

test('wrong OTP is counted and refused', async () => {
  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000009' });
  const right = lastCode('+919000000009');
  const wrong = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: right === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /Incorrect code. 4 attempt/);
});

test('mobile number + an email that already has an account -> one merged account', async () => {
  const res = await mobileLogin('9000000002', { profile: { firstName: 'Asha', email: 'asha@example.com' } });
  assert.equal(res.json.step, 'done');
  const all = await mongoose.connection.db.collection('users').find({ email: 'asha@example.com' }).toArray();
  assert.equal(all.length, 1);
  assert.equal(await mongoose.connection.db.collection('users').countDocuments({ phone: '+919000000002' }), 0);
});

test('password: wrong password, forgot -> reset -> login', async () => {
  const bad = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com', password: 'nope1234' });
  assert.equal(bad.status, 401);
  const f1 = await api('/api/login/forgot', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com' });
  assert.equal(f1.json.step, 'otp');
  const f2 = await api('/api/login/otp/verify', { flowId: f1.json.flowId, code: lastCode('asha@example.com') });
  assert.equal(f2.json.step, 'reset');
  const weak = await api('/api/login/reset', { flowId: f1.json.flowId, password: 'short' });
  assert.equal(weak.status, 400);
  const f3 = await api('/api/login/reset', { flowId: f1.json.flowId, password: 'newpass123' });
  assert.equal(f3.json.step, 'done');
  const ok = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com', password: 'newpass123' });
  assert.equal(ok.json.step, 'done');
  const done = await finishFromStore(browser(), ok.json.redirect);
  assert.equal((await exchange(done.final)).claims.email, 'asha@example.com');
});

test('Google: links to the existing account and comes back logged in', async () => {
  const b = browser();
  const start = await b.req(`/login/social/google?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  const au = new URL(start.location);
  assert.equal(au.host, 'accounts.google.com');
  fake.googleNonce = au.searchParams.get('nonce');
  fake.googleUser = { sub: 'g-1', claims: { email: 'asha@example.com', email_verified: true, given_name: 'Asha' } };
  const back = await b.req(`/social/google/callback?${new URLSearchParams({ code: 'c', state: au.searchParams.get('state') })}`);
  assert.equal(back.status, 303);
  assert.equal(back.location, SHOPIFY_LOGIN);
  const done = await b.go(authorizeUrl());
  assert.equal((await exchange(done.final)).claims.email, 'asha@example.com');
  const u = await mongoose.connection.db.collection('users').findOne({ email: 'asha@example.com' });
  assert.ok(u.identities.some((i) => i.provider === 'google'));
});

test('Facebook without email: asks for it on the hosted page, then logs in', async () => {
  const b = browser();
  const start = await b.req(`/login/social/facebook?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  const state = new URL(start.location).searchParams.get('state');
  fake.fbUser = { id: 'fb-1', first_name: 'Arjun', last_name: 'P' };
  const back = await b.req(`/social/facebook/callback?code=c&state=${state}`);
  assert.equal(back.status, 303);
  assert.match(back.location, /^\/login\/continue\?flow=/);
  const cont = await b.req(back.location);
  assert.equal(cont.status, 200);
  assert.match(cont.text, /data-step="profile"/);
  const flowId = cont.text.match(/data-flow="([^"]+)"/)[1];
  const p = await api('/api/login/profile', { flowId, email: 'arjun@example.com' }, ISSUER);
  assert.equal(p.json.step, 'otp');
  const v = await api('/api/login/otp/verify', { flowId, code: lastCode('arjun@example.com') }, ISSUER);
  assert.equal(v.json.step, 'done');
  const done = await finishFromStore(b, v.json.redirect);
  assert.equal((await exchange(done.final)).claims.email, 'arjun@example.com');
});

test('security: forged social state, other stores, unknown sites, bad return URLs', async () => {
  const b = browser();
  await b.req(`/login/social/facebook?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  const forged = await b.req('/social/facebook/callback?code=c&state=forged');
  assert.equal(forged.status, 400);

  const otherSite = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000003' }, OTHER_ORIGIN);
  assert.equal(otherSite.status, 403);
  const unknown = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000003' }, 'https://evil.example');
  assert.equal(unknown.status, 403);
  const badReturn = await api('/api/login/otp/send', { store: 'test-store', returnTo: 'https://evil.example/x', mobile: '9000000003' });
  assert.equal(badReturn.status, 400);
  const socialBad = await b.req(`/login/social/google?store=test-store&returnTo=${encodeURIComponent('https://evil.example')}`);
  assert.equal(socialBad.status, 400);

  // A flow from one store can't be continued from another store's site
  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000004' });
  const cross = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: lastCode('+919000000004') }, OTHER_ORIGIN);
  assert.equal(cross.status, 403);

  const wrongSecret = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', redirect_uri: SHOPIFY_CALLBACK, client_id: STORE.clientId, client_secret: 'nope' }),
  });
  assert.equal(wrongSecret.status, 401);
});

test('a deleted customer with an old session sees the login page instead of an error', async () => {
  const b = browser();
  const page = await b.go(authorizeUrl());
  const returnTo = page.text.match(/data-return-to="([^"]+)"/)[1];
  const done = await mobileLogin('9000000005', { origin: ISSUER, returnTo, profile: { firstName: 'Gone', email: 'gone@example.com' } });
  assert.ok((await b.go(done.json.redirect)).final);
  await mongoose.connection.db.collection('users').deleteOne({ email: 'gone@example.com' });
  const again = await b.go(authorizeUrl());
  assert.equal(again.status, 200, again.text?.slice(0, 200));
  assert.match(again.text, /id="idp-login"/);
});

test('guest-checkout customer: Forgot Password -> set password -> logged in, no name asked', async () => {
  const email = 'guest.buyer@example.com';
  const before = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email, password: 'anything1' });
  assert.equal(before.status, 401);
  assert.match(before.json.error, /Forgot Password/);
  const f1 = await api('/api/login/forgot', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email });
  assert.equal(f1.json.step, 'otp');
  const f2 = await api('/api/login/otp/verify', { flowId: f1.json.flowId, code: lastCode(email) });
  assert.equal(f2.json.step, 'reset');
  const f3 = await api('/api/login/reset', { flowId: f1.json.flowId, password: 'guest1234' });
  assert.equal(f3.json.step, 'done', JSON.stringify(f3.json)); // straight in, Shopify already has the name
  const done = await finishFromStore(browser(), f3.json.redirect);
  const { claims } = await exchange(done.final);
  assert.equal(claims.email, email);
  assert.equal(claims.email_verified, true);
  assert.equal(claims.given_name, undefined); // nothing sent, so Shopify keeps the checkout name
  const again = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email, password: 'guest1234' });
  assert.equal(again.json.step, 'done');
});

test('guest-checkout customer: email OTP logs straight in, no name asked', async () => {
  const email = 'guest.otp@example.com';
  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, identifier: email });
  const v = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: lastCode(email) });
  assert.equal(v.json.step, 'done', JSON.stringify(v.json));
});

test('brand-new mobile customer still gives name + email on one screen', async () => {
  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000088' });
  const v = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: lastCode('+919000000088') });
  assert.equal(v.json.step, 'profile');
  assert.equal(v.json.needName, true);
  assert.equal(v.json.needEmail, true);
});

// ---------- admin panel ----------

const csrfOf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

test('admin: first setup needs the code from the terminal, then the panel opens', async () => {
  const b = browser();
  const first = await b.req('/admin');
  assert.equal(first.status, 303);
  assert.equal(first.location, '/admin/setup');
  assert.ok(adminSetupCode, 'setup code printed on startup');
  const wrong = await b.req('/admin/setup', { method: 'POST', form: { code: 'NOPE-NOPE', email: 'boss@example.com', password: 'boss12345' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Wrong setup code/);
  const ok = await b.req('/admin/setup', { method: 'POST', form: { code: adminSetupCode, name: 'Boss', email: 'boss@example.com', password: 'boss12345' } });
  assert.equal(ok.status, 303);
  const dash = await b.req('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Dashboard/);
  assert.match(dash.text, /Welcome! Your admin account is ready/);
  // setup page is closed now
  assert.equal((await browser().req('/admin/setup')).status, 303);
  // not signed in -> login page, and posts are refused
  const anon = browser();
  assert.equal((await anon.req('/admin/stores')).location, '/admin/login');
  assert.equal((await anon.req('/admin/stores/new', { method: 'POST', form: { id: 'x' } })).location, '/admin/login');
});

async function adminBrowser() {
  const b = browser();
  const r = await b.req('/admin/login', { method: 'POST', form: { email: 'boss@example.com', password: 'boss12345' } });
  assert.equal(r.status, 303, 'admin login');
  return b;
}

test('admin: wrong password is refused, logout ends the session', async () => {
  const bad = await browser().req('/admin/login', { method: 'POST', form: { email: 'boss@example.com', password: 'wrong999' } });
  assert.equal(bad.status, 401);
  const b = await adminBrowser();
  const page = await b.req('/admin');
  await b.req('/admin/logout', { method: 'POST', form: { _csrf: csrfOf(page.text) } });
  assert.equal((await b.req('/admin')).location, '/admin/login');
});

test('admin: add a store from the form -> client, snippet and drawer config work straight away', async () => {
  const b = await adminBrowser();
  const csrf = csrfOf((await b.req('/admin/stores/new')).text);
  const invalid = await b.req('/admin/stores/new', { method: 'POST', form: { _csrf: csrf, id: 'form-store', name: 'Form', shopDomain: 'form-store.myshopify.com', shopId: 'abc' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /Shop ID must be the number/);

  const made = await b.req('/admin/stores/new', {
    method: 'POST',
    form: {
      _csrf: csrf, id: 'form-store', name: 'Form Store', shopDomain: 'https://form-store.myshopify.com/', shopId: '333',
      domains: 'www.form.example', brandName: 'Form Brand', color: '#112233', tagline: 'Hi there', afterLogin: 'current',
    },
  });
  assert.equal(made.status, 303);
  assert.equal(made.location, '/admin/stores/form-store');
  const page = await b.req('/admin/stores/form-store');
  assert.match(page.text, /shop_form-store/);
  assert.match(page.text, /data-store=&quot;form-store&quot;|data-store="form-store"/);
  assert.match(page.text, /shopify\.com\/authentication\/333\/login\/external\/callback/);

  const cfg = await (await fetch(`${ISSUER}/api/login/config?store=form-store`, { headers: { origin: 'https://www.form.example' } })).json();
  assert.equal(cfg.brand.name, 'Form Brand');
  assert.equal(cfg.brand.color, '#112233');

  // Shopify can use the new client right away
  const auth = await browser().go(`/authorize?${new URLSearchParams({
    client_id: 'shop_form-store', redirect_uri: 'https://shopify.com/authentication/333/login/external/callback',
    response_type: 'code', scope: 'openid email', state: 's', nonce: 'n',
  })}`);
  assert.equal(auth.status, 200, auth.text.slice(0, 200));
  assert.match(auth.text, /data-store="form-store"/);

  // edit -> live
  const csrf2 = csrfOf(page.text);
  const saved = await b.req('/admin/stores/form-store', {
    method: 'POST',
    form: { _csrf: csrf2, name: 'Form Store', shopDomain: 'form-store.myshopify.com', shopId: '333', domains: 'www.form.example', brandName: 'Form Brand', tagline: 'Changed tagline', color: '#112233' },
  });
  assert.equal(saved.status, 303);
  const cfg2 = await (await fetch(`${ISSUER}/api/login/config?store=form-store`)).json();
  assert.equal(cfg2.brand.tagline, 'Changed tagline');

  // a domain already used by another store is refused
  const clash = await b.req('/admin/stores/form-store', {
    method: 'POST', form: { _csrf: csrf2, name: 'Form Store', shopDomain: 'form-store.myshopify.com', shopId: '333', domains: 'store.example' },
  });
  assert.equal(clash.status, 400);
  assert.match(clash.text, /Domain already used by store/);
});

test('admin: new client secret needs typed confirmation; delete store removes its client', async () => {
  const b = await adminBrowser();
  const page = await b.req('/admin/stores/form-store');
  const csrf = csrfOf(page.text);
  const coll = mongoose.connection.db.collection('oidc_client');
  const before = (await coll.findOne({ _id: 'shop_form-store' })).payload.client_secret;
  await b.req('/admin/stores/form-store/secret', { method: 'POST', form: { _csrf: csrf, confirm: 'nope' } });
  assert.equal((await coll.findOne({ _id: 'shop_form-store' })).payload.client_secret, before);
  await b.req('/admin/stores/form-store/secret', { method: 'POST', form: { _csrf: csrf, confirm: 'form-store' } });
  assert.notEqual((await coll.findOne({ _id: 'shop_form-store' })).payload.client_secret, before);
  const del = await b.req('/admin/stores/form-store/delete', { method: 'POST', form: { _csrf: csrf, confirm: 'form-store' } });
  assert.equal(del.location, '/admin/stores');
  assert.equal(await coll.findOne({ _id: 'shop_form-store' }), null);
  assert.equal((await fetch(`${ISSUER}/api/login/config?store=form-store`)).status, 404);
});

test('admin: forms without the session token are refused', async () => {
  const b = await adminBrowser();
  const r = await b.req('/admin/settings', { method: 'POST', form: { 'sms.template': 'HACKED {otp}' } });
  assert.equal(r.status, 303);
  const after = await b.req('/admin/settings');
  assert.match(after.text, /Your session expired/);
  assert.doesNotMatch(after.text, /HACKED/);
});

test('admin: settings save straight away, secrets are encrypted', async () => {
  const b = await adminBrowser();
  const csrf = csrfOf((await b.req('/admin/settings')).text);
  const r = await b.req('/admin/settings', {
    method: 'POST',
    form: { _csrf: csrf, 'sms.provider': 'console', 'sms.template': 'PANEL {otp} TEXT', 'sms.gupshup.password': 'pw-secret-123', 'otp.length': '6' },
  });
  assert.equal(r.status, 303);
  const shown = await b.req('/admin/settings');
  assert.match(shown.text, /Settings saved/, shown.text.match(/class="flash[^"]*"[^>]*>([^<]*)/)?.[1]);
  const doc = await mongoose.connection.db.collection('settings').findOne({ _id: 'settings' });
  assert.equal(doc.value['sms:template'], 'PANEL {otp} TEXT');
  assert.match(doc.value['sms:gupshup:password'], /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(doc), /pw-secret-123/);
  // the default SMS text is used for a store without its own text
  await api('/api/login/otp/send', { store: 'other-store', returnTo: 'https://other.example/customer_authentication/login', mobile: '9000000099' }, OTHER_ORIGIN);
  assert.match(lastSent('+919000000099').text, /PANEL \d{6} TEXT/);
  // a store with its own text keeps it
  await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000098' });
  assert.match(lastSent('+919000000098').text, /TEST \d{6} CODE/);
  // empty secret field keeps the saved one
  const csrf2 = csrfOf((await b.req('/admin/settings')).text);
  await b.req('/admin/settings', { method: 'POST', form: { _csrf: csrf2, 'sms.gupshup.password': '' } });
  const doc2 = await mongoose.connection.db.collection('settings').findOne({ _id: 'settings' });
  assert.equal(doc2.value['sms:gupshup:password'], doc.value['sms:gupshup:password']);
  // test SMS button
  const t = await b.req('/admin/settings/test-sms', { method: 'POST', form: { _csrf: csrf2, phone: '9000000097' } });
  assert.equal(t.status, 303);
  assert.match(lastSent('+919000000097').text, /PANEL \d{6} TEXT/);
});

test('admin: find a customer, block and unblock', async () => {
  const b = await adminBrowser();
  const list = await b.req('/admin/customers?q=asha');
  assert.match(list.text, /asha@example\.com/);
  const id = list.text.match(/href="\/admin\/customers\/([a-f0-9]{24})"/)[1];
  const page = await b.req(`/admin/customers/${id}`);
  const csrf = csrfOf(page.text);
  await b.req(`/admin/customers/${id}/block`, { method: 'POST', form: { _csrf: csrf } });
  const blocked = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com', password: 'newpass123' });
  assert.equal(blocked.status, 403);
  await b.req(`/admin/customers/${id}/unblock`, { method: 'POST', form: { _csrf: csrf } });
  const ok = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com', password: 'newpass123' });
  assert.equal(ok.json.step, 'done');
});

// ---------- separate customer lists per store ----------

const SEP_ORIGIN = 'https://sep.example';
const SEP_LOGIN = `${SEP_ORIGIN}/customer_authentication/login?return_to=%2F`;
const SEP_CALLBACK = 'https://shopify.com/authentication/444/login/external/callback';
const sepAuthorize = () => `/authorize?${new URLSearchParams({
  client_id: 'shop_sep-store', redirect_uri: SEP_CALLBACK, response_type: 'code', scope: 'openid email profile phone', state: 's', nonce: 'n',
})}`;

test('separate store: a new store gets its own customer list by default', async () => {
  const b = await adminBrowser();
  const form = await b.req('/admin/stores/new');
  assert.match(form.text, /Separate — only this store/);
  const made = await b.req('/admin/stores/new', {
    method: 'POST',
    form: { _csrf: csrfOf(form.text), id: 'sep-store', name: 'Sep Store', shopDomain: 'sep-store.myshopify.com', shopId: '444', domains: 'sep.example', customerGroup: '__own' },
  });
  assert.equal(made.status, 303);
  assert.equal(stores.get('sep-store').customerGroup, 'sep-store');
  assert.equal(stores.get('test-store').customerGroup, 'default'); // older stores keep sharing
  const list = await b.req('/admin/stores');
  assert.match(list.text, /separate/);
  assert.match(list.text, /shared/);
});

test('separate store: a known mobile number from another store signs up fresh (name + email asked)', async () => {
  const s = await api('/api/login/otp/send', { store: 'sep-store', returnTo: SEP_LOGIN, mobile: '9000000001' }, SEP_ORIGIN);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const v = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: lastCode('+919000000001') }, SEP_ORIGIN);
  assert.equal(v.json.step, 'profile', JSON.stringify(v.json));
  assert.equal(v.json.needName, true);
  assert.equal(v.json.needEmail, true);
  // the same email can exist once in each customer list
  const p = await api('/api/login/profile', { flowId: s.json.flowId, firstName: 'Asha', lastName: 'S', email: 'asha@example.com' }, SEP_ORIGIN);
  let done = p;
  if (p.json.step === 'otp') done = await api('/api/login/otp/verify', { flowId: s.json.flowId, code: lastCode('asha@example.com') }, SEP_ORIGIN);
  assert.equal(done.json.step, 'done', JSON.stringify(done.json));
  const users = await mongoose.connection.db.collection('users').find({ email: 'asha@example.com' }).toArray();
  assert.deepEqual(users.map((u) => u.group).sort(), ['default', 'sep-store']);
  const sepUser = users.find((u) => u.group === 'sep-store');
  assert.equal(sepUser.lastName, 'S');
  assert.equal(sepUser.passwordHash, undefined);

  // the drawer finishes into the new store's own account
  const hop = await browser().req(done.json.redirect);
  assert.equal(hop.status, 303);
  assert.equal(hop.location, SEP_LOGIN);
});

test('separate store: password from the other store does not work here', async () => {
  const r = await api('/api/login/password', { store: 'sep-store', returnTo: SEP_LOGIN, email: 'asha@example.com', password: 'newpass123' }, SEP_ORIGIN);
  assert.equal(r.status, 401);
  const ok = await api('/api/login/password', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com', password: 'newpass123' });
  assert.equal(ok.json.step, 'done');
});

test('separate store: being signed in on one store does not sign you in to the other', async () => {
  const b = browser();
  const page = await b.go(authorizeUrl());
  const returnTo = page.text.match(/data-return-to="([^"]+)"/)[1];
  const done = await mobileLogin('9000000001', { origin: ISSUER, returnTo });
  assert.ok((await b.go(done.json.redirect)).final, 'signed in on test-store');
  // same browser, other store -> its login page, not a silent login
  const other = await b.go(sepAuthorize());
  assert.equal(other.status, 200, other.final ? `silently went to ${other.final}` : other.text.slice(0, 200));
  assert.match(other.text, /data-store="sep-store"/);
  // and the same store still signs in silently
  assert.ok((await b.go(authorizeUrl())).final);
});

test('separate store: admin can switch a store to share customers, customers page shows the list', async () => {
  const b = await adminBrowser();
  const page = await b.req('/admin/stores/sep-store');
  assert.match(page.text, /<option value="default">Shared with [^<]*Test Store/);
  const saved = await b.req('/admin/stores/sep-store', {
    method: 'POST',
    form: { _csrf: csrfOf(page.text), name: 'Sep Store', shopDomain: 'sep-store.myshopify.com', shopId: '444', domains: 'sep.example', customerGroup: 'default' },
  });
  assert.equal(saved.status, 303);
  assert.equal(stores.get('sep-store').customerGroup, 'default');
  // saving without the field keeps the current list
  await b.req('/admin/stores/sep-store', {
    method: 'POST',
    form: { _csrf: csrfOf(page.text), name: 'Sep Store', shopDomain: 'sep-store.myshopify.com', shopId: '444', domains: 'sep.example' },
  });
  assert.equal(stores.get('sep-store').customerGroup, 'default');
  await b.req('/admin/stores/sep-store', {
    method: 'POST',
    form: { _csrf: csrfOf(page.text), name: 'Sep Store', shopDomain: 'sep-store.myshopify.com', shopId: '444', domains: 'sep.example', customerGroup: '__own' },
  });
  assert.equal(stores.get('sep-store').customerGroup, 'sep-store');
  const list = await b.req('/admin/customers?q=asha&group=sep-store');
  assert.match(list.text, /1 customer matching/);
});

test('upgrade: customers saved before customer lists existed join the shared list', async () => {
  const { migrateUsers } = await import('../src/db.js');
  const coll = mongoose.connection.db.collection('users');
  await coll.insertOne({ email: 'old@example.com', emailVerified: true, status: 'active', identities: [], stores: [] });
  await migrateUsers();
  assert.equal((await coll.findOne({ email: 'old@example.com' })).group, 'default');
  const r = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, identifier: 'old@example.com' });
  const v = await api('/api/login/otp/verify', { flowId: r.json.flowId, code: lastCode('old@example.com') });
  assert.equal(v.json.step, 'done', JSON.stringify(v.json));
});

// ---------- a store's own SMS / email / social keys ----------

async function saveTestStore(b, extra) {
  const page = await b.req('/admin/stores/test-store');
  return b.req('/admin/stores/test-store', {
    method: 'POST',
    form: {
      _csrf: csrfOf(page.text), name: 'Test Store', shopDomain: 'test-store.myshopify.com', shopId: '111',
      domains: 'store.example', brandName: 'Test Brand', tagline: 'Hello', color: '#123456', smsTemplate: 'TEST {otp} CODE', ...extra,
    },
  });
}

test('own keys: a store can use its own email account, secrets encrypted, others keep the default', async () => {
  const b = await adminBrowser();
  const page = await b.req('/admin/stores/test-store');
  assert.match(page.text, /SMS, email &amp; social login/);
  assert.match(page.text, /Use default from Settings/);
  // own email pointing at a closed port -> email OTP for this store fails fast with a clear reason
  const saved = await saveTestStore(b, {
    own_mail: '1', 'cred:mail.transport': 'smtp', 'cred:mail.from': 'Test <shop@example.com>',
    'cred:mail.smtp.host': '127.0.0.1', 'cred:mail.smtp.port': '1', 'cred:mail.smtp.secure__present': '1',
    'cred:mail.smtp.auth.user': 'shopuser', 'cred:mail.smtp.auth.pass': 'shop-secret-999',
  });
  assert.equal(saved.status, 303, saved.text.slice(0, 300));
  assert.equal(stores.get('test-store').own.mail, true);
  const doc = await mongoose.connection.db.collection('stores').findOne({ _id: 'test-store' });
  assert.match(doc.creds['mail:smtp:auth:pass'], /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(doc), /shop-secret-999/);

  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, identifier: 'own.mail@example.com' });
  assert.match(s.json.error || '', /couldn.t send the email/, JSON.stringify(s.json));
  assert.equal(lastCode('own.mail@example.com'), undefined); // nothing went to the default (console) sender
  // the other store still uses the default email
  const o = await api('/api/login/otp/send', { store: 'other-store', returnTo: 'https://other.example/customer_authentication/login', identifier: 'other.mail@example.com' }, OTHER_ORIGIN);
  assert.equal(o.json.step, 'otp');
  assert.ok(lastCode('other.mail@example.com'));

  // the store's test button reports the store's own server
  const t = await b.req('/admin/stores/test-store/test-email', { method: 'POST', form: { _csrf: csrfOf(page.text), email: 'x@example.com' } });
  assert.equal(t.status, 303);
  const after = await b.req('/admin/stores/test-store');
  assert.match(after.text, /Could not reach 127\.0\.0\.1:1/);

  // empty secret keeps the saved one; switching back to default works straight away
  await saveTestStore(b, { own_mail: '0', 'cred:mail.smtp.auth.pass': '' });
  const doc2 = await mongoose.connection.db.collection('stores').findOne({ _id: 'test-store' });
  assert.equal(doc2.creds['mail:smtp:auth:pass'], doc.creds['mail:smtp:auth:pass']);
  assert.equal(stores.get('test-store').own.mail, false);
  const ok = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, identifier: 'own.mail2@example.com' });
  assert.equal(ok.json.step, 'otp');
});

test('own keys: a store can use its own Google account or turn social logins off', async () => {
  const b = await adminBrowser();
  // own social with no keys -> no social buttons for this store, others unchanged
  await saveTestStore(b, { own_social: '1' });
  const cfg = await (await fetch(`${ISSUER}/api/login/config?store=test-store`, { headers: { origin: STORE_ORIGIN } })).json();
  assert.equal(cfg.social.google, false);
  const other = await (await fetch(`${ISSUER}/api/login/config?store=other-store`, { headers: { origin: OTHER_ORIGIN } })).json();
  assert.equal(other.social.google, true);
  const blocked = await browser().req(`/login/social/google?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  assert.equal(blocked.status, 400);

  // own Google client -> Google is asked with that client ID
  await saveTestStore(b, { own_social: '1', 'cred:google.clientId': 'store-google-id', 'cred:google.clientSecret': 'store-google-secret' });
  const cfg2 = await (await fetch(`${ISSUER}/api/login/config?store=test-store`, { headers: { origin: STORE_ORIGIN } })).json();
  assert.equal(cfg2.social.google, true);
  const start = await browser().req(`/login/social/google?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  assert.equal(start.status, 303);
  assert.equal(new URL(start.location).searchParams.get('client_id'), 'store-google-id');
  const otherStart = await browser().req(`/login/social/google?store=other-store&returnTo=${encodeURIComponent('https://other.example/customer_authentication/login')}`);
  assert.equal(new URL(otherStart.location).searchParams.get('client_id'), 'g-client');

  await saveTestStore(b, { own_social: '0' });
  const cfg3 = await (await fetch(`${ISSUER}/api/login/config?store=test-store`, { headers: { origin: STORE_ORIGIN } })).json();
  assert.equal(cfg3.social.google, true);
});

test('own keys: a store can use its own SMS account', async () => {
  const b = await adminBrowser();
  await saveTestStore(b, { own_sms: '1', 'cred:sms.provider': 'gupshup', 'cred:sms.gupshup.userId': '' });
  const s = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000071' });
  assert.match(s.json.error || '', /couldn.t send the SMS/); // its own Gupshup has no password -> not sent by the default console sender
  assert.equal(lastCode('+919000000071'), undefined);
  const page = await b.req('/admin/stores/test-store');
  await b.req('/admin/stores/test-store/test-sms', { method: 'POST', form: { _csrf: csrfOf(page.text), phone: '9000000072' } });
  assert.match((await b.req('/admin/stores/test-store')).text, /Gupshup user ID \/ password are not set/);
  await saveTestStore(b, { own_sms: '0' });
  const ok = await api('/api/login/otp/send', { store: 'test-store', returnTo: SHOPIFY_LOGIN, mobile: '9000000073' });
  assert.equal(ok.json.step, 'otp');
  assert.match(lastSent('+919000000073').text, /TEST \d{6} CODE/);
});

// ---------- a store's own login domain ----------

const DOM_ORIGIN = 'https://dom.example';
const DOM_LOGIN = `${DOM_ORIGIN}/customer_authentication/login?return_to=%2F`;
const DOM_CALLBACK = 'https://shopify.com/authentication/555/login/external/callback';
const domAuthorize = (base = LOGIN2) => `${base}/authorize?${new URLSearchParams({
  client_id: 'shop_dom-store', redirect_uri: DOM_CALLBACK, response_type: 'code', scope: 'openid email profile phone', state: 'sd', nonce: 'nd',
})}`;

test('login domain: a store can have its own login address with its own discovery document', async () => {
  const b = await adminBrowser();
  const form = await b.req('/admin/stores/new');
  assert.match(form.text, /Login domain/);
  const base = { _csrf: csrfOf(form.text), id: 'dom-store', name: 'Dom Store', shopDomain: 'dom-store.myshopify.com', shopId: '555', domains: 'dom.example' };
  const bad = await b.req('/admin/stores/new', { method: 'POST', form: { ...base, loginDomain: 'dom-store.myshopify.com' } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /not myshopify\.com/);
  const site = await b.req('/admin/stores/new', { method: 'POST', form: { ...base, loginDomain: 'dom.example' } });
  assert.match(site.text, /must be its own subdomain/);
  const made = await b.req('/admin/stores/new', { method: 'POST', form: { ...base, loginDomain: `127.0.0.1:${PORT}` } });
  assert.equal(made.status, 303, made.text.slice(0, 300));
  await mongoose.connection.db.collection('oidc_client').updateOne({ _id: 'shop_dom-store' }, { $set: { 'payload.client_secret': SECRET } });

  const page = await b.req('/admin/stores/dom-store');
  assert.match(page.text, /CNAME/);
  assert.ok(page.text.includes(`${LOGIN2}/.well-known/openid-configuration`));
  assert.match(page.text, /data-idp=(&quot;|")http:\/\/127\.0\.0\.1:3999/);
  const settings = await b.req('/admin/settings');
  assert.ok(settings.text.includes(`${LOGIN2}/social/google/callback`));

  const d2 = await (await fetch(`${LOGIN2}/.well-known/openid-configuration`)).json();
  assert.equal(d2.issuer, LOGIN2);
  assert.ok(d2.authorization_endpoint.startsWith(LOGIN2));
  const d1 = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  assert.equal(d1.issuer, ISSUER);

  await b.req('/admin/stores/dom-store/check-domain', { method: 'POST', form: { _csrf: csrfOf(page.text) } });
  assert.match((await b.req('/admin/stores/dom-store')).text, /is working and reaches this server/);
});

test('login domain: drawer login finishes on the store login address; Shopify gets tokens from it', async () => {
  const s1 = await api('/api/login/otp/send', { store: 'dom-store', returnTo: DOM_LOGIN, mobile: '9000000061' }, DOM_ORIGIN);
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  const v = await api('/api/login/otp/verify', { flowId: s1.json.flowId, code: lastCode('+919000000061') }, DOM_ORIGIN);
  assert.equal(v.json.step, 'profile');
  const p = await api('/api/login/profile', { flowId: s1.json.flowId, firstName: 'Dom', email: 'dom@example.com' }, DOM_ORIGIN);
  const done = await api('/api/login/otp/verify', { flowId: s1.json.flowId, code: lastCode('dom@example.com') }, DOM_ORIGIN);
  assert.equal(p.json.step, 'otp');
  assert.equal(done.json.step, 'done', JSON.stringify(done.json));
  assert.ok(done.json.redirect.startsWith(`${LOGIN2}/login/complete`), done.json.redirect);

  const br = browser();
  const hop = await br.req(done.json.redirect);
  assert.equal(hop.location, DOM_LOGIN);
  // Shopify's login -> /authorize on the store's login address -> straight back to Shopify
  const auth = await br.go(domAuthorize());
  assert.ok(auth.final, auth.text?.slice(0, 200));
  assert.equal(auth.final.origin + auth.final.pathname, DOM_CALLBACK);

  const res = await fetch(`${LOGIN2}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: auth.final.searchParams.get('code'), redirect_uri: DOM_CALLBACK, client_id: 'shop_dom-store', client_secret: SECRET,
    }),
  });
  const tokens = await res.json();
  assert.equal(res.status, 200, JSON.stringify(tokens));
  const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(`${LOGIN2}/jwks`)), { issuer: LOGIN2, audience: 'shop_dom-store' });
  assert.equal(payload.email, 'dom@example.com');
});

test('login domain: checkout Sign in page and Google run on the store login address', async () => {
  const br = browser();
  const pageRes = await br.go(domAuthorize());
  assert.equal(pageRes.status, 200, pageRes.text.slice(0, 200));
  assert.match(pageRes.text, /data-idp="http:\/\/127\.0\.0\.1:3999"/);
  const returnTo = pageRes.text.match(/data-return-to="([^"]+)"/)[1];
  assert.ok(returnTo.startsWith(`${LOGIN2}/interaction/`));

  const s1 = await api('/api/login/otp/send', { store: 'dom-store', returnTo, mobile: '9000000061' }, LOGIN2);
  assert.equal(s1.cors, LOGIN2);
  const v = await api('/api/login/otp/verify', { flowId: s1.json.flowId, code: lastCode('+919000000061') }, LOGIN2);
  assert.equal(v.json.step, 'done', JSON.stringify(v.json));
  assert.ok(v.json.redirect.startsWith(`${LOGIN2}/login/complete`));
  const back = await br.go(v.json.redirect);
  assert.ok(back.final, back.text?.slice(0, 200));
  assert.equal(back.final.origin + back.final.pathname, DOM_CALLBACK);

  const g = await browser().req(`${LOGIN2}/login/social/google?store=dom-store&returnTo=${encodeURIComponent(DOM_LOGIN)}`);
  assert.equal(g.status, 303);
  assert.equal(new URL(g.location).searchParams.get('redirect_uri'), `${LOGIN2}/social/google/callback`);
  // other stores keep the main address
  const g2 = await browser().req(`/login/social/google?store=test-store&returnTo=${encodeURIComponent(SHOPIFY_LOGIN)}`);
  assert.equal(new URL(g2.location).searchParams.get('redirect_uri'), `${ISSUER}/social/google/callback`);
});

test('admin: setup guide is in the panel', async () => {
  const b = await adminBrowser();
  const g = await b.req('/admin/guide');
  assert.equal(g.status, 200);
  assert.match(g.text, /Setup guide/);
  assert.match(g.text, /Shopify Plus/);
  assert.match(g.text, /data-copy-textarea/);
  assert.match((await b.req('/admin')).text, /href="\/admin\/guide"/);
});

test('forgot password: the new password must differ from the old one', async () => {
  const resetTo = async (password) => {
    const f1 = await api('/api/login/forgot', { store: 'test-store', returnTo: SHOPIFY_LOGIN, email: 'asha@example.com' });
    const f2 = await api('/api/login/otp/verify', { flowId: f1.json.flowId, code: lastCode('asha@example.com') });
    assert.equal(f2.json.step, 'reset');
    return { flowId: f1.json.flowId, res: await api('/api/login/reset', { flowId: f1.json.flowId, password }) };
  };
  const same = await resetTo('newpass123'); // current password
  assert.equal(same.res.status, 400);
  assert.match(same.res.json.error, /must be different from your old password/);
  // new password and confirmation must match
  const mismatch = await api('/api/login/reset', { flowId: same.flowId, password: 'other12345', confirmPassword: 'other12346' });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /passwords don.t match/);
  // the customer can pick another one in the same step
  const other = await api('/api/login/reset', { flowId: same.flowId, password: 'other12345', confirmPassword: 'other12345' });
  assert.equal(other.json.step, 'done');
  // and later go back to the earlier one (it is no longer the current password)
  assert.equal((await resetTo('newpass123')).res.json.step, 'done');
});
