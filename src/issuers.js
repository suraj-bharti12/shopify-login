// Login addresses ("issuers"). The server has one default address (ISSUER in
// .env, also used for the admin panel). A store can have its own login domain,
// e.g. login.berrylush.com: Shopify, the theme snippet and Google then use that
// address for this store. All addresses point at this same server.
import { config } from './config.js';
import { stores } from './stores.js';

const PROTO = new URL(config.issuer).protocol;
export const DEFAULT_ORIGIN = new URL(config.issuer).origin;

/** The login address a store's customers and Shopify use. */
export const issuerFor = (store) => (store?.loginDomain ? `${PROTO}//${store.loginDomain}` : config.issuer);

export const requestHost = (req) => String(req.get('x-forwarded-host') || req.get('host') || '')
  .split(',')[0].trim().toLowerCase();

const isLoginDomain = (host) => Boolean(host) && stores.all().some((s) => s.loginDomain === host);

/** The login address this request came in on (unknown hosts -> the default). */
export const issuerForRequest = (req) => {
  const host = requestHost(req);
  return isLoginDomain(host) ? `${PROTO}//${host}` : config.issuer;
};

/** Origins of every login address in use (the hosted login page runs on these). */
export const loginOrigins = () => new Set([DEFAULT_ORIGIN, ...stores.all().map((s) => new URL(issuerFor(s)).origin)]);
