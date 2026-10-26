// OpenID Connect server that Shopify talks to (discovery, /authorize, /token,
// /userinfo, /jwks, /logout). Uses the certified `oidc-provider` library,
// with all its data (sessions, codes, tokens, clients) stored in MongoDB.
import crypto from 'node:crypto';
import Provider, { errors, interactionPolicy } from 'oidc-provider';
import { exportJWK, generateKeyPair } from 'jose';
import { config } from './config.js';
import { db, User } from './db.js';
import { stores } from './stores.js';
import { issuerForRequest } from './issuers.js';
import { messagePage } from './pages.js';

// ---------- MongoDB storage for oidc-provider ----------

const GRANTABLE = ['access_token', 'authorization_code', 'refresh_token', 'device_code', 'backchannel_authentication_request'];
const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

class MongoAdapter {
  constructor(name) { this.name = snake(name); }

  coll(name = this.name) { return db().collection(`oidc_${name}`); }

  async upsert(_id, payload, expiresIn) {
    const $set = { payload };
    if (expiresIn) $set.expiresAt = new Date(Date.now() + expiresIn * 1000);
    await this.coll().updateOne({ _id }, { $set }, { upsert: true });
  }

  async find(_id) { return (await this.coll().findOne({ _id }))?.payload; }

  async findByUserCode(userCode) { return (await this.coll().findOne({ 'payload.userCode': userCode }))?.payload; }

  async findByUid(uid) { return (await this.coll().findOne({ 'payload.uid': uid }))?.payload; }

  async destroy(_id) { await this.coll().deleteOne({ _id }); }

  async revokeByGrantId(grantId) {
    await Promise.all(GRANTABLE.map((n) => this.coll(n).deleteMany({ 'payload.grantId': grantId })));
  }

  async consume(_id) {
    await this.coll().updateOne({ _id }, { $set: { 'payload.consumed': Math.floor(Date.now() / 1000) } });
  }

  static async ensureIndexes() {
    const models = ['session', 'access_token', 'authorization_code', 'refresh_token', 'client', 'interaction',
      'replay_detection', 'pushed_authorization_request', 'grant'];
    // An index that already exists with slightly different options (e.g. made
    // by an older version) is fine: keep it instead of failing to start.
    const ensure = (c, keys, opts) => c.createIndex(keys, opts).catch((e) => {
      if (e.code === 85 || e.code === 86) return;
      throw e;
    });
    await Promise.all(models.map(async (n) => {
      const c = db().collection(`oidc_${n}`);
      await ensure(c, { expiresAt: 1 }, { expireAfterSeconds: 0 });
      if (GRANTABLE.includes(n)) await ensure(c, { 'payload.grantId': 1 });
      if (n === 'session') await ensure(c, { 'payload.uid': 1 }, { unique: true, sparse: true });
    }));
  }
}

// ---------- ID token signing key (created once, kept in MongoDB) ----------

async function loadJwks() {
  const coll = db().collection('idp_signing_keys');
  let keys = await coll.find({}).sort({ createdAt: -1 }).toArray();
  if (!keys.length) {
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: crypto.randomUUID(), alg: 'RS256', use: 'sig' };
    await coll.insertOne({ _id: jwk.kid, jwk, createdAt: new Date() }).catch((e) => { if (e.code !== 11000) throw e; });
    keys = await coll.find({}).sort({ createdAt: -1 }).toArray();
  }
  return { keys: keys.map((k) => k.jwk) };
}

// A browser session for a customer who no longer exists (deleted, merged,
// blocked) must log in again instead of failing.
function loginPolicy() {
  const { base, Check } = interactionPolicy;
  const policy = base();
  policy.get('login').checks.add(new Check(
    'account_unavailable',
    'the signed-in account is no longer available',
    (ctx) => (ctx.oidc.session.accountId && !ctx.oidc.account ? Check.REQUEST_PROMPT : Check.NO_NEED_TO_PROMPT),
  ));
  // Signed in for a store with a different customer group: log in again here.
  policy.get('login').checks.add(new Check(
    'other_customer_group',
    'the signed-in customer belongs to another customer group',
    (ctx) => {
      const store = stores.byClientId(ctx.oidc.client?.clientId);
      const account = ctx.oidc.account;
      return store && account && account.group !== store.customerGroup ? Check.REQUEST_PROMPT : Check.NO_NEED_TO_PROMPT;
    },
  ));
  return policy;
}

// One OpenID provider per login address (default ISSUER + each store's login
// domain). They share the database, signing key and customers.
let jwks;
const providers = new Map(); // issuer -> { provider, handler }

