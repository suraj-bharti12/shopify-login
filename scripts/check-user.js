// Shows why a customer can't log in with email + password.
//   npm run user:check -- someone@gmail.com "TheirPassword"
// The password is only compared on your computer; it is never printed or saved.
import mongoose from 'mongoose';
import { connectDb, User } from '../src/db.js';
import { normalizeEmail } from '../src/users.js';

const [rawEmail, password] = process.argv.slice(2);
const email = normalizeEmail(rawEmail);
if (!email) {
  console.error('Usage: npm run user:check -- <email> "<password>"');
  process.exit(1);
}

try {
  await connectDb();
  console.log(`Database: ${mongoose.connection.name}`);
  const exact = await User.find({ email }).select('+passwordHash');
  const similar = await User.find({ email: new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { email: 1 });

  if (!exact.length) {
    console.log(`\nNo customer with email "${email}" in this database.`);
    if (similar.length) console.log('Similar emails found:', similar.map((u) => JSON.stringify(u.email)).join(', '));
    console.log('-> Use "Forgot Password?" with this exact email to create the password.');
  }
  for (const u of exact) {
    console.log(`\nCustomer ${u.id}`);
    console.log(`  customer list:  ${u.group || 'default'}  (stores: ${(u.stores || []).join(', ') || '-'})`);
    console.log(`  name:           ${[u.firstName, u.lastName].filter(Boolean).join(' ') || '-'}`);
    console.log(`  phone:          ${u.phone || '-'} ${u.phone ? (u.phoneVerified ? '(verified)' : '(not verified)') : ''}`);
    console.log(`  email verified: ${u.emailVerified}`);
    console.log(`  status:         ${u.status}`);
    console.log(`  has password:   ${Boolean(u.passwordHash)}`);
    console.log(`  last login:     ${u.lastLoginMethod || '-'} ${u.lastLoginAt ? u.lastLoginAt.toISOString() : ''}`);
    console.log(`  updated:        ${u.updatedAt?.toISOString()}`);
    if (password !== undefined) {
      if (!u.passwordHash) console.log('  -> No password saved. Use "Forgot Password?" to create one.');
      else if (await u.checkPassword(password)) console.log('  -> Password MATCHES. Login should work.');
      else if (await u.checkPassword(password.trim())) console.log('  -> Matches only without the spaces at the start/end.');
      else console.log('  -> Password does NOT match. Use "Forgot Password?" to set a new one.');
    }
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
