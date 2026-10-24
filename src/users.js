// Input checks and account helpers (merging, social linking).
import { config } from './config.js';
import { User } from './db.js';

export function normalizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

// Returns E.164 (+<country><number>) or null. 10 digits get DEFAULT_COUNTRY_CODE.
export function normalizePhone(v) {
  let p = String(v || '').replace(/[\s\-().]/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (!p.startsWith('+')) {
    p = p.replace(/^0+/, '');
    p = p.length === 10 ? `+${config.defaultCountryCode}${p}` : `+${p}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

export const looksLikeEmail = (v) => String(v || '').includes('@');

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

export const cleanName = (v) => String(v || '').trim().slice(0, 80);

// Moves phone + social logins from `from` into `to`, then deletes `from`.
export async function mergeInto(to, from) {
  if (!to.phone && from.phone) {
    to.phone = from.phone;
    to.phoneVerified = from.phoneVerified;
  }
  for (const id of from.identities) {
    if (!to.identities.some((x) => x.provider === id.provider && x.providerUserId === id.providerUserId)) to.identities.push(id);
  }
  for (const s of from.stores) if (!to.stores.includes(s)) to.stores.push(s);
  if (!to.firstName && from.firstName) to.firstName = from.firstName;
  if (!to.lastName && from.lastName) to.lastName = from.lastName;
  to.emailVerified = true;
  await User.deleteOne({ _id: from._id });
  await to.save();
  return to;
}

// Customer proved they own `email`. If another account in the same customer
// group has it, merge into that one.
export async function attachVerifiedEmail(user, email) {
  const owner = await User.findOne({ email, group: user.group, _id: { $ne: user._id } });
  if (owner) return mergeInto(owner, user);
  user.email = email;
  user.emailVerified = true;
  await user.save();
  return user;
}

// Finds or creates the customer (in this customer group) for a Google /
// Facebook / Apple profile.
export async function upsertSocialUser(profile, group = 'default') {
  const { provider: p, providerUserId } = profile;

  // 1. Already linked
  const candidates = await User.find({ group, 'identities.provider': p, 'identities.providerUserId': providerUserId });
  let user = candidates.find((u) => u.identities.some((i) => i.provider === p && i.providerUserId === providerUserId));
  if (user) {
    if (profile.email && profile.emailVerified && !user.emailVerified && user.email === profile.email) {
      user.emailVerified = true;
      await user.save();
    }
    return { user, isNew: false };
  }

  const identity = { provider: p, providerUserId, email: profile.email };

  // 2. Same verified email already has an account -> link to it
  if (profile.email && profile.emailVerified) {
    user = await User.findOne({ group, email: profile.email });
    if (user) {
      user.identities.push(identity);
      user.emailVerified = true;
      if (!user.firstName && profile.firstName) user.firstName = profile.firstName;
      if (!user.lastName && profile.lastName) user.lastName = profile.lastName;
      await user.save();
      return { user, isNew: false };
    }
  }

  // 3. New customer
  user = new User({ group, firstName: profile.firstName, lastName: profile.lastName, identities: [identity] });
  if (profile.email && !(await User.exists({ group, email: profile.email }))) {
    user.email = profile.email;
    user.emailVerified = profile.emailVerified;
  }
  await user.save();
  return { user, isNew: true };
}

export async function recordLogin(user, storeId, method) {
  user.lastLoginAt = new Date();
  user.lastLoginMethod = method;
  if (storeId && !user.stores.includes(storeId)) user.stores.push(storeId);
  await user.save();
}