/** Startup: database indexes and the signing key. */
export async function initOidc() {
  await MongoAdapter.ensureIndexes();
  jwks = await loadJwks();
}

function entryFor(issuer) {
  if (!providers.has(issuer)) {
    const provider = buildProvider(issuer);
    providers.set(issuer, { provider, handler: provider.callback() });
  }
  return providers.get(issuer);
}

/** The provider for the login address this request came in on. */
export const providerFor = (req) => entryFor(issuerForRequest(req)).provider;
/** Express handler: discovery, /authorize, /token, /userinfo, /jwks, /logout. */
export const oidcHandler = () => (req, res, next) => entryFor(issuerForRequest(req)).handler(req, res, next);

function buildProvider(issuer) {
  const provider = new Provider(issuer, {
    adapter: MongoAdapter,
    jwks,
    cookies: {
      keys: config.cookieKeys,
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.isProd },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.isProd },
    },
    clients: [], // one client per store, kept in MongoDB by `npm run store -- setup`
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      id_token_signed_response_alg: 'RS256',
    },
    clientAuthMethods: ['client_secret_post', 'client_secret_basic'],
    responseTypes: ['code'],
    scopes: ['openid', 'email', 'profile', 'phone', 'address', 'offline_access'],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'given_name', 'family_name', 'urn:shopify:customer:tags'],
      phone: ['phone_number', 'phone_number_verified'],
      address: ['address'],
    },
    conformIdTokenClaims: false, // Shopify reads customer data from the ID token

    async findAccount(ctx, id) {
      const user = await User.findById(id).catch(() => null);
      if (!user || !user.canSignIntoShopify()) return undefined;
      return { accountId: user.id, group: user.group, claims: async () => user.oidcClaims() };
    },

    interactions: {
      policy: loginPolicy(),
      url: (ctx, interaction) => `/interaction/${interaction.uid}`,
    },

    // First-party login: grant every requested scope without a consent screen.
    async loadExistingGrant(ctx) {
      if (!ctx.oidc.session?.accountId) return undefined;
      const grantId = ctx.oidc.result?.consent?.grantId || ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId);
      const grant = (grantId && await ctx.oidc.provider.Grant.find(grantId))
        || new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client.clientId, accountId: ctx.oidc.session.accountId });
      grant.addOIDCScope('openid email profile phone address offline_access');
      grant.addOIDCClaims(['email', 'email_verified', 'given_name', 'family_name', 'name']);
      await grant.save();
      return grant;
    },

    issueRefreshToken: async (ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    pkce: { required: () => false },

    routes: {
      authorization: '/authorize',
      token: '/token',
      userinfo: '/userinfo',
      jwks: '/jwks',
      end_session: '/logout',
      revocation: '/token/revocation',
      introspection: '/token/introspection',
    },

    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // Shopify starts the logout, so sign out without asking.
        async logoutSource(ctx, form) {
          ctx.body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing out…</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:80px;color:#374151">
<p>Signing you out…</p>${form}
<noscript><button type="submit" form="op.logoutForm" name="logout" value="yes">Continue</button></noscript>
<script>(function(){var f=document.getElementById('op.logoutForm');var i=document.createElement('input');i.type='hidden';i.name='logout';i.value='yes';f.appendChild(i);f.submit();})();</script>
</body></html>`;
        },
        async postLogoutSuccessSource(ctx) {
          ctx.body = messagePage({ title: 'Signed out', message: 'You have been signed out.' });
        },
      },
    },

    ttl: {
      AccessToken: config.ttl.accessToken,
      IdToken: config.ttl.idToken,
      AuthorizationCode: 600,
      Interaction: 3600,
      Grant: config.ttl.refreshToken,
      RefreshToken: config.ttl.refreshToken,
      Session: config.ttl.session,
    },

    async renderError(ctx, out) {
      console.warn('[oidc] error', out);
      ctx.type = 'html';
      ctx.body = messagePage({
        title: 'Something went wrong',
        message: out.error_description || 'Please go back to the store and try signing in again.',
        store: stores.byClientId(ctx.oidc?.client?.clientId),
      });
    },
  });

  provider.proxy = true; // behind ngrok / Nginx / Render / Railway etc.
  provider.on('server_error', (ctx, err) => console.error('[oidc] server_error', err));
  provider.on('grant.error', (ctx, err) => {
    if (!(err instanceof errors.InvalidGrant) && !(err instanceof errors.InvalidClientAuth)) console.error('[oidc] grant.error', err);
  });
  return provider;
}
