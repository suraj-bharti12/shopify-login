// Settings editable from the admin panel. .env gives the starting values;
// anything saved in the panel overrides them. Secret values (passwords, API
// keys) are stored encrypted with a key derived from OTP_SECRET, so keep
// OTP_SECRET unchanged or re-enter the secrets after changing it.
import crypto from 'node:crypto';
import { config, refreshSocial, socialEnabledFor } from './config.js';
import { Setting } from './db.js';
import { resetMailer } from './otp.js';
import { resetSocialCache } from './social.js';

const at = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function put(obj, p, v) {
  const keys = p.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) { o[k] ??= {}; o = o[k]; }
  o[last] = v;
}

// Every field the Settings page shows. `path` is where it lives in config.
export const FIELDS = [
  { path: 'sms.provider', label: 'SMS provider', type: 'select', options: ['console', 'gupshup', 'msg91', 'twilio'], group: 'sms' },
  { path: 'sms.template', label: 'Default SMS text', type: 'textarea', group: 'sms', help: 'Used when a store has no SMS text of its own. {otp} is replaced with the code. Must match your DLT template word for word.' },
  { path: 'sms.gupshup.userId', label: 'Gupshup user ID', group: 'sms', when: 'gupshup' },
  { path: 'sms.gupshup.password', label: 'Gupshup password', secret: true, group: 'sms', when: 'gupshup' },
  { path: 'sms.gupshup.mask', label: 'Sender ID (mask)', group: 'sms', when: 'gupshup', help: 'Optional, 6 letters.' },
  { path: 'sms.gupshup.principalEntityId', label: 'DLT Principal Entity ID', group: 'sms', when: 'gupshup', help: 'Optional.' },
  { path: 'sms.gupshup.dltTemplateId', label: 'DLT Template ID', group: 'sms', when: 'gupshup', help: 'Optional.' },
  { path: 'sms.msg91.authKey', label: 'MSG91 auth key', secret: true, group: 'sms', when: 'msg91' },
  { path: 'sms.msg91.templateId', label: 'MSG91 template ID', group: 'sms', when: 'msg91' },
  { path: 'sms.twilio.accountSid', label: 'Twilio account SID', group: 'sms', when: 'twilio' },
  { path: 'sms.twilio.authToken', label: 'Twilio auth token', secret: true, group: 'sms', when: 'twilio' },
  { path: 'sms.twilio.from', label: 'Twilio from number', group: 'sms', when: 'twilio' },

  { path: 'mail.transport', label: 'Email sending', type: 'select', options: ['console', 'smtp'], group: 'mail', help: 'console = codes are only printed in the server terminal.' },
  { path: 'mail.from', label: 'From', group: 'mail', when: 'smtp', help: 'e.g. fabfamily <your.gmail@gmail.com>. With Gmail use the same address as the SMTP user.' },
  { path: 'mail.smtp.host', label: 'SMTP host', group: 'mail', when: 'smtp', help: 'Gmail: smtp.gmail.com' },
  { path: 'mail.smtp.port', label: 'SMTP port', type: 'number', group: 'mail', when: 'smtp', help: 'Gmail: 465' },
  { path: 'mail.smtp.secure', label: 'Use SSL (port 465)', type: 'checkbox', group: 'mail', when: 'smtp' },
  { path: 'mail.smtp.auth.user', label: 'SMTP user', group: 'mail', when: 'smtp' },
  { path: 'mail.smtp.auth.pass', label: 'SMTP password', secret: true, group: 'mail', when: 'smtp', help: 'Gmail: a 16-letter App Password, without spaces.' },

  { path: 'google.clientId', label: 'Google client ID', group: 'social', provider: 'google' },
  { path: 'google.clientSecret', label: 'Google client secret', secret: true, group: 'social', provider: 'google' },
  { path: 'facebook.appId', label: 'Facebook app ID', group: 'social', provider: 'facebook' },
  { path: 'facebook.appSecret', label: 'Facebook app secret', secret: true, group: 'social', provider: 'facebook' },
  { path: 'apple.clientId', label: 'Apple Services ID', group: 'social', provider: 'apple' },
  { path: 'apple.teamId', label: 'Apple Team ID', group: 'social', provider: 'apple' },
  { path: 'apple.keyId', label: 'Apple Key ID', group: 'social', provider: 'apple' },
  { path: 'apple.privateKey', label: 'Apple private key (.p8 contents)', type: 'textarea', secret: true, group: 'social', provider: 'apple' },

  { path: 'defaultCountryCode', label: 'Default country code', group: 'otp', help: 'Added to 10-digit mobile numbers. 91 = India.' },
  { path: 'otp.length', label: 'OTP digits', type: 'number', group: 'otp', min: 4, max: 8 },
  { path: 'otp.ttlSeconds', label: 'OTP valid for (seconds)', type: 'number', group: 'otp', min: 30, max: 3600 },
  { path: 'otp.maxAttempts', label: 'Wrong tries allowed', type: 'number', group: 'otp', min: 1, max: 20 },
  { path: 'otp.resendCooldownSeconds', label: 'Wait before resend (seconds)', type: 'number', group: 'otp', min: 0, max: 600 },
];
export const fieldByPath = Object.fromEntries(FIELDS.map((f) => [f.path, f]));

