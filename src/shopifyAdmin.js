// Read-only access to a store's Shopify Admin API, used to find a guest-checkout
// customer by the mobile number they typed at checkout.
//
// The store owner creates an app in Shopify's Dev Dashboard (same organization as
// the store) with the read_customers scope, installs it, and pastes its Client ID
// and Client secret into the store's settings here. Tokens come from the client
// credentials grant and last 24 hours; they are cached in memory.
import { decrypt } from './settings.js';
import { normalizePhone } from './users.js';

const API_VERSION = '2026-10';
const tokens = new Map(); // store id -> { key, token, expiresAt }

export class ShopifyApiError extends Error {}

export const adminApiReady = (store) => Boolean(store?.adminApi?.clientId && store?.adminApi?.clientSecret);

async function accessToken(store) {
  const clientId = store.adminApi.clientId;
  const secret = decrypt(store.adminApi.clientSecret);
  if (!secret) throw new ShopifyApiError('The Client secret could not be read. Enter it again in the store settings.');
  const key = `${clientId}|${store.adminApi.clientSecret}`;
  const cached = tokens.get(store.id);
  if (cached && cached.key === key && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`https://${store.shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const why = body.error_description || body.error || `HTTP ${res.status}`;
    if (/shop_not_permitted/i.test(why)) {
      throw new ShopifyApiError('Shopify refused the token: the app must be created in the Dev Dashboard of the organization that owns this store, and installed on it.');
    }
    if (/invalid_client|unauthorized/i.test(why) || res.status === 401) {
      throw new ShopifyApiError('Shopify rejected the Client ID or Client secret. Copy them again from the app\'s Settings in the Dev Dashboard.');
    }
    throw new ShopifyApiError(`Shopify did not issue a token (${why}). Check that the app is installed on ${store.shopDomain}.`);
  }
  tokens.set(store.id, { key, token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 });
  return body.access_token;
}

async function graphql(store, query, variables) {
  const res = await fetch(`https://${store.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': await accessToken(store) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) tokens.delete(store.id);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShopifyApiError(`Shopify API error (HTTP ${res.status}).`);
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    if (/access denied|read_customers|not approved/i.test(msg)) {
      throw new ShopifyApiError(`The app can't read customers: give it the read_customers scope and access to protected customer data (name, email, phone, address), then approve the update on the store. (${msg})`);
    }
    throw new ShopifyApiError(`Shopify API error: ${msg}`);
  }
  return body.data;
}

const CUSTOMER_FIELDS = `id firstName lastName
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }
  defaultAddress { phone }
  addressesV2(first: 10) { nodes { phone } }`;

/**
 * Shopify customers whose own phone or one of whose saved addresses has this
 * mobile number. Returns [{ id, email, firstName, lastName }] (only customers
 * with an email). The match is checked here, not left to Shopify's search.
 */
export async function findCustomersByPhone(store, phone) {
  const digits = phone.replace(/\D/g, '');
  const local = digits.slice(-10);
  const search = `phone:"${phone}" OR "${phone}" OR "${local}"`;
  const data = await graphql(store, `query ($q: String!) { customers(first: 20, query: $q) { nodes { ${CUSTOMER_FIELDS} } } }`, { q: search });
  const same = (v) => Boolean(v) && normalizePhone(v) === phone;
  const out = [];
  for (const c of data?.customers?.nodes || []) {
    const phones = [c.defaultPhoneNumber?.phoneNumber, c.defaultAddress?.phone, ...(c.addressesV2?.nodes || []).map((a) => a.phone)];
    const email = c.defaultEmailAddress?.emailAddress?.toLowerCase();
    if (email && phones.some(same) && !out.some((o) => o.email === email)) {
      out.push({ id: c.id, email, firstName: c.firstName || '', lastName: c.lastName || '' });
    }
  }
  return out;
}

/** Admin panel "Test": checks the keys and runs a lookup. */
export async function testLookup(store, phone) {
  const shop = await graphql(store, '{ shop { name } }');
  const found = phone ? await findCustomersByPhone(store, phone) : null;
  return { shopName: shop?.shop?.name, found };
}

export const forgetToken = (storeId) => tokens.delete(storeId);
