// Everything a customer does to log in. The same JSON API serves:
//   - the drawer inside the Shopify theme (store pages), and
//   - the hosted login page (checkout "Sign in", direct Shopify login).
//
// A login always ends the same way: a one-time ticket -> /login/complete sets
// a short "autologin" cookie -> browser goes to Shopify's login (or back to
// /interaction/:uid) -> /authorize finishes instantly with that customer.
import express from 'express';
import crypto from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { config, enabledSocial } from './config.js';
import { User, Otp, LoginFlow, LoginTicket } from './db.js';
import { stores, publicConfig } from './stores.js';
import { issueOtp, verifyOtp, OtpError, maskTarget } from './otp.js';
import { startSocialLogin, finishSocialLogin } from './social.js';
import {
  normalizeEmail, normalizePhone, looksLikeEmail, passwordProblem, cleanName,
  attachVerifiedEmail, upsertSocialUser, recordLogin,
} from './users.js';
import { loginPage, messagePage } from './pages.js';

class LoginError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const FLOW_TTL = 30 * 60_000;
const TICKET_TTL = 2 * 60_000;
const AUTOLOGIN_TTL = 5 * 60_000;
const COOKIE = { autologin: 'idp_autologin', social: 'idp_social' };
const ISSUER_ORIGIN = new URL(config.issuer).origin;

const token = () => crypto.randomBytes(24).toString('base64url');
const cookieOpts = (maxAge) => ({ httpOnly: true, signed: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge });
const readCookie = (req, name) => { try { return JSON.parse(req.signedCookies?.[name] || 'null'); } catch { return null; } };
const later = (ms) => new Date(Date.now() + ms);

// Pages of this store (or Shopify's own pages) may call the API for it.
const originAllowed = (origin, store) => origin === ISSUER_ORIGIN || store.origins.includes(origin);

// Where may a login for `store` send the browser afterwards?
function safeReturnTo(store, raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !config.isProd)) return null;
  const ok = store.origins.some((o) => new URL(o).host === u.host)
    || u.host === 'shopify.com'
    || (u.origin === ISSUER_ORIGIN && u.pathname.startsWith('/interaction/'));
  return ok ? u.toString() : null;
}

