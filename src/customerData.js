// Customer import and export (Admin Panel → Customers).
//
// Import reads a CSV: a Shopify customer export, or any file with columns such
// as first_name, last_name, email, phone. Imported customers can sign in with
// mobile OTP straight away; with a matching email Shopify opens their existing
// account and orders. Passwords can't be imported (Shopify never exports them):
// customers use OTP or "Forgot password".
import { User } from './db.js';
import { normalizeEmail, normalizePhone, cleanName } from './users.js';

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;

// ---------- CSV ----------

/** Parses CSV text (commas, quotes, line breaks inside quotes, BOM). */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Spreadsheet apps run cells starting with = + - @ as formulas; a leading quote
// stops that. Phone numbers like +91… are left as they are.
const cell = (v) => {
  let t = v === undefined || v === null ? '' : String(v);
  if (/^[=@\t\r]/.test(t) || /^[+-][^\d]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export const csvLine = (values) => `${values.map(cell).join(',')}\r\n`;

// ---------- columns ----------

const ALIASES = {
  firstName: ['firstname', 'givenname', 'first'],
  lastName: ['lastname', 'familyname', 'surname', 'last'],
  fullName: ['name', 'fullname', 'customername'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'mobilenumber', 'phonenumber', 'mobileno', 'contactnumber'],
  addressPhone: ['defaultaddressphone', 'addressphone', 'shippingphone', 'billingphone'],
};
const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which column holds what. Throws if there is no email or phone column. */
export function mapColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    const k = key(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (map[field] === undefined && names.includes(k)) map[field] = i;
    }
  });
  if (map.email === undefined && map.phone === undefined && map.addressPhone === undefined) {
    throw new Error('The file needs an "email" or "phone" column in its first row.');
  }
  return map;
}

// ---------- import ----------

const maskEmail = (e) => e.replace(/^(.{2})[^@]*/, (m, a) => `${a}***`);

/**
 * Works out what an import would do, without saving anything.
 * options: { group, emailsVerified, useAddressPhone }
 */
export async function planImport(text, { group, emailsVerified = true, useAddressPhone = false }) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file is empty: it needs a header row and at least one customer.');
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new Error(`Too many rows: import at most ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} customers per file.`);
  const cols = mapColumns(rows[0]);
  const get = (r, f) => (cols[f] === undefined ? '' : String(r[cols[f]] ?? '').trim());

  const plan = {
    group, emailsVerified, total: rows.length - 1, create: [], update: [], unchanged: 0, skipped: [], noEmail: 0, columns: cols,
  };
  const skip = (line, reason) => plan.skipped.push({ line, reason });

  // 1. Read and check every row; drop repeats inside the file.
  const candidates = [];
  const seenEmail = new Map();
  const seenPhone = new Map();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const rawEmail = get(r, 'email');
    const rawPhone = get(r, 'phone') || (useAddressPhone ? get(r, 'addressPhone') : '');
    const email = rawEmail ? normalizeEmail(rawEmail) : null;
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawEmail && !email) return skip(line, `Invalid email "${rawEmail}"`);
    if (rawPhone && !phone) return skip(line, `Invalid mobile number "${rawPhone}"`);
    if (!email && !phone) return skip(line, 'No email or mobile number');
    if (email && seenEmail.has(email)) return skip(line, `Same email as line ${seenEmail.get(email)}`);
    if (phone && seenPhone.has(phone)) return skip(line, `Same mobile number as line ${seenPhone.get(phone)}`);
    if (email) seenEmail.set(email, line);
    if (phone) seenPhone.set(phone, line);
    let firstName = cleanName(get(r, 'firstName'));
    let lastName = cleanName(get(r, 'lastName'));
    if (!firstName && !lastName && get(r, 'fullName')) {
      const parts = cleanName(get(r, 'fullName')).split(/\s+/);
      firstName = parts.shift() || '';
      lastName = parts.join(' ');
    }
    candidates.push({
      line, email, phone, firstName, lastName,
    });
    return undefined;
  });

  // 2. Find customers already in this customer list.
  const byEmail = new Map();
  const byPhone = new Map();
  const emails = [...seenEmail.keys()];
  const phones = [...seenPhone.keys()];
  for (let i = 0; i < Math.max(emails.length, phones.length); i += 1000) {
    const or = [];
    if (emails.length > i) or.push({ email: { $in: emails.slice(i, i + 1000) } });
    if (phones.length > i) or.push({ phone: { $in: phones.slice(i, i + 1000) } });
    const found = await User.find({ group, $or: or }).select('email emailVerified phone firstName lastName').lean();
    for (const u of found) {
      if (u.email) byEmail.set(u.email, u);
      if (u.phone) byPhone.set(u.phone, u);
    }
  }

  // 3. New customer, fill in an existing one, or skip a conflict.
  for (const c of candidates) {
    const eu = c.email && byEmail.get(c.email);
    const pu = c.phone && byPhone.get(c.phone);
    if (eu && pu && String(eu._id) !== String(pu._id)) {
      skip(c.line, 'The email and the mobile number belong to two different customers');
      continue;
    }
    const u = eu || pu;
    if (!u) {
      if (!c.email) plan.noEmail += 1;
      plan.create.push({
        group,
        email: c.email || undefined,
        emailVerified: Boolean(c.email && emailsVerified),
        phone: c.phone || undefined,
        phoneVerified: false,
        firstName: c.firstName || undefined,
        lastName: c.lastName || undefined,
      });
      continue;
    }
    if (pu && !eu && c.email && u.email) {
      skip(c.line, `The mobile number already belongs to ${maskEmail(u.email)}`);
      continue;
    }
    if (eu && !pu && c.phone && u.phone) {
      skip(c.line, 'This email already has a different mobile number');
      continue;
    }
    // Only fill in what is missing; never overwrite what the customer set.
    const set = {};
    if (!u.firstName && c.firstName) set.firstName = c.firstName;
    if (!u.lastName && c.lastName) set.lastName = c.lastName;
    if (!u.email && c.email) { set.email = c.email; set.emailVerified = emailsVerified; }
    if (u.email && u.email === c.email && emailsVerified && !u.emailVerified) set.emailVerified = true;
    if (!u.phone && c.phone) { set.phone = c.phone; set.phoneVerified = false; }
    if (Object.keys(set).length) plan.update.push({ id: u._id, set });
    else plan.unchanged += 1;
  }
  return plan;
}

