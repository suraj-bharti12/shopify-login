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
  ['{{first_name}}', 'Customer\'s first name, or "there" if not known yet'],
  ['{{full_name}}', 'Customer\'s full name, or "there" if not known yet'],
  ['{{email}}', 'The customer\'s email address (where this email is sent)'],
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
 * { code, purpose, minutes } or { link, minutes }, plus the customer's
 * { email, firstName, lastName } when known.
 */
export function renderEmail(type, store, data) {
  const v = {
    ...brandVars(store),
    code: data.code || '',
    action: ACTIONS[data.purpose] || 'sign in',
    link: data.link || '',
    minutes: data.minutes ?? '',
    email: data.email || '',
    first_name: data.firstName || 'there',
    full_name: [data.firstName, data.lastName].filter(Boolean).join(' ') || 'there',
  };
  const custom = store?.emails || {};
  const subject = fill(custom[`${type}Subject`] || EMAIL_TYPES[type].subject, v, false).replace(/[\r\n]+/g, ' ');
  const html = custom[`${type}Html`] ? fill(custom[`${type}Html`], v, true) : defaultHtml(type, v);
  return { subject, html, text: defaultText(type, v) };
}

// Starter HTML for the admin panel's "Insert starter template" button: a
// complete email the admin can edit. Header band in the brand colour with the
// logo, greeting with the customer's name, button, fallback link and support.
const starterShell = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff">

      <!-- Header: logo + title on the brand colour -->
      <tr><td style="background:{{brand_color}};padding:20px 32px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td align="left"><img src="{{logo_url}}" alt="{{store_name}}" height="44" style="display:block;height:44px;border:0;color:#ffffff;font:bold 20px Georgia,serif"></td>
          <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#ffffff;font-weight:bold">${title}</td>
        </tr></table>
      </td></tr>

${body}
      <!-- Footer -->
      <tr><td style="padding:0 48px 36px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#333333">
        <p style="margin:0 0 10px">For further queries, please email us at <a href="mailto:{{support_email}}" style="color:{{brand_color}}">{{support_email}}</a>.</p>
        <p style="margin:0 0 18px">Looking forward to assisting you again!</p>
        <p style="margin:0;font-weight:bold">Team {{store_name}}</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

export const STARTER_HTML = {
  reset: starterShell('Forgot Password', `      <!-- Message -->
      <tr><td style="padding:36px 48px 8px;font-family:Arial,Helvetica,sans-serif;color:#222222">
        <p style="margin:0 0 6px;font-size:14px">Hi {{full_name}},</p>
        <p style="margin:0 0 16px;font-size:22px;color:#111111">We got you!</p>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6">We've received a request to reset the password for your {{store_name}} account
          <a href="mailto:{{email}}" style="color:{{brand_color}}">{{email}}</a>. To set a new password, click the button below.</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="background:{{brand_color}};border-radius:3px">
            <a href="{{link}}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#ffffff;text-decoration:none">Reset Password</a>
          </td>
        </tr></table>
      </td></tr>

      <!-- Fallback link -->
      <tr><td style="padding:24px 48px 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#333333">
        <p style="margin:0 0 4px">If the button above doesn't work, copy the link below and paste it into your browser:</p>
        <p style="margin:0 0 16px;word-break:break-all"><a href="{{link}}" style="color:{{brand_color}}">{{link}}</a></p>
        <p style="margin:0 0 16px">This link works once and expires in {{minutes}} minutes. If you didn't ask to reset your password, you can ignore this email; your password will not change.</p>
      </td></tr>
`),
  code: starterShell('Your Code', `      <!-- Message -->
      <tr><td style="padding:36px 48px 8px;font-family:Arial,Helvetica,sans-serif;color:#222222">
        <p style="margin:0 0 6px;font-size:14px">Hi {{first_name}},</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6">Use this code to {{action}} at {{store_name}}:</p>
        <p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:bold;color:#111111">{{code}}</p>
        <p style="margin:0 0 16px;font-size:13px;color:#555555">The code expires in {{minutes}} minutes. If you didn't request it, you can ignore this email.</p>
      </td></tr>
`),
};
