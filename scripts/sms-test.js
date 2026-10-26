// Sends one test OTP SMS with the saved settings (same as Admin > Settings > Send a test SMS).
//   npm run sms:test -- 9876543210               (default SMS text)
//   npm run sms:test -- 9876543210 berrylush06   (that store's SMS text)
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { loadSettings, forStore } from '../src/settings.js';
import { stores } from '../src/stores.js';
import { normalizePhone } from '../src/users.js';
import { sendSms, smsText } from '../src/otp.js';

const phone = normalizePhone(process.argv[2]);
if (!phone) {
  console.error('Usage: npm run sms:test -- <mobile number> [store id]');
  process.exit(1);
}
try {
  await connectDb();
  await loadSettings();
  await stores.reload();
  const store = stores.get(process.argv[3]);
  const template = store?.smsTemplate;
  const sms = store ? forStore(store).sms : config.sms;
  const code = String(Math.floor(Math.random() * 10 ** config.otp.length)).padStart(config.otp.length, '0');
  console.log(`Provider: ${sms.provider}${store?.own.sms ? ' (store\'s own)' : ''}\nTo:       ${phone}\nText:     ${smsText(code, template)}`);
  const r = await sendSms(phone, code, template, sms);
  console.log(`Sent. Gateway reply: ${r.raw}`);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