/** Saves an import plan. Returns { created, updated, failed }. */
export async function applyImport(plan) {
  let created = 0;
  let failed = 0;
  for (let i = 0; i < plan.create.length; i += 1000) {
    const batch = plan.create.slice(i, i + 1000);
    try {
      const docs = await User.insertMany(batch, { ordered: false });
      created += docs.length;
    } catch (e) {
      // A customer signed up with the same email / mobile meanwhile.
      const errors = e.writeErrors?.length ?? 0;
      failed += errors || batch.length;
      created += e.insertedDocs?.length ?? (errors ? batch.length - errors : 0);
    }
  }
  let updated = 0;
  for (let i = 0; i < plan.update.length; i += 1000) {
    const ops = plan.update.slice(i, i + 1000).map((u) => ({ updateOne: { filter: { _id: u.id }, update: { $set: u.set } } }));
    try {
      const res = await User.bulkWrite(ops, { ordered: false });
      updated += res.modifiedCount ?? 0;
    } catch (e) {
      updated += e.result?.modifiedCount ?? 0;
      failed += e.writeErrors?.length ?? 0;
    }
  }
  return { created, updated, failed };
}

export const IMPORT_TEMPLATE = csvLine(['first_name', 'last_name', 'email', 'phone'])
  + csvLine(['Asha', 'Sharma', 'asha@example.com', '9876543210'])
  + csvLine(['Rahul', 'Verma', 'rahul@example.com', '+919812345678']);

// ---------- export ----------

export const EXPORT_COLUMNS = [
  'first_name', 'last_name', 'email', 'phone', 'email_verified', 'phone_verified', 'status',
  'customer_list', 'stores', 'sign_in_methods', 'last_login_at', 'created_at',
];

/** Writes the customers of one customer list (or all) as CSV to `res`. */
export async function writeExport(res, group) {
  res.write(csvLine(EXPORT_COLUMNS));
  const cursor = User.find(group ? { group } : {}).sort({ createdAt: 1 }).lean().cursor();
  for await (const u of cursor) {
    res.write(csvLine([
      u.firstName, u.lastName, u.email, u.phone, u.emailVerified ? 'yes' : 'no', u.phoneVerified ? 'yes' : 'no', u.status,
      u.group || 'default', (u.stores || []).join(' '), (u.identities || []).map((i) => i.provider).join(' '),
      u.lastLoginAt ? u.lastLoginAt.toISOString() : '', u.createdAt ? u.createdAt.toISOString() : '',
    ]));
  }
  res.end();
}
