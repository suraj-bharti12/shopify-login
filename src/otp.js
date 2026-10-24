// One-time codes: create, send (email / SMS), verify.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { Otp } from './db.js';

export class OtpError extends Error {}

const hash = (code) => crypto.createHmac('sha256', config.otpSecret).update(code).digest('hex');

export function maskTarget(t) {
  if (t.includes('@')) {
    const [u, d] = t.split('@');
    return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
  }
  return `${t.slice(0, 3)}******${t.slice(-3)}`;
}

/** Creates a code for this login flow and sends it. `store` gives the SMS text and brand name. */
export async function issueOtp({ flowId, purpose, channel, target, userId, store }) {
  const last = await Otp.findOne({ target, purpose }).sort({ createdAt: -1 });
  const waitMs = last ? config.otp.resendCooldownSeconds * 1000 - (Date.now() - last.createdAt.getTime()) : 0;
  if (waitMs > 0) throw new OtpError(`Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`);

  await Otp.deleteMany({ target, purpose, consumedAt: { $exists: false } }); // only the newest code works
  const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');
  const otp = await Otp.create({
    flowId, purpose, channel, target, userId,
    codeHash: hash(code),
    expiresAt: new Date(Date.now() + config.otp.ttlSeconds * 1000),
  });

  try {
    if (channel === 'email') await sendEmail(target, code, purpose, store?.brand?.name);
    else await sendSms(target, code, store?.smsTemplate);
  } catch (err) {
    console.error(`[otp] could not send ${channel} to ${maskTarget(target)}:`, channel === 'email' ? explainMailError(err) : err.message);
    await Otp.deleteOne({ _id: otp._id });
    throw new OtpError(channel === 'sms'
      ? 'We couldn’t send the SMS right now. Please try again in a moment.'
      : 'We couldn’t send the email right now. Please try again in a moment.');
  }
  return otp;
}

export async function verifyOtp({ otpId, flowId, code }) {
  const otp = await Otp.findOne({ _id: otpId, flowId });
  if (!otp || otp.consumedAt || otp.expiresAt < new Date()) throw new OtpError('This code has expired. Please request a new one.');
  if (otp.attempts >= config.otp.maxAttempts) throw new OtpError('Too many wrong attempts. Please request a new code.');
  const ok = crypto.timingSafeEqual(Buffer.from(hash(String(code || '').trim())), Buffer.from(otp.codeHash));
  if (!ok) {
    otp.attempts += 1;
    await otp.save();
    const left = config.otp.maxAttempts - otp.attempts;
    throw new OtpError(left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Too many wrong attempts. Please request a new code.');
  }
  const consumed = await Otp.findOneAndUpdate(
    { _id: otp._id, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!consumed) throw new OtpError('This code was already used.');
  return consumed;
}

// ---------- Email ----------

let transporter;
// Called when email settings change in the admin panel.
export function resetMailer() { transporter = undefined; }
function mailer() {
  if (!transporter) {
    transporter = config.mail.transport === 'smtp'
      // Short timeouts: a blocked port fails in seconds instead of hanging for minutes.
      ? nodemailer.createTransport({ ...config.mail.smtp, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 })
      : { sendMail: async (m) => console.log(`\n[mail:console] To: ${m.to}\nSubject: ${m.subject}\n${m.text}\n`) };
  }
  return transporter;
}

/** Turns SMTP errors into something the admin can act on. */
export function explainMailError(e) {
  const where = `${config.mail.smtp.host}:${config.mail.smtp.port}`;
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].includes(e.code) || /timeout/i.test(e.message)) {
    return `Could not reach ${where}. On Render's free plan ports 25, 465 and 587 are blocked: use port 2525 (Brevo) with SSL off.`;
  }
  if (e.code === 'EAUTH') return `${where} refused the SMTP user or password. Check the SMTP user and key.`;
  if (/sender|not verified|not allowed/i.test(e.message)) return `The From address is not allowed: verify it with your email provider. (${e.message})`;
  return e.message;
}

/** Admin panel "Send test email". */
export async function sendTestEmail(to) {
  try {
    await mailer().sendMail({
      from: config.mail.from,
      to,
      subject: 'Test email from your login server',
      text: 'It works! Customers will receive their login codes from this address.',
    });
  } catch (e) {
    throw new Error(explainMailError(e));
  }
}

async function sendEmail(to, code, purpose, brand = 'our store') {
  const what = { verify_email: 'verify your email', reset_password: 'reset your password' }[purpose] || 'sign in';
  const minutes = Math.round(config.otp.ttlSeconds / 60);
  await mailer().sendMail({
    from: config.mail.from,
    to,
    subject: `${code} is your ${brand} code`,
    text: `Use ${code} to ${what} at ${brand}. This code expires in ${minutes} minutes.\n\nIf you didn't request this, you can ignore this email.`,
    html: `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:440px;margin:auto;padding:24px;color:#111">
      <h2 style="margin:0 0 8px">${brand}</h2><p style="margin:0 0 16px">Use this code to ${what}:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:0 0 16px">${code}</p>
      <p style="color:#6b7280;font-size:13px;margin:0">It expires in ${minutes} minutes. If you didn't request this, ignore this email.</p></div>`,
  });
}

// ---------- SMS ----------

export const smsText = (code, template = config.sms.template) => template.replace(/\{otp\}/gi, code);

export async function sendSms(phone, code, template) {
  const text = smsText(code, template);
  const { provider } = config.sms;

  if (provider === 'console') {
    console.log(`\n[sms:console] To: ${phone}  Code: ${code}\n  Text: ${text}\n`);
    return { raw: 'console' };
  }

  if (provider === 'gupshup') {
    const g = config.sms.gupshup;
    if (!g.userId || !g.password) throw new Error('GUPSHUP_USERID / GUPSHUP_PASSWORD missing in .env');
    const body = new URLSearchParams({
      method: 'sendMessage', userid: g.userId, password: g.password, auth_scheme: 'plain', v: '1.1',
      format: 'text', msg_type: 'TEXT', send_to: phone.replace('+', ''), msg: text,
    });
    if (g.mask) body.set('mask', g.mask);
    if (g.principalEntityId) body.set('principalEntityId', g.principalEntityId);
    if (g.dltTemplateId) body.set('dltTemplateId', g.dltTemplateId);
    const res = await fetch(g.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000),
    });
    const raw = (await res.text()).trim(); // "success | 9198... | id"  or  "error | 105 | reason"
    const [status, ...rest] = raw.split('|').map((s) => s.trim());
    if (!res.ok || status.toLowerCase() !== 'success') throw new Error(`Gupshup: ${rest.join(' | ') || raw || res.status}`);
    return { raw };
  }

  if (provider === 'msg91') {
    const { authKey, templateId } = config.sms.msg91;
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.search = new URLSearchParams({ template_id: templateId, mobile: phone.replace('+', ''), otp: code });
    const res = await fetch(url, { method: 'POST', headers: { authkey: authKey, 'content-type': 'application/json' }, body: '{}' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.type === 'error') throw new Error(`MSG91: ${j.message || res.status}`);
    return { raw: JSON.stringify(j) };
  }

  if (provider === 'twilio') {
    const { accountSid, authToken, from } = config.sms.twilio;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: text }),
    });
    if (!res.ok) throw new Error(`Twilio: ${res.status} ${await res.text()}`);
    return { raw: 'twilio ok' };
  }

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}