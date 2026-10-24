// Stores served by this login server. They live in MongoDB and are managed
// from the admin panel (/admin). Old stores/<id>.json files are imported once
// on startup, so earlier setups keep working.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, enabledSocial } from './config.js';
import { db, Store, Setting } from './db.js';

const DIR = config.storesDir
  ? path.resolve(config.storesDir)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'stores');

export const CLIENT_PREFIX = 'shop_';

export const DEFAULT_BRAND = {
  welcome: 'Welcome to', name: 'My Store', logoUrl: '', tagline: '', color: '#111111', supportEmail: '',
};

export class StoreError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

export const cleanHost = (v) => String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
const unique = (a) => [...new Set(a.filter(Boolean))];

/** Checks raw store data and works out everything else. Throws StoreError. */
export function normalize(raw) {
  const id = String(raw.id || raw._id || '').trim();
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new StoreError('id', 'Store ID: 2-40 lowercase letters, numbers or dashes (e.g. berrylush06).');
  const shopDomain = cleanHost(raw.shopDomain);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain)) throw new StoreError('shopDomain', 'Shopify domain must look like your-store.myshopify.com');
  const shopId = String(raw.shopId || '').trim();
  if (!/^\d+$/.test(shopId)) throw new StoreError('shopId', 'Shop ID must be the number in Shopify\'s callback URL (shopify.com/<number>/...).');
  const color = String(raw.brand?.color || '').trim();
  if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new StoreError('color', 'Color must look like #8b1d24');
  const logoUrl = String(raw.brand?.logoUrl || '').trim();
  if (logoUrl && !/^https:\/\//.test(logoUrl)) throw new StoreError('logoUrl', 'Logo URL must start with https://');
  // Customer group: stores with the same group share customers.
  const customerGroup = String(raw.customerGroup || 'default').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(customerGroup)) throw new StoreError('customerGroup', 'Customer group: 2-40 lowercase letters, numbers or dashes.');
  const urls = (list, field) => (list || []).map((u) => String(u).trim()).filter(Boolean).map((u) => {
    if (!/^https:\/\/[^\s]+$/.test(u)) throw new StoreError(field, `Not a valid https URL: ${u}`);
    return u;
  });

  const handle = shopDomain.replace('.myshopify.com', '');
  const domains = unique([shopDomain, ...(raw.domains || []).map(cleanHost)]);
  const accountDomain = cleanHost(raw.accountDomain) || `${handle}.account.myshopify.com`;
  const brand = { ...DEFAULT_BRAND };
  for (const k of Object.keys(DEFAULT_BRAND)) {
    const v = raw.brand?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') brand[k] = String(v).trim();
  }
  if (!raw.brand?.name) brand.name = raw.name || id;

  return {
    id,
    name: String(raw.name || id).trim(),
    shopDomain,
    shopId,
    domains: domains.filter((d) => d !== shopDomain),
    accountDomain: cleanHost(raw.accountDomain),
    extraRedirectUris: urls(raw.extraRedirectUris, 'extraRedirectUris'),
    extraLogoutUris: urls(raw.extraLogoutUris, 'extraLogoutUris'),
    clientId: `${CLIENT_PREFIX}${id}`,
    origins: domains.map((d) => `https://${d}`),
    afterLogin: raw.afterLogin === 'account' ? 'account' : 'current',
    brand,
    smsTemplate: String(raw.smsTemplate || '').trim() || undefined, // empty = default from Settings
    customerGroup,
    // URLs Shopify sends customers back to (shown on Shopify's
    // "Connect to identity provider" screen).
    redirectUris: unique([
      `https://${accountDomain}/authentication/login/external/callback`,
      `https://shopify.com/authentication/${shopId}/login/external/callback`,
      ...urls(raw.extraRedirectUris, 'extraRedirectUris'),
    ]),
    logoutUris: unique([
      ...domains.map((d) => `https://${d}/customer_authentication/logout/callback`),
      `https://shopify.com/${shopId}/account/logout_callback`,
      `https://${accountDomain}/logout_callback`,
      ...urls(raw.extraLogoutUris, 'extraLogoutUris'),
    ]),
  };
}

// The raw fields we save in MongoDB.
function toDoc(s) {
  return {
    _id: s.id,
    name: s.name,
    shopDomain: s.shopDomain,
    shopId: s.shopId,
    domains: s.domains,
    accountDomain: s.accountDomain,
    extraRedirectUris: s.extraRedirectUris,
    extraLogoutUris: s.extraLogoutUris,
    afterLogin: s.afterLogin,
    brand: s.brand,
    smsTemplate: s.smsTemplate || '',
    customerGroup: s.customerGroup,
  };
}

