// Customer emails: login / verification codes and password reset links.
// Each store gets a branded design (logo, colour, support email) by default,
// and can replace the subject and HTML of each email in the admin panel.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const RESET_LINK_MINUTES = 30;

export const EMAIL_TYPES = {
  code: {
    label: 'Code email',
    help: 'Sent for email sign-in, email verification and password reset codes.',
    subject: '{{code}} is your {{store_name}} code',
    required: '{{code}}',
  },
  reset: {
    label: 'Password reset link email',
    help: 'Sent when the store resets passwords by email link.',
    subject: 'Reset your {{store_name}} password',
    required: '{{link}}',
  },
};

export const PLACEHOLDERS = [
  ['{{store_name}}', 'Store name'],
  ['{{logo_url}}', 'Logo URL'],
  ['{{brand_color}}', 'Brand colour, e.g. #8b1d24'],
  ['{{support_email}}', 'Support email'],
  ['{{store_url}}', 'Store website'],
  ['{{code}}', 'The code (code email)'],
  ['{{action}}', 'What the code is for, e.g. "sign in" (code email)'],
  ['{{link}}', 'The reset link (reset email)'],
  ['{{minutes}}', 'Minutes the code or link stays valid'],
];

const ACTIONS = { verify_email: 'verify your email', reset_password: 'reset your password' };

const fill = (tpl, vars, escape) => tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => {
  if (!(k in vars)) return m;
  return escape ? esc(vars[k]) : String(vars[k]);
});

function brandVars(store) {
  const b = store?.brand || {};
  const domain = store?.domains?.[0] || store?.shopDomain;
  return {
    store_name: b.name || store?.name || 'our store',
    logo_url: b.logoUrl || '',
    brand_color: /^#[0-9a-fA-F]{3,8}$/.test(b.color || '') ? b.color : '#111111',
    support_email: b.supportEmail || '',
    store_url: domain ? `https://${domain}` : '',
  };
}

// The default branded layout. Table-based with inline styles so it renders in
// Gmail, Outlook and phone mail apps.
function layout(v, inner) {
  const head = v.logo_url
    ? `<img src="${esc(v.logo_url)}" alt="${esc(v.store_name)}" style="max-height:48px;max-width:200px;border:0;display:block;margin:0 auto">`
    : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:600;color:${esc(v.brand_color)};text-align:center">${esc(v.store_name)}</div>`;
  const help = v.support_email
    ? `Need help? Write to <a href="mailto:${esc(v.support_email)}" style="color:${esc(v.brand_color)}">${esc(v.support_email)}</a>.`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.store_name)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb">
<tr><td style="padding:28px 32px 20px;border-bottom:3px solid ${esc(v.brand_color)}">${head}</td></tr>
<tr><td style="padding:28px 32px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:15px;line-height:1.6">${inner}</td></tr>
<tr><td style="padding:18px 32px 26px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:1.6;border-top:1px solid #f0f0ee">
If you didn't request this, you can ignore this email. ${help}</td></tr>
</table></td></tr></table></body></html>`;
}

function defaultHtml(type, v) {
  if (type === 'code') {
    return layout(v, `<p style="margin:0 0 16px">Use this code to ${esc(v.action)} at ${esc(v.store_name)}:</p>
<p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:700;color:#111111">${esc(v.code)}</p>
<p style="margin:0;color:#6b7280;font-size:13px">The code expires in ${esc(v.minutes)} minutes.</p>`);
  }
  return layout(v, `<p style="margin:0 0 20px">We received a request to set a new password for your ${esc(v.store_name)} account.</p>
<p style="margin:0 0 20px"><a href="${esc(v.link)}" style="display:inline-block;background:${esc(v.brand_color)};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px">Set a new password</a></p>
<p style="margin:0;color:#6b7280;font-size:13px">The link works once and expires in ${esc(v.minutes)} minutes. If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all">${esc(v.link)}</span></p>`);
}

function defaultText(type, v) {
  if (type === 'code') {
    return `Use ${v.code} to ${v.action} at ${v.store_name}. This code expires in ${v.minutes} minutes.\n\nIf you didn't request this, you can ignore this email.`;
  }
  return `Set a new password for your ${v.store_name} account:\n${v.link}\n\nThe link works once and expires in ${v.minutes} minutes. If you didn't request this, you can ignore this email.`;
}

/**
 * Builds one email for a store. `type` is "code" or "reset"; `data` holds
 * { code, purpose, minutes } or { link, minutes }.
 */
export function renderEmail(type, store, data) {
  const v = {
    ...brandVars(store),
    code: data.code || '',
    action: ACTIONS[data.purpose] || 'sign in',
    link: data.link || '',
    minutes: data.minutes ?? '',
  };
  const custom = store?.emails || {};
  const subject = fill(custom[`${type}Subject`] || EMAIL_TYPES[type].subject, v, false).replace(/[\r\n]+/g, ' ');
  const html = custom[`${type}Html`] ? fill(custom[`${type}Html`], v, true) : defaultHtml(type, v);
  return { subject, html, text: defaultText(type, v) };
}
