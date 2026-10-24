// Server settings come from .env. SMS / email / social keys / OTP rules can be
// overridden from the admin panel (src/settings.js). Stores live in MongoDB.
import 'dotenv/config';

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// On Render, the service's own https://<name>.onrender.com address is used
// when ISSUER is not set. Set ISSUER once you use your own domain.
if (!process.env.ISSUER && process.env.RENDER_EXTERNAL_URL) process.env.ISSUER = process.env.RENDER_EXTERNAL_URL;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required setting in .env: ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: num(process.env.PORT, 3000),
  // Public HTTPS address of this server, e.g. https://auth.yourstore.com
  issuer: required('ISSUER').replace(/\/$/, ''),
  mongoUri: required('MONGODB_URI'),
  cookieKeys: list(required('COOKIE_KEYS')),
  otpSecret: required('OTP_SECRET'),
  storesDir: process.env.STORES_DIR || '',
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '91').replace('+', ''),

  otp: {
    length: Math.min(8, Math.max(4, num(process.env.OTP_LENGTH, 6))),
    ttlSeconds: num(process.env.OTP_TTL_SECONDS, 600),
    maxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),
    resendCooldownSeconds: num(process.env.OTP_RESEND_COOLDOWN_SECONDS, 30),
  },

  mail: {
    // 'console' prints emails in the terminal (testing). 'smtp' sends real email.
    transport: process.env.MAIL_TRANSPORT || 'console',
    from: process.env.MAIL_FROM || 'no-reply@example.com',
    smtp: {
      host: process.env.SMTP_HOST,
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE),
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    },
  },

  sms: {
    // 'console' | 'gupshup' | 'msg91' | 'twilio'
    provider: process.env.SMS_PROVIDER || 'console',
    // Default SMS text; a store can override it with "smsTemplate". {otp} = the code.
    template: process.env.SMS_TEMPLATE || 'Your verification code is {otp}.',
    gupshup: {
      userId: process.env.GUPSHUP_USERID,
      password: process.env.GUPSHUP_PASSWORD,
      mask: process.env.GUPSHUP_MASK,
      principalEntityId: process.env.GUPSHUP_PRINCIPAL_ENTITY_ID,
      dltTemplateId: process.env.GUPSHUP_DLT_TEMPLATE_ID,
      endpoint: process.env.GUPSHUP_ENDPOINT || 'https://enterprise.smsgupshup.com/GatewayAPI/rest',
    },
    msg91: { authKey: process.env.MSG91_AUTH_KEY, templateId: process.env.MSG91_TEMPLATE_ID },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      from: process.env.TWILIO_FROM,
    },
  },

  google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
  facebook: {
    appId: process.env.FACEBOOK_APP_ID,
    appSecret: process.env.FACEBOOK_APP_SECRET,
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v21.0',
    trustEmail: bool(process.env.FACEBOOK_TRUST_EMAIL, true),
  },
  apple: {
    clientId: process.env.APPLE_CLIENT_ID,
    teamId: process.env.APPLE_TEAM_ID,
    keyId: process.env.APPLE_KEY_ID,
    privateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  // /dev test page that acts like Shopify. Keep false on the live server.
  devTestClient: bool(process.env.DEV_TEST_CLIENT),

  ttl: {
    accessToken: num(process.env.ACCESS_TOKEN_TTL, 3600),
    idToken: num(process.env.ID_TOKEN_TTL, 3600),
    refreshToken: num(process.env.REFRESH_TOKEN_TTL, 60 * 60 * 24 * 30),
    session: num(process.env.SESSION_TTL, 60 * 60 * 24 * 30),
  },
};

// Which social logins have keys. Kept as one object (others hold a reference)
// and refreshed when keys change in the admin panel.
export const enabledSocial = {};
export function refreshSocial() {
  enabledSocial.google = Boolean(config.google.clientId && config.google.clientSecret);
  enabledSocial.facebook = Boolean(config.facebook.appId && config.facebook.appSecret);
  enabledSocial.apple = Boolean(config.apple.clientId && config.apple.teamId && config.apple.keyId && config.apple.privateKey);
  return enabledSocial;
}
refreshSocial();