/** Customer groups in use: { group: [store, ...] } */
export function customerGroups() {
  const out = {};
  for (const s of stores.all()) (out[s.customerGroup] ||= []).push(s);
  return out;
}

let cache = new Map();

export const stores = {
  dir: DIR,
  async reload() {
    const map = new Map();
    for (const doc of await Store.find({}).sort({ _id: 1 }).lean()) {
      try {
        map.set(doc._id, normalize({ ...doc, id: doc._id }));
      } catch (e) {
        console.error(`[stores] "${doc._id}" has invalid settings and is skipped: ${e.message}`);
      }
    }
    cache = map;
    return this.all();
  },
  all: () => [...cache.values()],
  get: (id) => cache.get(String(id || '')),
  byClientId: (clientId) => (String(clientId || '').startsWith(CLIENT_PREFIX)
    ? cache.get(String(clientId).slice(CLIENT_PREFIX.length)) : undefined),
  byOrigin: (origin) => [...cache.values()].find((s) => s.origins.includes(origin)),
  // Used for pages that are not tied to a store (errors, /dev test page).
  fallback: () => cache.values().next().value
    || normalize({ id: 'default', shopDomain: 'default.myshopify.com', shopId: '0', brand: { name: 'Login' } }),
};

// What the login widget needs to know about a store.
export function publicConfig(store) {
  return {
    store: store.id,
    brand: store.brand,
    social: enabledSocial,
    countryCode: config.defaultCountryCode,
    otpLength: config.otp.length,
    resendSeconds: config.otp.resendCooldownSeconds,
    afterLogin: store.afterLogin,
  };
}

// The OIDC client document (one per store) as oidc-provider expects it.
export function clientPayload(store, secret) {
  return {
    client_id: store.clientId,
    client_secret: secret,
    client_name: store.name,
    redirect_uris: store.redirectUris,
    post_logout_redirect_uris: store.logoutUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  };
}

const newSecret = () => crypto.randomBytes(32).toString('base64url');

/** Creates or updates the store's login client. Returns its secret. */
export async function syncClient(store, { rotateSecret = false } = {}) {
  const coll = db().collection('oidc_client');
  const doc = await coll.findOne({ _id: store.clientId });
  const secret = (!doc || rotateSecret) ? newSecret() : doc.payload.client_secret;
  await coll.updateOne({ _id: store.clientId }, { $set: { payload: clientPayload(store, secret) } }, { upsert: true });
  return secret;
}

export async function clientSecret(store) {
  const doc = await db().collection('oidc_client').findOne({ _id: store.clientId });
  return doc?.payload?.client_secret;
}

/** Saves a store (new or edited) and its login client. Throws StoreError. */
export async function saveStore(raw, { isNew }) {
  const store = normalize(raw);
  if (isNew && await Store.exists({ _id: store.id })) throw new StoreError('id', `A store with ID "${store.id}" already exists.`);
  const clash = stores.all().find((s) => s.id !== store.id && s.origins.some((o) => store.origins.includes(o)));
  if (clash) throw new StoreError('domains', `Domain already used by store "${clash.id}".`);
  await Store.updateOne({ _id: store.id }, { $set: toDoc(store) }, { upsert: true });
  await stores.reload();
  await syncClient(stores.get(store.id));
  return stores.get(store.id);
}

export async function deleteStore(id) {
  const store = stores.get(id);
  await Store.deleteOne({ _id: id });
  if (store) await db().collection('oidc_client').deleteOne({ _id: store.clientId });
  await stores.reload();
}

// Startup: import stores/*.json once (files starting with "_" are skipped),
// load stores, and keep every store's login client up to date.
export async function initStores() {
  const done = new Set((await Setting.findById('importedStoreFiles').lean())?.value || []);
  if (fs.existsSync(DIR)) {
    for (const file of fs.readdirSync(DIR).sort()) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const id = path.basename(file, '.json');
      if (done.has(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
        const store = normalize({ id, ...raw });
        if (!await Store.exists({ _id: store.id })) {
          await Store.create(toDoc(store));
          console.log(`[stores] imported stores/${file} into the database`);
        }
        done.add(file);
      } catch (e) {
        console.error(`[stores] could not import stores/${file}: ${e.message}`);
      }
    }
    await Setting.updateOne({ _id: 'importedStoreFiles' }, { $set: { value: [...done] } }, { upsert: true });
  }
  await stores.reload();
  for (const store of stores.all()) await syncClient(store);
}
