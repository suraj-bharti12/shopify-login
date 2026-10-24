// HTML pages served by this server. The login UI itself lives in
// public/login.js + public/login.css (same code as the store drawer).
import { config } from './config.js';
import { stores, publicConfig } from './stores.js';

export const ASSET_VERSION = '9';
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

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
export function loginPage({ store, returnTo, error, resume }) {
  const attrs = {
    idp: config.issuer,
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
  return shell(title, b, `<div class="idp idp--page" style="--idp-brand:${esc(b.color)}"><div class="idp-panel"><div class="idp-inner">
  <div class="idp-head">${b.welcome ? `<p class="idp-welcome">${esc(b.welcome)}</p>` : ''}${logo}</div>
  <hr class="idp-rule">
  <h2 class="idp-h">${esc(title)}</h2>
  <p class="idp-sub">${esc(message)}</p>
  ${back}
</div></div></div>`);
}

/** /dev test page: acts like Shopify and shows what Shopify would receive. */
export function devPage({ users = [], claims, shopifyOk, hasRefresh, logoutUrl, error, signedOut }) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</code></td></tr>`;
  const result = claims ? `
    <div class="dev-alert ${shopifyOk ? 'ok' : 'bad'}">${shopifyOk
    ? 'Login successful. Shopify yeh customer accept karega (email verified hai).'
    : 'Shopify yeh login reject karega: verified email nahi hai.'}</div>
    <h2>ID token jo Shopify ko milega</h2>
    <table class="kv">${Object.entries(claims).map(([k, v]) => row(k, v)).join('')}${row('refresh_token', hasRefresh ? 'issued' : 'not issued')}</table>
    <div class="actions"><a class="dbtn" href="/dev/start">Dobara login (session reuse test)</a><a class="dbtn primary" href="${esc(logoutUrl)}">Logout test</a></div>`
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
  </table></div>` : '<p class="muted">Abhi koi customer nahi. Upar se login karke dekho.</p>';

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
  <span class="badge">Test mode — Shopify ki jagah</span>
  <h1>Login tester</h1>
  <p class="muted">Yeh page bilkul Shopify ki tarah login shuru karta hai aur dikhata hai ki Shopify ko kya milega.</p>
  ${error ? `<div class="dev-alert bad">${esc(error)}</div>` : ''}
  ${signedOut ? '<div class="dev-alert ok">Signed out. Logout flow sahi kaam kar raha hai.</div>' : ''}
  ${result}
  <h2>Latest customers in MongoDB</h2>
  ${list}
</main>`, style);
}