export function loginRouter(provider) {
  const router = express.Router();
  const json = express.json({ limit: '10kb' });
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const sendLimit = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const postLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const page = (res, html, status = 200) => res.status(status).type('html').send(html);

  // ---------- CORS for the store drawer ----------
  router.use('/api/login', (req, res, next) => {
    const origin = req.get('origin');
    const known = Boolean(origin && (origin === ISSUER_ORIGIN || stores.byOrigin(origin)));
    if (known) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'content-type, ngrok-skip-browser-warning');
      res.set('Access-Control-Max-Age', '600');
    }
    res.set('Vary', 'Origin');
    res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method === 'POST' && !known) return res.status(403).json({ error: 'This website is not allowed to use this login.' });
    return next();
  });

  const api = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (err instanceof LoginError || err instanceof OtpError) return res.status(err.status || 400).json({ error: err.message });
      return next(err);
    }
  };

  // ---------- login flow helpers ----------

  async function startFlow(req) {
    const store = stores.get(req.body.store);
    if (!store) throw new LoginError('Unknown store.', 404);
    if (!originAllowed(req.get('origin'), store)) throw new LoginError('This website is not allowed to use this login.', 403);
    if (req.body.flowId) {
      const flow = await LoginFlow.findById(String(req.body.flowId));
      if (flow && flow.expiresAt > new Date() && flow.storeId === store.id) return { flow, store };
    }
    const returnTo = safeReturnTo(store, req.body.returnTo);
    if (!returnTo) throw new LoginError('This return address is not allowed for this store.');
    const flow = await LoginFlow.create({ _id: token(), storeId: store.id, returnTo, expiresAt: later(FLOW_TTL) });
    return { flow, store };
  }

  async function loadFlow(req) {
    const flow = req.body.flowId ? await LoginFlow.findById(String(req.body.flowId)) : null;
    const store = flow && stores.get(flow.storeId);
    if (!flow || !store || flow.expiresAt < new Date()) throw new LoginError('Your session expired. Please start again.', 410);
    if (!originAllowed(req.get('origin'), store)) throw new LoginError('This website is not allowed to use this login.', 403);
    return { flow, store };
  }

  async function sendCode(flow, store, params) {
    const otp = await issueOtp({ flowId: flow.id, store, ...params });
    flow.otpId = otp._id;
    await flow.save();
    return { step: 'otp', flowId: flow.id, channel: params.channel, masked: maskTarget(params.target), length: config.otp.length };
  }

  // What's still missing before this customer can go to Shopify?
  async function next(flow, store, user, method) {
    if (user.status !== 'active') throw new LoginError('This account is disabled. Please contact support.', 403);
    flow.userId = user._id;
    if (method) flow.method = method;
    await flow.save();
    if (!user.email || !user.emailVerified) {
      return { step: 'profile', flowId: flow.id, needName: !user.firstName, needEmail: true, email: user.email || '' };
    }

    await recordLogin(user, store.id, flow.method || 'otp');
    const ticket = await LoginTicket.create({
      _id: token(), userId: user._id, storeId: store.id, method: flow.method, returnTo: flow.returnTo, expiresAt: later(TICKET_TTL),
    });
    await LoginFlow.deleteOne({ _id: flow._id });
    return { step: 'done', redirect: `${config.issuer}/login/complete?ticket=${encodeURIComponent(ticket.id)}` };
  }

  // ---------- API ----------

  router.get('/api/login/config', (req, res) => {
    const store = stores.get(req.query.store);
    if (!store) return res.status(404).json({ error: 'Unknown store.' });
    return res.json(publicConfig(store));
  });

  router.post('/api/login/otp/send', sendLimit, json, api(async (req) => {
    const { flow, store } = await startFlow(req);
    const raw = req.body.mobile ?? req.body.identifier;
    if (looksLikeEmail(raw)) {
      const email = normalizeEmail(raw);
      if (!email) throw new LoginError('Please enter a valid email address.');
      return sendCode(flow, store, { purpose: 'login_email', channel: 'email', target: email });
    }
    const phone = normalizePhone(raw);
    if (!phone) throw new LoginError('Please enter a valid 10-digit mobile number.');
    return sendCode(flow, store, { purpose: 'login_phone', channel: 'sms', target: phone });
  }));

  router.post('/api/login/otp/resend', sendLimit, json, api(async (req) => {
    const { flow, store } = await loadFlow(req);
    const old = flow.otpId && await Otp.findById(flow.otpId);
    if (!old) throw new LoginError('Please start again.', 410);
    return sendCode(flow, store, { purpose: old.purpose, channel: old.channel, target: old.target, userId: old.userId });
  }));

  router.post('/api/login/otp/verify', postLimit, json, api(async (req) => {
    const { flow, store } = await loadFlow(req);
    if (!flow.otpId) throw new LoginError('Please request a code first.');
    const otp = await verifyOtp({ otpId: flow.otpId, flowId: flow.id, code: req.body.code });

    if (otp.purpose === 'login_phone' || otp.purpose === 'login_email') {
      const key = otp.purpose === 'login_phone' ? 'phone' : 'email';
      let user = await User.findOne({ group: store.customerGroup, [key]: otp.target });
      if (!user) { user = new User({ group: store.customerGroup, [key]: otp.target }); flow.newCustomer = true; }
      user[`${key}Verified`] = true;
      await user.save();
      return next(flow, store, user, otp.purpose === 'login_phone' ? 'otp_sms' : 'otp_email');
    }
    if (otp.purpose === 'verify_email') {
      const user = await User.findById(flow.userId);
      if (!user || String(user._id) !== String(otp.userId)) throw new LoginError('Please start again.', 410);
      return next(flow, store, await attachVerifiedEmail(user, otp.target));
    }
    if (otp.purpose === 'reset_password') {
      // Also works for guest-checkout customers who have no account here yet:
      // proving the inbox creates the account, then they choose a password.
      let user = (otp.userId && await User.findById(otp.userId)) || await User.findOne({ group: store.customerGroup, email: otp.target });
      if (!user) { user = new User({ group: store.customerGroup, email: otp.target }); flow.newCustomer = true; }
      user.emailVerified = true;
      await user.save();
      flow.resetUserId = user._id;
      await flow.save();
      return { step: 'reset', flowId: flow.id };
    }
    throw new LoginError('Unknown code type.');
  }));

  // New customers: name and/or email
  router.post('/api/login/profile', postLimit, json, api(async (req) => {
    const { flow, store } = await loadFlow(req);
    const user = flow.userId && await User.findById(flow.userId);
    if (!user) throw new LoginError('Please start again.', 410);
    if (!user.firstName) {
      const firstName = cleanName(req.body.firstName);
      if (!firstName) throw new LoginError('Please enter your first name.');
      user.firstName = firstName;
      user.lastName = cleanName(req.body.lastName);
      await user.save();
    }
    if (!user.email || !user.emailVerified) {
      const email = normalizeEmail(req.body.email);
      if (!email) throw new LoginError('Please enter a valid email address.');
      return sendCode(flow, store, { purpose: 'verify_email', channel: 'email', target: email, userId: user._id });
    }
    return next(flow, store, user);
  }));

  router.post('/api/login/password', postLimit, json, api(async (req) => {
    const { flow, store } = await startFlow(req);
    const email = normalizeEmail(req.body.email);
    const user = email && await User.findOne({ group: store.customerGroup, email }).select('+passwordHash');
    if (!user || !(await user.checkPassword(String(req.body.password || '')))) throw new LoginError('Incorrect email or password. Never set a password? Use “Forgot Password?” to create one.', 401);
    flow.method = 'password';
    if (!user.emailVerified) {
      flow.userId = user._id;
      return sendCode(flow, store, { purpose: 'verify_email', channel: 'email', target: user.email, userId: user._id });
    }
    return next(flow, store, user, 'password');
  }));

  router.post('/api/login/forgot', sendLimit, json, api(async (req) => {
    const { flow, store } = await startFlow(req);
    const email = normalizeEmail(req.body.email);
    if (!email) throw new LoginError('Please enter a valid email address.');
    // No "account not found" error: guest-checkout customers can set their
    // first password here, and it doesn't reveal who has an account.
    const user = await User.findOne({ group: store.customerGroup, email });
    return sendCode(flow, store, { purpose: 'reset_password', channel: 'email', target: email, userId: user?._id });
  }));

  router.post('/api/login/reset', postLimit, json, api(async (req) => {
    const { flow, store } = await loadFlow(req);
    if (!flow.resetUserId) throw new LoginError('Please verify the code first.');
    const problem = passwordProblem(req.body.password);
    if (problem) throw new LoginError(problem);
    const user = await User.findById(flow.resetUserId);
    if (!user) throw new LoginError('Account not found.', 404);
    await user.setPassword(req.body.password);
    user.emailVerified = true; // they just proved access to the inbox
    await user.save();
    return next(flow, store, user, 'password_reset');
  }));

  // ---------- browser hops ----------

  function setAutologin(res, userId, method) {
    res.cookie(COOKIE.autologin, JSON.stringify({ userId: String(userId), method, t: Date.now() }), cookieOpts(AUTOLOGIN_TTL));
  }

  router.get('/login/complete', async (req, res, nextFn) => {
    try {
      const ticket = await LoginTicket.findOneAndDelete({ _id: String(req.query.ticket || ''), expiresAt: { $gt: new Date() } });
      if (!ticket) {
        return page(res, messagePage({ title: 'Link expired', message: 'Please go back to the store and sign in again.' }), 400);
      }
      setAutologin(res, ticket.userId, ticket.method);
      return res.redirect(303, ticket.returnTo);
    } catch (e) { return nextFn(e); }
  });

  // Google / Facebook / Apple
  router.get('/login/social/:provider', async (req, res, nextFn) => {
    try {
      const p = req.params.provider;
      const store = stores.get(req.query.store);
      const returnTo = store && safeReturnTo(store, req.query.returnTo);
      if (!enabledSocial[p] || !returnTo) {
        return page(res, messagePage({ title: 'Not available', message: 'This sign-in option is not available right now.', store }), 400);
      }
      const { url, checks } = await startSocialLogin(p);
      res.cookie(COOKIE.social, JSON.stringify({ ...checks, storeId: store.id, returnTo }), cookieOpts(15 * 60_000));
      return res.redirect(303, url);
    } catch (e) { return nextFn(e); }
  });

  // Apple posts back cross-site (drops SameSite=Lax cookies): bounce to a GET.
  router.post('/social/apple/callback', form, (req, res) => {
    const q = new URLSearchParams();
    for (const k of ['code', 'state', 'user', 'error']) if (req.body[k]) q.set(k, req.body[k]);
    res.redirect(303, `/social/apple/callback?${q}`);
  });

  router.get('/social/:provider/callback', async (req, res) => {
    const checks = readCookie(req, COOKIE.social);
    res.clearCookie(COOKIE.social, { path: '/' });
    const store = checks && stores.get(checks.storeId);
    if (!store) return page(res, messagePage({ title: 'Session expired', message: 'Please go back to the store and try again.' }), 400);
    try {
      const profile = await finishSocialLogin(req.params.provider, req.query, checks);
      const { user, isNew } = await upsertSocialUser(profile, store.customerGroup);
      if (user.status !== 'active') throw new LoginError('This account is disabled. Please contact support.');
      if (!user.email || !user.emailVerified) {
        // e.g. Facebook account without email: ask for one on the hosted page
        const flow = await LoginFlow.create({
          _id: token(), storeId: store.id, returnTo: checks.returnTo, userId: user._id,
          method: profile.provider, newCustomer: isNew, expiresAt: later(FLOW_TTL),
        });
        return res.redirect(303, `/login/continue?flow=${encodeURIComponent(flow.id)}`);
      }
      await recordLogin(user, store.id, profile.provider);
      setAutologin(res, user._id, profile.provider);
      return res.redirect(303, checks.returnTo);
    } catch (err) {
      console.warn('[social] callback failed:', err.message);
      return page(res, messagePage({
        title: 'Sign-in failed',
        message: err instanceof LoginError ? err.message : 'We couldn’t sign you in with that account. Please try again.',
        store,
      }), 400);
    }
  });

  router.get('/login/continue', async (req, res, nextFn) => {
    try {
      const flow = await LoginFlow.findById(String(req.query.flow || ''));
      const store = flow && stores.get(flow.storeId);
      const user = flow?.userId && await User.findById(flow.userId);
      if (!flow || !store || !user || flow.expiresAt < new Date()) {
        return page(res, messagePage({ title: 'Session expired', message: 'Please go back to the store and try again.', store }), 400);
      }
      return page(res, loginPage({
        store, returnTo: flow.returnTo, resume: { flowId: flow.id, needName: !user.firstName, email: user.email || '' },
      }));
    } catch (e) { return nextFn(e); }
  });

  // ---------- Shopify -> /authorize -> here ----------

  router.get('/interaction/:uid', async (req, res, nextFn) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.uid !== req.params.uid) {
        return page(res, messagePage({ title: 'Session expired', message: 'Please go back to the store and sign in again.' }), 400);
      }
      const store = stores.byClientId(details.params.client_id) || stores.fallback();

      // First-party login: grant everything without a consent screen.
      if (details.prompt.name === 'consent') {
        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });
        const d = details.prompt.details;
        if (d.missingOIDCScope) grant.addOIDCScope(d.missingOIDCScope.join(' '));
        if (d.missingOIDCClaims) grant.addOIDCClaims(d.missingOIDCClaims);
        for (const [indicator, scopes] of Object.entries(d.missingResourceScopes || {})) grant.addResourceScope(indicator, scopes.join(' '));
        const grantId = await grant.save();
        return provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      }

      // Logged in moments ago (drawer or this page): finish straight away.
      const auto = readCookie(req, COOKIE.autologin);
      res.clearCookie(COOKIE.autologin, { path: '/' });
      if (auto && Date.now() - auto.t < AUTOLOGIN_TTL) {
        const user = await User.findById(auto.userId).catch(() => null);
        if (user?.canSignIntoShopify() && user.group === store.customerGroup) {
          return provider.interactionFinished(req, res, {
            login: { accountId: user.id, amr: [auto.method || 'otp'], remember: true },
          }, { mergeWithLastSubmission: false });
        }
      }
      return page(res, loginPage({ store, returnTo: `${config.issuer}/interaction/${details.uid}` }));
    } catch (err) {
      if (err?.name === 'SessionNotFound' || err?.name === 'InvalidRequest') {
        return page(res, messagePage({ title: 'Session expired', message: 'Please go back to the store and click "Sign in" again.' }), 400);
      }
      return nextFn(err);
    }
  });

  return router;
}
