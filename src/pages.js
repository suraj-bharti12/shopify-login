// HTML pages served by this server. The login UI itself lives in
// public/login.js + public/login.css (same code as the store drawer).
import { config } from './config.js';
import { stores, publicConfig, designClasses } from './stores.js';
import { passwordRules } from './users.js';

export const ASSET_VERSION = '19';
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// The store's own CSS (admin panel → store → Login window design).
const storeCss = (store) => (store?.customCss ? `<style data-store-css>${store.customCss}</style>` : '');

function shell(title, brand, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(brand.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/static/login.css?v=${ASSET_VERSION}">
${extraHead}
</head>
<body class="idp-page">
${body}
</body>
</html>`;
}

const dataAttrs = (obj) => Object.entries(obj)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');

/**
 * Hosted login page (checkout "Sign in", direct Shopify login, or continuing
 * after Google/Facebook when an email is still needed).
 */
export function loginPage({
  store, returnTo, error, resume, idp = config.issuer,
}) {
  const attrs = {
    idp,
    store: store.id,
    mode: 'page',
    'return-to': returnTo,
    error,
    config: JSON.stringify(publicConfig(store)),
  };
  if (resume) {
    Object.assign(attrs, {
      flow: resume.flowId, step: 'profile', 'need-name': resume.needName ? '1' : '', email: resume.email,
    });
  }
  return shell('Login', store.brand, `<div id="idp-login"${dataAttrs(attrs)}></div>
<script src="/static/login.js?v=${ASSET_VERSION}"></script>`);
}

export function messagePage({ title, message, store }) {
  const s = store || stores.fallback();
  const b = s.brand;
  const logo = b.logoUrl
    ? `<img class="idp-logo" src="${esc(b.logoUrl)}" alt="${esc(b.name)}">`
    : `<div class="idp-wordmark">${esc(b.name)}</div>`;
  const back = s.origins?.[0] ? `<a class="idp-btn" href="${esc(s.origins[0])}">Back to store</a>` : '';
  return shell(title, b, `${storeCss(store)}<div class="idp idp--page ${designClasses(store?.design)}" style="--idp-brand:${esc(b.color)}"><div class="idp-panel"><div class="idp-inner">
  <div class="idp-head">${b.welcome ? `<p class="idp-welcome">${esc(b.welcome)}</p>` : ''}${logo}</div>
  <hr class="idp-rule">
  <h2 class="idp-h">${esc(title)}</h2>
  <p class="idp-sub">${esc(message)}</p>
  ${back}
</div></div></div>`);
}

function brandHead(b) {
  const logo = b.logoUrl
    ? `<img class="idp-logo" src="${esc(b.logoUrl)}" alt="${esc(b.name)}">`
    : `<div class="idp-wordmark">${esc(b.name)}</div>`;
  return `<div class="idp-head">${b.welcome ? `<p class="idp-welcome">${esc(b.welcome)}</p>` : ''}${logo}</div><hr class="idp-rule">`;
}

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const pwInput = (name, ph, auto = 'new-password') => `<div class="idp-pw"><input name="${name}" type="password" autocomplete="${auto}" placeholder="${ph}" aria-label="${ph}" required>
  <button type="button" class="idp-eye" aria-label="Show password" data-eye>${EYE}</button></div>`;

/** Page opened from the password reset email (store setting "Link by email"). */
export function resetPasswordPage({ store, token, email, error }) {
  const b = store.brand;
  return shell('Set a new password', b, `${storeCss(store)}<div class="idp idp--page ${designClasses(store?.design)}" style="--idp-brand:${esc(b.color)}"><div class="idp-panel"><div class="idp-inner">
  ${brandHead(b)}
  <h2 class="idp-h">Set New Password</h2>
  <p class="idp-sub">For ${esc(email)}</p>
  <div class="idp-error" role="alert"${error ? '' : ' hidden'}>${esc(error || '')}</div>
  <form class="idp-view" method="post" action="/reset-password">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="email" name="username" value="${esc(email)}" autocomplete="username" hidden>
    ${pwInput('password', 'New password')}
    ${pwInput('confirmPassword', 'Confirm new password')}
    <div class="idp-rules" data-rules><p>Your password must contain:</p><ul>${passwordRules(store.passwordRule)
    .map((r) => `<li data-pattern="${esc(r.pattern)}">${esc(r.label)}</li>`).join('')}</ul></div>
    <button class="idp-btn" type="submit">Save password</button>
  </form>
</div></div></div>
<script src="/static/reset.js?v=${ASSET_VERSION}"></script>`);
}

/** After a password was set from the email link. */
export function resetDonePage({ store, continueUrl, signedIn = true }) {
  const b = store.brand;
  const name = esc(b.name || store.name);
  return shell('Password updated', b, `${storeCss(store)}<div class="idp idp--page ${designClasses(store?.design)}" style="--idp-brand:${esc(b.color)}"><div class="idp-panel"><div class="idp-inner">
  ${brandHead(b)}
  <h2 class="idp-h">Password Updated</h2>
  <p class="idp-sub">${signedIn
    ? `Your new password is saved. Continue to ${name} to finish signing in.`
    : `Your new password is saved. Go back to ${name} and sign in with your email and new password.`}</p>
  <p class="idp-muted" style="margin:0 0 18px">Still have ${name} open in another tab? It has moved on to sign-in, so you can also close this tab and continue there.</p>
  <a class="idp-btn" href="${esc(continueUrl)}">${signedIn ? `Continue to ${name}` : `Back to ${name}`}</a>
</div></div></div>`);
}

/** /dev test page: acts like Shopify and shows what Shopify would receive. */
export function devPage({ users = [], claims, shopifyOk, hasRefresh, logoutUrl, error, signedOut }) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</code></td></tr>`;
  const result = claims ? `
    <div class="dev-alert ${shopifyOk ? 'ok' : 'bad'}">${shopifyOk
    ? 'Sign-in successful. Shopify will accept this customer (email verified).'
    : 'Shopify will reject this sign-in: the email is not verified.'}</div>
    <h2>ID token Shopify receives</h2>
    <table class="kv">${Object.entries(claims).map(([k, v]) => row(k, v)).join('')}${row('refresh_token', hasRefresh ? 'issued' : 'not issued')}</table>
    <div class="actions"><a class="dbtn" href="/dev/start">Sign in again (session reuse test)</a><a class="dbtn primary" href="${esc(logoutUrl)}">Sign-out test</a></div>`
    : `<div class="actions"><a class="dbtn primary" href="/dev/start">Start test login</a><a class="dbtn" href="/dev/start?prompt=login">Force login screen</a></div>`;

  const list = users.length ? `<div class="scroll"><table class="list">
    <tr><th>Name</th><th>Email</th><th>Mobile</th><th>Linked</th><th>Stores</th><th>Last method</th></tr>
    ${users.map((u) => `<tr>
      <td>${esc([u.firstName, u.lastName].filter(Boolean).join(' ') || '—')}</td>
      <td>${esc(u.email || '—')} ${u.email ? (u.emailVerified ? '✓' : '(unverified)') : ''}</td>
      <td>${esc(u.phone || '—')} ${u.phone ? (u.phoneVerified ? '✓' : '(unverified)') : ''}</td>
      <td>${esc((u.identities || []).map((i) => i.provider).join(', ') || '—')}</td>
      <td>${esc((u.stores || []).join(', ') || '—')}</td>
      <td>${esc(u.lastLoginMethod || '—')}</td></tr>`).join('')}
  </table></div>` : '<p class="muted">No customers yet. Sign in above to create one.</p>';

  const style = `<style>
    body.idp-page{font-family:Inter,system-ui,sans-serif;color:#111}
    .dev{max-width:780px;margin:40px auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px}
    .badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:#fef3c7;color:#92400e}
    .dev h1{font-size:22px;margin:12px 0 4px}.dev h2{font-size:16px;margin:24px 0 10px}.muted{color:#6b7280}
    .dev-alert{padding:10px 12px;border-radius:8px;margin:16px 0}.dev-alert.ok{background:#ecfdf3;color:#05603a}.dev-alert.bad{background:#fef3f2;color:#b42318}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    .dbtn{flex:1;min-width:200px;text-align:center;padding:11px;border:1px solid #111;border-radius:8px;color:#111;text-decoration:none;font-weight:600}
    .dbtn.primary{background:#111;color:#fff}
    .scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e5e7eb;padding:7px 8px;text-align:left;vertical-align:top}th{color:#6b7280}
    table.kv th{width:34%}code{word-break:break-all}
  </style>`;

  return shell('Login tester', stores.fallback().brand, `<main class="dev">
  <span class="badge">Test mode — stands in for Shopify</span>
  <h1>Login tester</h1>
  <p class="muted">This page starts a sign-in exactly as Shopify does and shows what Shopify receives.</p>
  ${error ? `<div class="dev-alert bad">${esc(error)}</div>` : ''}
  ${signedOut ? '<div class="dev-alert ok">Signed out. The sign-out flow works.</div>' : ''}
  ${result}
  <h2>Latest customers in MongoDB</h2>
  ${list}
</main>`, style);
}