// The parts a store can set up with its own accounts (Stores -> store).
// The SMS text has its own field on the store, so it is not repeated here.
export const STORE_SECTIONS = ['sms', 'mail', 'social'];
export const STORE_FIELDS = FIELDS.filter((f) => STORE_SECTIONS.includes(f.group) && f.path !== 'sms.template');

// .env values, remembered so a cleared override falls back to them.
const envDefaults = {};
for (const f of FIELDS) envDefaults[f.path] = structuredClone(at(config, f.path));

let overrides = {}; // path -> stored value (secrets encrypted)

const KEY = () => crypto.createHash('sha256').update(`idp-settings:${config.otpSecret}`).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')}`;
}
export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  try {
    const buf = Buffer.from(value.slice(7), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    console.error('[settings] could not decrypt a saved secret (was OTP_SECRET changed?). Please re-enter it in Settings.');
    return undefined;
  }
}

function apply() {
  for (const f of FIELDS) {
    const saved = overrides[f.path];
    const value = saved === undefined ? structuredClone(envDefaults[f.path]) : (f.secret ? decrypt(saved) : saved);
    put(config, f.path, value);
  }
  if (!config.mail.smtp.auth?.user) config.mail.smtp.auth = undefined;
  refreshSocial();
  resetMailer();
  resetSocialCache();
}

// MongoDB field names can't contain dots: "sms.template" is stored as "sms:template".
export const toDb = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replaceAll('.', ':'), v]));
export const fromDb = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.replaceAll(':', '.'), v]));

export async function loadSettings() {
  const doc = await Setting.findById('settings').lean();
  overrides = fromDb(doc?.value);
  apply();
}

/** Where a field's current value comes from: 'panel', 'env' or 'none'. */
export function sourceOf(path) {
  if (overrides[path] !== undefined) return 'panel';
  const v = envDefaults[path];
  return v === undefined || v === '' || v === null ? 'none' : 'env';
}

export const currentValue = (path) => at(config, path);

/**
 * Reads one field from a submitted form. Returns undefined = leave as it is
 * (not sent, or an empty secret), null = clear it, otherwise the new value.
 */
function readField(f, form, name) {
  let v = form[name];
  if (f.type === 'checkbox') {
    if (form[`${name}__present`] === undefined) return undefined;
    return v === 'on' || v === 'true';
  }
  if (v === undefined) return undefined;
  v = String(v).trim();
  if (v === '') return f.secret ? undefined : null;
  if (f.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
      throw new Error(`${f.label} must be a number${f.min !== undefined ? ` between ${f.min} and ${f.max}` : ''}.`);
    }
    return n;
  }
  if (f.type === 'select' && !f.options.includes(v)) throw new Error(`${f.label}: choose one of ${f.options.join(', ')}.`);
  if (f.path === 'apple.privateKey') v = v.replace(/\\n/g, '\n');
  if (f.path === 'defaultCountryCode') v = v.replace('+', '');
  return v;
}

/**
 * Saves the Settings form. Empty secret inputs keep the saved value; the
 * "clear" checkboxes remove the panel value (falling back to .env).
 */
export async function saveSettings(form) {
  const next = { ...overrides };
  const clear = new Set([].concat(form._clear || []));
  for (const f of FIELDS) {
    if (clear.has(f.path)) { delete next[f.path]; continue; }
    const v = readField(f, form, f.path);
    if (v === undefined) continue;
    if (v === null || (!f.secret && v === envDefaults[f.path])) { delete next[f.path]; continue; }
    next[f.path] = f.secret ? encrypt(v) : v;
  }
  await Setting.updateOne({ _id: 'settings' }, { $set: { value: toDb(next) } }, { upsert: true });
  overrides = next;
  apply();
}

// ---------- per-store keys ----------

/**
 * Reads a store's own keys from the store form (inputs named "cred:<path>").
 * Empty secret inputs keep the saved value. Returns the new creds object.
 */
export function storeCredsFromForm(form, existing = {}) {
  const next = { ...existing };
  for (const f of STORE_FIELDS) {
    const v = readField(f, form, `cred:${f.path}`);
    if (v === undefined) continue;
    if (v === null) { delete next[f.path]; continue; }
    next[f.path] = f.secret ? encrypt(v) : v;
  }
  return next;
}

/** A store's saved value for one field (secrets: true when one is saved). */
export function storeCredValue(store, path) {
  const v = store?.creds?.[path];
  return fieldByPath[path]?.secret ? v !== undefined : v;
}

const SECTION_KEYS = { sms: ['sms'], mail: ['mail'], social: ['google', 'facebook', 'apple'] };

/**
 * The SMS, email and social keys a store actually uses: its own for the parts
 * set to "this store's own", the Settings ones for the rest.
 */
export function forStore(store) {
  const out = {
    sms: config.sms, mail: config.mail, google: config.google, facebook: config.facebook, apple: config.apple,
  };
  for (const section of STORE_SECTIONS) {
    if (!store?.own?.[section]) continue;
    const part = {};
    for (const k of SECTION_KEYS[section]) part[k] = structuredClone(config[k]);
    for (const f of STORE_FIELDS.filter((x) => x.group === section)) {
      const saved = store.creds?.[f.path];
      put(part, f.path, saved === undefined ? undefined : (f.secret ? decrypt(saved) : saved));
    }
    if (section === 'mail' && !part.mail.smtp?.auth?.user) part.mail.smtp.auth = undefined;
    Object.assign(out, part);
  }
  out.social = socialEnabledFor(out);
  return out;
}
