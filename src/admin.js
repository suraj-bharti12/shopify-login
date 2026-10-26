// Admin panel: /admin. Manage stores, settings, customers and admins from the
// browser. Server-rendered pages, cookie session, CSRF token on every form.
import express from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { User, Admin, AdminSession } from './db.js';
import {
  stores, saveStore, deleteStore, syncClient, clientSecret, StoreError, customerGroups,
} from './stores.js';
import { saveSettings, storeCredsFromForm, forStore } from './settings.js';
import { sendSms, sendTestEmail, smsText } from './otp.js';
import { normalizeEmail, normalizePhone, passwordProblem } from './users.js';
import * as view from './adminViews.js';
import { guidePage } from './adminGuide.js';
import { issuerFor } from './issuers.js';

const COOKIE = 'idp_admin';
const FLASH = 'idp_flash';
const SESSION_HOURS = 12;
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
const lines = (v) => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let setupCode = null; // printed in the terminal while no admin exists

/** Called on startup. Prints a one-time setup code if there is no admin yet. */
export async function initAdmin() {
  if (!(await Admin.exists({}))) {
    setupCode = `${token(4)}-${token(4)}`.toUpperCase().replace(/[^A-Z0-9-]/g, 'X');
    console.log('\n================ ADMIN SETUP ================');
    console.log(`Open ${config.issuer}/admin`);
    console.log(`Setup code: ${setupCode}`);
    console.log('=============================================\n');
  }
}

