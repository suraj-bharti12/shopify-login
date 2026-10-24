// Google, Apple (OpenID Connect via openid-client) and Facebook (OAuth 2.0).
// Each provider returns a normalized profile:
// { provider, providerUserId, email, emailVerified, firstName, lastName }
import * as oidc from 'openid-client';
import { SignJWT, importPKCS8 } from 'jose';
import crypto from 'node:crypto';
import { config } from './config.js';

export const callbackUrl = (provider) => `${config.issuer}/social/${provider}/callback`;

const discovered = {};
async function serverMetadata(issuerUrl) {
  if (!discovered[issuerUrl]) {
    const c = await oidc.discovery(new URL(issuerUrl), 'discovery-only');
    discovered[issuerUrl] = c.serverMetadata();
  }
  return discovered[issuerUrl];
}

let appleSecretCache;
// Called when Apple keys change in the admin panel.
export function resetSocialCache() { appleSecretCache = undefined; }
async function appleClientSecret() {
  if (appleSecretCache && appleSecretCache.exp > Date.now() + 60_000) return appleSecretCache.jwt;
  const key = await importPKCS8(config.apple.privateKey, 'ES256');
  const expSeconds = 60 * 60; // 1 hour (Apple allows up to 6 months)
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.apple.keyId })
    .setIssuer(config.apple.teamId)
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .setAudience('https://appleid.apple.com')
    .setSubject(config.apple.clientId)
    .sign(key);
  appleSecretCache = { jwt, exp: Date.now() + expSeconds * 1000 };
  return jwt;
}

async function oidcConfig(provider) {
  if (provider === 'google') {
    const md = await serverMetadata('https://accounts.google.com');
    return new oidc.Configuration(md, config.google.clientId, config.google.clientSecret, oidc.ClientSecretPost(config.google.clientSecret));
  }
  if (provider === 'apple') {
    const md = await serverMetadata('https://appleid.apple.com');
    const secret = await appleClientSecret();
    return new oidc.Configuration(md, config.apple.clientId, secret, oidc.ClientSecretPost(secret));
  }
  throw new Error(`Not an OIDC provider: ${provider}`);
}

/**
 * Returns { url, checks } — store `checks` in a cookie, redirect to `url`.
 */
export async function startSocialLogin(provider) {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const checks = { provider, state, nonce, verifier };

  if (provider === 'facebook') {
    const u = new URL(`https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth`);
    u.searchParams.set('client_id', config.facebook.appId);
    u.searchParams.set('redirect_uri', callbackUrl('facebook'));
    u.searchParams.set('state', state);
    u.searchParams.set('scope', 'email,public_profile');
    u.searchParams.set('response_type', 'code');
    return { url: u.toString(), checks };
  }

  const cfg = await oidcConfig(provider);
  const params = {
    redirect_uri: callbackUrl(provider),
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
export async function finishSocialLogin(provider, query, checks) {
  if (!checks || checks.provider !== provider) throw new Error('Login session expired. Please try again.');
  if (query.error) throw new Error(query.error_description || 'Sign-in was cancelled.');

  if (provider === 'facebook') return finishFacebook(query, checks);

  const cfg = await oidcConfig(provider);
  const cbUrl = new URL(callbackUrl(provider));
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

async function finishFacebook(query, checks) {
  if (!query.state || query.state !== checks.state) throw new Error('Login session expired. Please try again.');
  const v = config.facebook.graphVersion;
  const tokenUrl = new URL(`https://graph.facebook.com/${v}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', config.facebook.appId);
  tokenUrl.searchParams.set('client_secret', config.facebook.appSecret);
  tokenUrl.searchParams.set('redirect_uri', callbackUrl('facebook'));
  tokenUrl.searchParams.set('code', String(query.code || ''));
  const tRes = await fetch(tokenUrl);
  const t = await tRes.json();
  if (!tRes.ok || !t.access_token) throw new Error(t.error?.message || 'Facebook sign-in failed.');

  const proof = crypto.createHmac('sha256', config.facebook.appSecret).update(t.access_token).digest('hex');
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
    emailVerified: Boolean(me.email) && config.facebook.trustEmail,
    firstName: me.first_name,
    lastName: me.last_name,
  };
}
