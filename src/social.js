// Google, Apple (OpenID Connect via openid-client) and Facebook (OAuth 2.0).
// Each provider returns a normalized profile:
// { provider, providerUserId, email, emailVerified, firstName, lastName }
import * as oidc from 'openid-client';
import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import { config } from './config.js';

// Google etc. send the customer back to the login address the sign-in started on.
export const callbackUrl = (provider, issuer = config.issuer) => `${issuer}/social/${provider}/callback`;

const discovered = {};
async function serverMetadata(issuerUrl) {
  if (!discovered[issuerUrl]) {
    const c = await oidc.discovery(new URL(issuerUrl), 'discovery-only');
    discovered[issuerUrl] = c.serverMetadata();
  }
  return discovered[issuerUrl];
}

// `keys` below is { google, facebook, apple }: the Settings keys, or a store's
// own keys (settings.forStore).
const appleSecrets = new Map();
// Called when Apple keys change in the admin panel.
export function resetSocialCache() { appleSecrets.clear(); }
async function appleClientSecret(apple) {
  const id = `${apple.teamId}|${apple.keyId}|${apple.clientId}`;
  const cached = appleSecrets.get(id);
  if (cached && cached.exp > Date.now() + 60_000) return cached.jwt;
  const key = await importPKCS8(apple.privateKey, 'ES256');
  const expSeconds = 60 * 60; // 1 hour (Apple allows up to 6 months)
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .setAudience('https://appleid.apple.com')
    .setSubject(apple.clientId)
    .sign(key);
  appleSecrets.set(id, { jwt, exp: Date.now() + expSeconds * 1000 });
  return jwt;
}

async function oidcConfig(provider, keys) {
  if (provider === 'google') {
    const md = await serverMetadata('https://accounts.google.com');
    return new oidc.Configuration(md, keys.google.clientId, keys.google.clientSecret, oidc.ClientSecretPost(keys.google.clientSecret));
  }
  if (provider === 'apple') {
    const md = await serverMetadata('https://appleid.apple.com');
    const secret = await appleClientSecret(keys.apple);
    return new oidc.Configuration(md, keys.apple.clientId, secret, oidc.ClientSecretPost(secret));
  }
  throw new Error(`Not an OIDC provider: ${provider}`);
}

/**
 * Returns { url, checks } — store `checks` in a cookie, redirect to `url`.
 */
export async function startSocialLogin(provider, keys = config, issuer = config.issuer) {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const checks = { provider, state, nonce, verifier, issuer };

  if (provider === 'facebook') {
    const u = new URL(`https://www.facebook.com/${keys.facebook.graphVersion}/dialog/oauth`);
    u.searchParams.set('client_id', keys.facebook.appId);
    u.searchParams.set('redirect_uri', callbackUrl('facebook', issuer));
    u.searchParams.set('state', state);
    u.searchParams.set('scope', 'email,public_profile');
    u.searchParams.set('response_type', 'code');
    return { url: u.toString(), checks };
  }

  const cfg = await oidcConfig(provider, keys);
  const params = {
    redirect_uri: callbackUrl(provider, issuer),
    scope: provider === 'apple' ? 'openid name email' : 'openid email profile',
    state,
    nonce,
  };
  if (provider === 'google') {
    params.code_challenge = await oidc.calculatePKCECodeChallenge(verifier);
    params.code_challenge_method = 'S256';
    params.prompt = 'select_account';
  }
  if (provider === 'apple') params.response_mode = 'form_post';
  return { url: oidc.buildAuthorizationUrl(cfg, params).toString(), checks };
}

/**
 * Exchanges the callback params for a normalized profile.
 * `query` is the callback's params (code, state, ... and Apple's `user`).
 */
export async function finishSocialLogin(provider, query, checks, keys = config) {
  if (!checks || checks.provider !== provider) throw new Error('Login session expired. Please try again.');
  if (query.error) throw new Error(query.error_description || 'Sign-in was cancelled.');

  if (provider === 'facebook') return finishFacebook(query, checks, keys.facebook);

  const cfg = await oidcConfig(provider, keys);
  const cbUrl = new URL(callbackUrl(provider, checks.issuer));
  for (const [k, v] of Object.entries(query)) {
    if (['code', 'state', 'iss', 'scope', 'authuser', 'prompt', 'hd'].includes(k)) cbUrl.searchParams.set(k, v);
  }
  const tokens = await oidc.authorizationCodeGrant(cfg, cbUrl, {
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    pkceCodeVerifier: provider === 'google' ? checks.verifier : undefined,
    idTokenExpected: true,
  });
  const c = tokens.claims();

  let firstName = c.given_name;
  let lastName = c.family_name;
  if (provider === 'apple' && query.user) {
    // Apple sends the name only on the very first sign-in.
    try {
      const u = JSON.parse(query.user);
      firstName = u?.name?.firstName;
      lastName = u?.name?.lastName;
    } catch { /* ignore */ }
  }

  return {
    provider,
    providerUserId: String(c.sub),
    email: c.email ? String(c.email).toLowerCase() : undefined,
    emailVerified: c.email_verified === true || c.email_verified === 'true',
    firstName,
    lastName,
  };
}

async function finishFacebook(query, checks, fb) {
  if (!query.state || query.state !== checks.state) throw new Error('Login session expired. Please try again.');
  const v = fb.graphVersion;
  const tokenUrl = new URL(`https://graph.facebook.com/${v}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', fb.appId);
  tokenUrl.searchParams.set('client_secret', fb.appSecret);
  tokenUrl.searchParams.set('redirect_uri', callbackUrl('facebook', checks.issuer));
  tokenUrl.searchParams.set('code', String(query.code || ''));
  const tRes = await fetch(tokenUrl);
  const t = await tRes.json();
  if (!tRes.ok || !t.access_token) throw new Error(t.error?.message || 'Facebook sign-in failed.');

  const proof = crypto.createHmac('sha256', fb.appSecret).update(t.access_token).digest('hex');
  const meUrl = new URL(`https://graph.facebook.com/${v}/me`);
  meUrl.searchParams.set('fields', 'id,email,first_name,last_name');
  meUrl.searchParams.set('access_token', t.access_token);
  meUrl.searchParams.set('appsecret_proof', proof);
  const mRes = await fetch(meUrl);
  const me = await mRes.json();
  if (!mRes.ok || !me.id) throw new Error(me.error?.message || 'Could not read your Facebook profile.');

  return {
    provider: 'facebook',
    providerUserId: String(me.id),
    email: me.email ? String(me.email).toLowerCase() : undefined,
    emailVerified: Boolean(me.email) && fb.trustEmail,
    firstName: me.first_name,
    lastName: me.last_name,
  };
}