export function adminRouter() {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '100kb' });
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const cookieOpts = (maxAge) => ({
    httpOnly: true, signed: true, sameSite: 'strict', secure: config.isProd, path: '/admin', maxAge,
  });

  const html = (res, body, status = 200) => res.status(status).type('html').send(body);
  const flash = (res, type, msg) => res.cookie(FLASH, JSON.stringify({ type, msg }), cookieOpts(60_000));
  function takeFlash(req, res) {
    const raw = req.signedCookies?.[FLASH];
    if (!raw) return null;
    res.clearCookie(FLASH, { path: '/admin' });
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ---------- session ----------
  r.use(async (req, res, next) => {
    req.adminSession = null;
    if (!req.path.startsWith('/admin')) return next();
    // Browsers then send our Origin with form posts (checked below).
    res.set('Referrer-Policy', 'same-origin');
    const sid = req.signedCookies?.[COOKIE];
    if (sid) {
      const s = await AdminSession.findById(String(sid));
      if (s && s.expiresAt > new Date()) {
        const admin = await Admin.findById(s.adminId).lean();
        if (admin) { req.admin = admin; req.adminSession = s; }
      }
    }
    next();
  });

  // Forms only from our own pages: same-origin + session token.
  function checkPost(req, res, next) {
    const origin = req.get('origin');
    if (origin && origin !== new URL(config.issuer).origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).send('Forbidden (wrong origin)');
    }
    if (req.adminSession && req.body?._csrf !== req.adminSession.csrf) {
      flash(res, 'error', 'Your session expired. Please try again.');
      return res.redirect(303, req.get('referer') || '/admin');
    }
    return next();
  }

  const needAdmin = async (req, res, next) => {
    if (req.admin) return next();
    if (!(await Admin.exists({}))) return res.redirect(303, '/admin/setup');
    return res.redirect(303, '/admin/login');
  };
  const ctx = (req, res) => ({ admin: req.admin, csrf: req.adminSession.csrf, flash: takeFlash(req, res) });

  async function startSession(res, admin) {
    const s = await AdminSession.create({
      _id: token(), adminId: admin._id, csrf: token(), expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000),
    });
    await Admin.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
    res.cookie(COOKIE, s.id, cookieOpts(SESSION_HOURS * 3600_000));
  }

  // ---------- setup / login / logout ----------

  r.get('/admin/setup', async (req, res) => {
    if (await Admin.exists({})) return res.redirect(303, '/admin');
    return html(res, view.setupForm({ flash: takeFlash(req, res) }));
  });

  r.post('/admin/setup', loginLimit, form, checkPost, async (req, res) => {
    if (await Admin.exists({})) return res.redirect(303, '/admin');
    const values = { code: req.body.code, name: req.body.name, email: req.body.email };
    const fail = (msg) => html(res, view.setupForm({ flash: { type: 'error', msg }, values }), 400);
    const given = String(req.body.code || '').trim().toUpperCase();
    if (!setupCode || given.length !== setupCode.length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(setupCode))) {
      return fail('Wrong setup code. Copy it from the server terminal (restart the server to get a new one).');
    }
    const email = normalizeEmail(req.body.email);
    if (!email) return fail('Please enter a valid email.');
    const problem = passwordProblem(req.body.password);
    if (problem) return fail(problem);
    const admin = new Admin({ email, name: String(req.body.name || '').trim() });
    await admin.setPassword(req.body.password);
    await admin.save();
    setupCode = null;
    await startSession(res, admin);
    flash(res, 'ok', 'Welcome! Your admin account is ready.');
    return res.redirect(303, '/admin');
  });

  r.get('/admin/login', async (req, res) => {
    if (req.admin) return res.redirect(303, '/admin');
    if (!(await Admin.exists({}))) return res.redirect(303, '/admin/setup');
    return html(res, view.loginForm({ flash: takeFlash(req, res) }));
  });

  r.post('/admin/login', loginLimit, form, checkPost, async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const admin = email && await Admin.findOne({ email });
    if (!admin || !(await admin.checkPassword(req.body.password))) {
      return html(res, view.loginForm({ flash: { type: 'error', msg: 'Wrong email or password.' }, email: req.body.email }), 401);
    }
    await startSession(res, admin);
    return res.redirect(303, '/admin');
  });

  r.post('/admin/logout', form, checkPost, async (req, res) => {
    if (req.adminSession) await AdminSession.deleteOne({ _id: req.adminSession._id });
    res.clearCookie(COOKIE, { path: '/admin' });
    return res.redirect(303, '/admin/login');
  });

  // Everything below needs a signed-in admin.
  r.use('/admin', needAdmin);
  r.post('/admin/*splat', form, checkPost);

  // ---------- dashboard ----------

  r.get('/admin', async (req, res) => {
    const week = new Date(Date.now() - 7 * 24 * 3600_000);
    const [customers, recent, newCustomers] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ lastLoginAt: { $gte: week } }),
      User.countDocuments({ createdAt: { $gte: week } }),
    ]);
    html(res, view.dashboardPage(ctx(req, res), { counts: { customers, recent, newCustomers }, storesList: stores.all() }));
  });

  // ---------- stores ----------

  async function customerCounts() {
    const rows = await User.aggregate([{ $unwind: '$stores' }, { $group: { _id: '$stores', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((x) => [x._id, x.n]));
  }

  // "own" = a separate customer group just for this store (named after its ID).
  const groupInput = (b, id, current) => {
    const g = String(b.customerGroup || '').trim().toLowerCase();
    if (!g) return current || id;
    return g === '__own' ? id : g;
  };

  // The store's own SMS / email / social keys. Bad values become a form error.
  function credsInput(b, current) {
    try {
      return storeCredsFromForm(b, current?.creds);
    } catch (e) {
      throw new StoreError('creds', e.message);
    }
  }
  const ownInput = (b, current) => Object.fromEntries(['sms', 'mail', 'social'].map((k) => [
    k, b[`own_${k}`] === undefined ? Boolean(current?.own?.[k]) : b[`own_${k}`] === '1',
  ]));

  const storeInput = (b, current) => ({
    own: ownInput(b, current),
    creds: credsInput(b, current),
    id: String(b.id || '').trim().toLowerCase(),
    customerGroup: groupInput(b, String(current?.id || b.id || '').trim().toLowerCase(), current?.customerGroup),
    name: b.name,
    shopDomain: b.shopDomain,
    shopId: b.shopId,
    domains: lines(b.domains),
    accountDomain: b.accountDomain,
    extraRedirectUris: lines(b.extraRedirectUris),
    extraLogoutUris: lines(b.extraLogoutUris),
    afterLogin: b.afterLogin,
    loginDomain: b.loginDomain,
    brand: {
      welcome: b.welcome, name: b.brandName, logoUrl: b.logoUrl, tagline: b.tagline, color: b.color, supportEmail: b.supportEmail,
    },
    smsTemplate: b.smsTemplate,
  });

  r.get('/admin/stores', async (req, res) => {
    html(res, view.storesPage(ctx(req, res), { list: stores.all(), customerCounts: await customerCounts() }));
  });

  r.get('/admin/stores/new', (req, res) => html(res, view.newStorePage(ctx(req, res), {})));

  r.post('/admin/stores/new', async (req, res) => {
    try {
      const store = await saveStore(storeInput(req.body), { isNew: true });
      flash(res, 'ok', 'Store created. Now connect it in Shopify (step 1) and add the snippet to the theme (step 2).');
      return res.redirect(303, `/admin/stores/${store.id}`);
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      return html(res, view.newStorePage(ctx(req, res), { values: req.body, error: e }), 400);
    }
  });

  async function renderStore(req, res, store, extra = {}, status = 200) {
    const counts = await customerCounts();
    return html(res, view.storePage(ctx(req, res), {
      store, secret: await clientSecret(store), customerCount: counts[store.id] || 0, ...extra,
    }), status);
  }

  r.get('/admin/stores/:id', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) { flash(res, 'error', 'Store not found.'); return res.redirect(303, '/admin/stores'); }
    return renderStore(req, res, store);
  });

  r.post('/admin/stores/:id', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    try {
      await saveStore({ ...storeInput({ ...req.body, id: store.id }, store), id: store.id }, { isNew: false });
      flash(res, 'ok', 'Saved. The login drawer uses the new settings straight away.');
      return res.redirect(303, `/admin/stores/${store.id}`);
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      return renderStore(req, res, store, { values: { ...req.body, id: store.id }, error: e }, 400);
    }
  });

  // Is the store's login domain pointing at this server (DNS + HTTPS ready)?
  r.post('/admin/stores/:id/check-domain', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    const url = `${issuerFor(store)}/healthz`;
    try {
      const r2 = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      const body = await r2.json().catch(() => null);
      if (r2.ok && body?.ok && body.stores?.includes(store.id)) {
        flash(res, 'ok', `${store.loginDomain} is working and reaches this server.`);
      } else {
        flash(res, 'error', `${store.loginDomain} answered, but not from this login server (status ${r2.status}). Check the CNAME record and that the domain is added in Render → Settings → Custom Domains.`);
      }
    } catch (e) {
      const why = `${e.cause?.code || ''} ${e.cause?.message || e.message}`;
      flash(res, 'error', /ENOTFOUND|EAI_AGAIN/.test(why)
        ? `${store.loginDomain} is not found in DNS yet. Add the CNAME record; it can take up to an hour to work.`
        : /CERT|SSL|TLS|certificate/i.test(why)
          ? `${store.loginDomain} reaches a server, but its HTTPS certificate isn't ready. In Render → Settings → Custom Domains, check it shows "Certificate issued"; this takes a few minutes after DNS works.`
          : `Could not open ${url}: ${why.trim()}`);
    }
    return res.redirect(303, `/admin/stores/${store.id}`);
  });

  // Test this store's SMS / email with the keys it actually uses.
  r.post('/admin/stores/:id/test-sms', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      flash(res, 'error', 'Enter a valid mobile number.');
    } else {
      const { sms } = forStore(store);
      const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');
      try {
        const out = await sendSms(phone, code, store.smsTemplate, sms);
        flash(res, 'ok', sms.provider === 'console'
          ? `SMS is in test mode (console): the text was printed in the server log: "${smsText(code, store.smsTemplate)}"`
          : `Sent to ${phone} with ${store.own.sms ? 'this store\'s own' : 'the default'} ${sms.provider} account. Gateway reply: ${out?.raw || 'ok'}`);
      } catch (e) {
        flash(res, 'error', `SMS failed: ${e.message}`);
      }
    }
    return res.redirect(303, `/admin/stores/${store.id}#sending`);
  });

  r.post('/admin/stores/:id/test-email', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    const email = normalizeEmail(req.body.email);
    if (!email) {
      flash(res, 'error', 'Enter a valid email.');
    } else {
      const { mail } = forStore(store);
      try {
        await sendTestEmail(email, mail);
        flash(res, 'ok', mail.transport === 'console'
          ? 'Email is in test mode (console): it was printed in the server log, not sent.'
          : `Test email sent to ${email} from ${mail.from}. Check the inbox (and Spam).`);
      } catch (e) {
        flash(res, 'error', `Email failed: ${e.message}`);
      }
    }
    return res.redirect(303, `/admin/stores/${store.id}#sending`);
  });

  r.post('/admin/stores/:id/secret', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    if (String(req.body.confirm || '').trim() !== store.id) {
      flash(res, 'error', `Type ${store.id} to confirm.`);
    } else {
      await syncClient(store, { rotateSecret: true });
      flash(res, 'ok', 'New client secret made. Paste it into Shopify now (Client secret field).');
    }
    return res.redirect(303, `/admin/stores/${store.id}`);
  });

  r.post('/admin/stores/:id/delete', async (req, res) => {
    const store = stores.get(req.params.id);
    if (!store) return res.redirect(303, '/admin/stores');
    if (String(req.body.confirm || '').trim() !== store.id) {
      flash(res, 'error', `Type ${store.id} to confirm.`);
      return res.redirect(303, `/admin/stores/${store.id}`);
    }
    await deleteStore(store.id);
    flash(res, 'ok', `Store "${store.name}" deleted.`);
    return res.redirect(303, '/admin/stores');
  });

  // ---------- customers ----------

  r.get('/admin/customers', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const group = String(req.query.group || '').trim().toLowerCase().slice(0, 40);
    const PER = 50;
    let filter = {};
    if (q) {
      const or = [{ email: new RegExp(escapeRegex(q.toLowerCase())) }];
      const phone = normalizePhone(q);
      const digits = q.replace(/\D/g, '');
      if (phone) or.push({ phone });
      else if (digits.length >= 4) or.push({ phone: new RegExp(escapeRegex(digits)) });
      or.push({ firstName: new RegExp(escapeRegex(q), 'i') }, { lastName: new RegExp(escapeRegex(q), 'i') });
      if (mongoose.isValidObjectId(q)) or.push({ _id: q });
      filter = { $or: or };
    }
    if (group) filter.group = group;
    const total = await User.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / PER));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const list = await User.find(filter).sort({ lastLoginAt: -1, createdAt: -1 }).skip((page - 1) * PER).limit(PER).lean();
    html(res, view.customersPage(ctx(req, res), {
      list, q, group, page, pages, total, groups: customerGroups(),
    }));
  });

  async function findCustomer(req, res) {
    const u = mongoose.isValidObjectId(req.params.id) && await User.findById(req.params.id).select('+passwordHash');
    if (!u) { flash(res, 'error', 'Customer not found.'); res.redirect(303, '/admin/customers'); }
    return u;
  }

  r.get('/admin/customers/:id', async (req, res) => {
    const u = await findCustomer(req, res);
    if (u) html(res, view.customerPage(ctx(req, res), { u: u.toObject() }));
  });

  r.post('/admin/customers/:id/:action', async (req, res) => {
    const u = await findCustomer(req, res);
    if (!u) return undefined;
    const back = `/admin/customers/${u.id}`;
    switch (req.params.action) {
      case 'block': u.status = 'blocked'; await u.save(); flash(res, 'ok', 'Customer blocked.'); break;
      case 'unblock': u.status = 'active'; await u.save(); flash(res, 'ok', 'Customer unblocked.'); break;
      case 'unlink':
        u.identities = u.identities.filter((i) => !(i.provider === req.body.provider && i.providerUserId === req.body.providerUserId));
        await u.save();
        flash(res, 'ok', `${req.body.provider} sign-in removed.`);
        break;
      case 'delete':
        if (String(req.body.confirm || '').trim() !== 'DELETE') { flash(res, 'error', 'Type DELETE to confirm.'); break; }
        await User.deleteOne({ _id: u._id });
        flash(res, 'ok', 'Customer deleted.');
        return res.redirect(303, '/admin/customers');
      default: break;
    }
    return res.redirect(303, back);
  });

  // ---------- settings ----------

  r.get('/admin/guide', (req, res) => html(res, guidePage(ctx(req, res))));

  r.get('/admin/settings', (req, res) => {
    html(res, view.settingsPage(ctx(req, res), { storesList: stores.all(), dbName: mongoose.connection.name }));
  });

  r.post('/admin/settings', async (req, res) => {
    try {
      await saveSettings(req.body);
      flash(res, 'ok', 'Settings saved. They are used straight away.');
    } catch (e) {
      flash(res, 'error', e.message);
    }
    return res.redirect(303, '/admin/settings');
  });

  r.post('/admin/settings/test-sms', async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      flash(res, 'error', 'Enter a valid mobile number.');
    } else {
      const chosen = stores.get(req.body.store);
      const template = chosen?.smsTemplate;
      const sms = chosen ? forStore(chosen).sms : config.sms;
      const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');
      try {
        const out = await sendSms(phone, code, template, sms);
        flash(res, 'ok', sms.provider === 'console'
          ? `SMS is in test mode (console): the text was printed in the server terminal: "${smsText(code, template)}"`
          : `Sent to ${phone}. Gateway reply: ${out?.raw || 'ok'}`);
      } catch (e) {
        flash(res, 'error', `SMS failed: ${e.message}`);
      }
    }
    return res.redirect(303, '/admin/settings#sms');
  });

  r.post('/admin/settings/test-email', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      flash(res, 'error', 'Enter a valid email.');
    } else {
      try {
        await sendTestEmail(email);
        flash(res, 'ok', config.mail.transport === 'console'
          ? 'Email is in test mode (console): it was printed in the server terminal, not sent.'
          : `Test email sent to ${email}. Check the inbox (and Spam).`);
      } catch (e) {
        flash(res, 'error', `Email failed: ${e.message}`);
      }
    }
    return res.redirect(303, '/admin/settings#mail');
  });

  // ---------- admins ----------

  r.get('/admin/admins', async (req, res) => {
    html(res, view.adminsPage(ctx(req, res), { list: await Admin.find({}).sort({ createdAt: 1 }).lean() }));
  });

  r.post('/admin/admins', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const problem = passwordProblem(req.body.password);
    if (!email) flash(res, 'error', 'Enter a valid email.');
    else if (problem) flash(res, 'error', problem);
    else if (await Admin.exists({ email })) flash(res, 'error', 'That email is already an admin.');
    else {
      const a = new Admin({ email, name: String(req.body.name || '').trim() });
      await a.setPassword(req.body.password);
      await a.save();
      flash(res, 'ok', `${email} can now sign in at ${config.issuer}/admin`);
    }
    return res.redirect(303, '/admin/admins');
  });

  r.post('/admin/admins/password', async (req, res) => {
    const me = await Admin.findById(req.admin._id);
    const problem = passwordProblem(req.body.password);
    if (!(await me.checkPassword(req.body.current))) flash(res, 'error', 'Current password is wrong.');
    else if (problem) flash(res, 'error', problem);
    else {
      await me.setPassword(req.body.password);
      await me.save();
      await AdminSession.deleteMany({ adminId: me._id, _id: { $ne: req.adminSession._id } });
      flash(res, 'ok', 'Password changed. Other sessions were signed out.');
    }
    return res.redirect(303, '/admin/admins');
  });

  r.post('/admin/admins/:id/delete', async (req, res) => {
    if (String(req.params.id) === String(req.admin._id)) {
      flash(res, 'error', 'You can\'t remove yourself.');
    } else if (mongoose.isValidObjectId(req.params.id)) {
      await Admin.deleteOne({ _id: req.params.id });
      await AdminSession.deleteMany({ adminId: req.params.id });
      flash(res, 'ok', 'Admin removed.');
    }
    return res.redirect(303, '/admin/admins');
  });

  return r;
}
