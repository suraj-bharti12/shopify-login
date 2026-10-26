// HTML for the admin panel (/admin). Server-rendered, no build step.
import { config, enabledSocial } from './config.js';
import { esc, ASSET_VERSION } from './pages.js';
import {
  FIELDS, STORE_FIELDS, sourceOf, currentValue, storeCredValue,
} from './settings.js';
import { DEFAULT_BRAND, stores } from './stores.js';
import { issuerFor } from './issuers.js';

const V = ASSET_VERSION;
const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cormorant+Garamond:wght@400;500;600&display=swap';

const NAV = [
  ['dashboard', '/admin', 'Dashboard', 'M3 12l9-8 9 8M5 10v10h14V10'],
  ['stores', '/admin/stores', 'Stores', 'M4 7h16l-1 4H5L4 7zm1 4v9h14v-9M9 20v-5h6v5'],
  ['customers', '/admin/customers', 'Customers', 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 10v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8'],
  ['settings', '/admin/settings', 'Settings', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  ['guide', '/admin/guide', 'Setup guide', 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4zm0 13a3 3 0 0 1 3-3h11M8 8h6M8 11h4'],
  ['admins', '/admin/admins', 'Admins', 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z'],
];
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function head(title, extra = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Login Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/static/admin.css?v=${V}">${extra}
<script src="/static/admin.js?v=${V}" defer></script></head>`;
}

const flashBox = (f) => (f ? `<div class="flash flash-${f.type === 'error' ? 'error' : 'ok'}" role="${f.type === 'error' ? 'alert' : 'status'}">${esc(f.msg)}</div>` : '');
const csrfInput = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

/** Logged-in page frame. */
export function layout({ title, active, admin, csrf, flash, actions = '', body, extraHead = '' }) {
  return `${head(title, extraHead)}
<body class="adm">
<aside class="side">
  <a class="logo" href="/admin"><span class="logo-mark">ID</span><span>Login Admin</span></a>
  <nav>${NAV.map(([k, href, label, d]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${icon(d)}<span>${label}</span></a>`).join('')}</nav>
  <div class="me">
    <div class="me-who"><strong>${esc(admin.name || admin.email)}</strong><span>${esc(admin.email)}</span></div>
    <form method="post" action="/admin/logout">${csrfInput(csrf)}<button class="link" type="submit">Log out</button></form>
  </div>
</aside>
<main class="main">
  <header class="top"><h1>${esc(title)}</h1><div class="top-actions">${actions}</div></header>
  ${flashBox(flash)}
  ${body}
</main>
</body></html>`;
}

/** Login / first setup pages (not logged in). */
export function authPage({ title, intro, flash, form }) {
  return `${head(title)}
<body class="adm auth">
<main class="auth-card">
  <div class="logo"><span class="logo-mark">ID</span><span>Login Admin</span></div>
  <h1>${esc(title)}</h1>
  ${intro ? `<p class="muted">${intro}</p>` : ''}
  ${flashBox(flash)}
  ${form}
</main>
</body></html>`;
}

export function loginForm({ flash, email = '' }) {
  return authPage({
    title: 'Sign in',
    flash,
    form: `<form method="post" action="/admin/login" class="stack">
      <label>Email<input name="email" type="email" autocomplete="username" required autofocus value="${esc(email)}"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <p class="muted small">Forgot your password? Run <code>npm run admin:reset -- you@email.com NewPassword123</code> on the server.</p>`,
  });
}

export function setupForm({ flash, values = {} }) {
  return authPage({
    title: 'Create the first admin',
    intro: 'Enter the <strong>setup code</strong> printed in the server terminal (where <code>npm start</code> is running).',
    flash,
    form: `<form method="post" action="/admin/setup" class="stack">
      <label>Setup code<input name="code" required autofocus autocomplete="off" value="${esc(values.code || '')}"></label>
      <label>Your name<input name="name" autocomplete="name" value="${esc(values.name || '')}"></label>
      <label>Email<input name="email" type="email" autocomplete="username" required value="${esc(values.email || '')}"></label>
      <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="help">At least 8 characters, with letters and numbers.</span></label>
      <button class="btn primary" type="submit">Create admin</button>
    </form>`,
  });
}

// ---------- small pieces ----------

export const copyable = (value, { secret = false } = {}) => `<div class="copy${secret ? ' is-secret' : ''}">
  <code data-value="${esc(value)}">${secret ? '•'.repeat(24) : esc(value)}</code>
  ${secret ? '<button type="button" class="btn sm" data-reveal>Show</button>' : ''}
  <button type="button" class="btn sm" data-copy>Copy</button></div>`;

const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—');

// ---------- dashboard ----------

export function dashboardPage(ctx, { counts, storesList }) {
  const social = Object.entries(enabledSocial).filter(([, on]) => on).map(([k]) => k);
  const warn = [];
  if (config.sms.provider === 'console') warn.push(['SMS is in test mode: codes are only printed in the server terminal.', '/admin/settings#sms']);
  if (config.mail.transport === 'console') warn.push(['Email is in test mode: codes are only printed in the server terminal.', '/admin/settings#mail']);
  if (!storesList.length) warn.push(['No stores yet. Add your first store.', '/admin/stores/new']);
  if (config.isProd && config.devTestClient) warn.push(['The /dev test page is on in production. Set DEV_TEST_CLIENT=false in .env.', null]);
  if (/ngrok/.test(config.issuer)) warn.push(['The server runs on an ngrok address. Use your own domain before going live.', null]);

  const stat = (label, value, href) => `<a class="stat" ${href ? `href="${href}"` : ''}><span>${esc(label)}</span><strong>${esc(value)}</strong></a>`;
  return layout({
    ...ctx,
    title: 'Dashboard',
    active: 'dashboard',
    actions: '<a class="btn primary" href="/admin/stores/new">Add store</a>',
    body: `
    <section class="stats">
      ${stat('Stores', storesList.length, '/admin/stores')}
      ${stat('Customers', counts.customers, '/admin/customers')}
      ${stat('Logged in, last 7 days', counts.recent, '/admin/customers')}
      ${stat('New, last 7 days', counts.newCustomers, '/admin/customers')}
    </section>
    ${warn.length ? `<section class="card"><h2>Needs attention</h2><ul class="todo">${warn.map(([t, href]) => `<li>${href ? `<a href="${href}">${esc(t)}</a>` : esc(t)}</li>`).join('')}</ul></section>` : ''}
    <section class="card">
      <h2>Server</h2>
      <dl class="kv">
        <dt>Server address</dt><dd>${copyable(config.issuer)}</dd>
        <dt>Discovery URL</dt><dd>${copyable(`${config.issuer}/.well-known/openid-configuration`)}</dd>
        <dt>SMS</dt><dd>${badge(config.sms.provider, config.sms.provider === 'console' ? 'warn' : 'ok')}</dd>
        <dt>Email</dt><dd>${badge(config.mail.transport, config.mail.transport === 'console' ? 'warn' : 'ok')}</dd>
        <dt>Social logins</dt><dd>${social.length ? social.map((s) => badge(s, 'ok')).join(' ') : badge('none')}</dd>
      </dl>
    </section>`,
  });
}

// ---------- stores ----------

// Which customer list a store uses. Stores in the same group share customers.
function groupBadge(s) {
  const others = stores.all().filter((o) => o.id !== s.id && o.customerGroup === s.customerGroup);
  return others.length
    ? `${badge('shared', 'warn')} <span class="muted small">with ${esc(others.map((o) => o.name).join(', '))}</span>`
    : badge('separate', 'ok');
}

function groupLabel(group, exceptId) {
  const members = stores.all().filter((s) => s.customerGroup === group && s.id !== exceptId);
  return members.length ? `Shared with ${members.map((s) => s.name).join(', ')}` : `Group "${group}" (no other store)`;
}

function groupSelect(v, store, isNew) {
  const ownId = store?.id;
  const current = v.customerGroup || (isNew ? '__own' : store.customerGroup);
  const groups = [...new Set(stores.all().map((s) => s.customerGroup))]
    .filter((g) => g !== ownId && !(isNew && g === v.id));
  const selected = (g) => ((current === g || (g === '__own' && current === ownId)) ? ' selected' : '');
  const initial = isNew ? '' : (store.customerGroup === store.id ? '__own' : store.customerGroup);
  return `<label><span>Customer list</span>
    <select name="customerGroup" data-initial="${esc(initial)}">
      <option value="__own"${selected('__own')}>Separate — only this store's customers (recommended)</option>
      ${groups.map((g) => `<option value="${esc(g)}"${selected(g)}>${esc(groupLabel(g, ownId))}</option>`).join('')}
    </select>
    <span class="help">Separate: a customer of another store signs up fresh here, with their own name, email and password. Shared: one account works on all stores in the list.</span>
    <span class="field-warn" data-group-warn hidden>Changing this moves the store to a different customer list. Customers who already signed in here will start a new account. If Shopify then shows “sign-in method doesn't match”, open the customer in Shopify admin → Customers and remove the old sign-in link.</span>
    </label>`;
}

export function storesPage(ctx, { list, customerCounts }) {
  const rows = list.map((s) => `<tr>
    <td><a class="strong" href="/admin/stores/${esc(s.id)}">${esc(s.name)}</a><div class="muted small">${esc(s.id)}</div></td>
    <td>${esc(s.shopDomain)}${s.domains.length ? `<div class="muted small">${esc(s.domains.join(', '))}</div>` : ''}${s.loginDomain ? `<div class="small">login: ${esc(s.loginDomain)}</div>` : ''}</td>
    <td>${groupBadge(s)}${ownBadges(s) ? `<div class="small" style="margin-top:4px">${ownBadges(s)}</div>` : ''}</td>
    <td>${customerCounts[s.id] || 0}</td>
    <td class="right"><a class="btn sm" href="/admin/stores/${esc(s.id)}">Open</a></td></tr>`).join('');
  return layout({
    ...ctx,
    title: 'Stores',
    active: 'stores',
    actions: '<a class="btn primary" href="/admin/stores/new">Add store</a>',
    body: list.length ? `<section class="card flush"><table class="table">
      <thead><tr><th>Store</th><th>Shopify domain</th><th>Customer list</th><th>Customers</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`
      : `<section class="card empty"><h2>No stores yet</h2><p class="muted">Add a Shopify store to give it this login.</p>
         <a class="btn primary" href="/admin/stores/new">Add your first store</a></section>`,
  });
}

function storeForm({ store, values, error, isNew, csrf }) {
  const v = values || (store ? {
    id: store.id, name: store.name, shopDomain: store.shopDomain, shopId: store.shopId,
    welcome: store.brand.welcome, brandName: store.brand.name, logoUrl: store.brand.logoUrl, tagline: store.brand.tagline,
    color: store.brand.color, supportEmail: store.brand.supportEmail, afterLogin: store.afterLogin,
    smsTemplate: store.smsTemplate || '', domains: store.domains.join('\n'), accountDomain: store.accountDomain || '',
    extraRedirectUris: store.extraRedirectUris.join('\n'), extraLogoutUris: store.extraLogoutUris.join('\n'),
    customerGroup: store.customerGroup === store.id ? '__own' : store.customerGroup,
    loginDomain: store.loginDomain || '',
  } : { welcome: DEFAULT_BRAND.welcome, color: '#8b1d24', afterLogin: 'current' });
  const err = (f) => (error?.field === f ? `<span class="field-error">${esc(error.message)}</span>` : '');
  const bad = (f) => (error?.field === f ? ' aria-invalid="true"' : '');
  const color = /^#[0-9a-fA-F]{6}$/.test(v.color || '') ? v.color : '#8b1d24';
  const advancedOpen = ['domains', 'accountDomain', 'extraRedirectUris', 'extraLogoutUris'].includes(error?.field);

  return `<form method="post" action="${isNew ? '/admin/stores/new' : `/admin/stores/${esc(store.id)}`}" class="store-form">
  ${csrfInput(csrf)}
  <div class="grid-2">
    <div>
      <section class="card">
        <h2>Shopify store</h2>
        <label><span>Store ID${isNew ? '' : ' <span class="muted">(can\'t be changed)</span>'}</span>
          <input name="id" value="${esc(v.id || '')}" ${isNew ? 'required autofocus' : 'readonly'} placeholder="e.g. berrylush06" pattern="[a-z0-9\\-]{2,40}"${bad('id')}>
          <span class="help">Short name used inside the system. Lowercase letters, numbers, dashes.</span>${err('id')}</label>
        <label>Store name<input name="name" value="${esc(v.name || '')}" required placeholder="e.g. Berrylush"></label>
        <label>Shopify domain<input name="shopDomain" value="${esc(v.shopDomain || '')}" required placeholder="your-store.myshopify.com"${bad('shopDomain')}>${err('shopDomain')}</label>
        <label>Shop ID<input name="shopId" value="${esc(v.shopId || '')}" required inputmode="numeric" placeholder="e.g. 67933536438"${bad('shopId')}>
          <span class="help">Shopify admin → Settings → Customer accounts → Authentication → Connect → Custom. The callback URL there looks like <code>shopify.com/<b>67933536438</b>/…</code> — copy that number.</span>${err('shopId')}</label>
        <label>After login, send the customer to
          <select name="afterLogin">
            <option value="current"${v.afterLogin !== 'account' ? ' selected' : ''}>The same page they were on</option>
            <option value="account"${v.afterLogin === 'account' ? ' selected' : ''}>Their account (orders) page</option>
          </select></label>
        ${groupSelect(v, store, isNew)}${err('customerGroup')}
      </section>

      <section class="card">
        <h2>Login look</h2>
        <label>Welcome line<input name="welcome" value="${esc(v.welcome || '')}" data-preview="welcome" placeholder="Welcome to"></label>
        <label>Brand name<input name="brandName" value="${esc(v.brandName || '')}" data-preview="name" placeholder="Shown when there is no logo"></label>
        <label>Logo URL<input name="logoUrl" value="${esc(v.logoUrl || '')}" data-preview="logo" placeholder="https://cdn.shopify.com/…/logo.png"${bad('logoUrl')}>
          <span class="help">Upload the logo in Shopify admin → Content → Files and paste its link.</span>${err('logoUrl')}</label>
        <label>Tagline<textarea name="tagline" rows="2" data-preview="tagline">${esc(v.tagline || '')}</textarea></label>
        <div class="row-2">
          <label>Brand color<span class="color"><input type="color" value="${esc(color)}" data-color-picker><input name="color" value="${esc(v.color || '')}" data-preview="color" placeholder="#8b1d24"${bad('color')}></span>${err('color')}</label>
          <label>Support email<input name="supportEmail" type="email" value="${esc(v.supportEmail || '')}" placeholder="help@yourstore.com"></label>
        </div>
      </section>

      <section class="card" id="login-domain">
        <h2>Login domain</h2>
        <label><span>Login domain <span class="muted">(optional)</span></span>
          <input name="loginDomain" value="${esc(v.loginDomain || '')}" placeholder="login.yourbrand.com"${bad('loginDomain')} data-initial="${esc(store?.loginDomain || '')}"${isNew ? '' : ' data-domain-input'}>
          <span class="help">The address customers see on the login page and Shopify connects to, e.g. <code>login.berrylush.com</code>. Leave empty to use <code>${esc(new URL(config.issuer).host)}</code>. After saving, the store page shows the DNS record to add.</span>
          <span class="field-warn" data-domain-warn hidden>Changing this after the store is connected in Shopify: update the Discovery URL in Shopify and paste the new theme snippet. If Shopify has locked the Discovery URL (customers already signed in), deactivate that provider and connect a new one.</span>
          ${err('loginDomain')}</label>
      </section>

      <section class="card">
        <h2>SMS text</h2>
        <label>OTP SMS for this store<textarea name="smsTemplate" rows="3" placeholder="${esc(config.sms.template)}">${esc(v.smsTemplate || '')}</textarea>
          <span class="help">Write <code>{otp}</code> where the code goes. Must match the DLT-approved template word for word. Leave empty to use the default from Settings.</span></label>
      </section>

      ${sendingCard(store, values)}${err('creds')}

      <details class="card"${advancedOpen ? ' open' : ''}>
        <summary><h2>Advanced: custom domains</h2></summary>
        <label>Custom domains (one per line)<textarea name="domains" rows="2" placeholder="www.yourstore.com"${bad('domains')}>${esc(v.domains || '')}</textarea>
          <span class="help">The store's own domains, so the login drawer works there too.</span>${err('domains')}</label>
        <label>Account domain<input name="accountDomain" value="${esc(v.accountDomain || '')}" placeholder="account.yourstore.com"${bad('accountDomain')}>
          <span class="help">Only if Shopify's callback URL uses a custom account domain.</span>${err('accountDomain')}</label>
        <label>Extra callback URLs (one per line)<textarea name="extraRedirectUris" rows="2"${bad('extraRedirectUris')}>${esc(v.extraRedirectUris || '')}</textarea>${err('extraRedirectUris')}</label>
        <label>Extra sign-out URLs (one per line)<textarea name="extraLogoutUris" rows="2"${bad('extraLogoutUris')}>${esc(v.extraLogoutUris || '')}</textarea>${err('extraLogoutUris')}</label>
      </details>

      <div class="form-actions"><button class="btn primary" type="submit">${isNew ? 'Create store' : 'Save changes'}</button>
        ${isNew ? '<a class="btn" href="/admin/stores">Cancel</a>' : ''}</div>
    </div>

    <aside class="preview-wrap">
      <div class="preview-label">Preview</div>
      <div class="preview">
        <div class="idp idp--page" data-preview-root style="--idp-brand:${esc(color)}"><div class="idp-panel"><div class="idp-inner">
          <div class="idp-head">
            <p class="idp-welcome" data-pv="welcome">${esc(v.welcome || '')}</p>
            <img class="idp-logo" data-pv="logo" alt="" ${v.logoUrl ? `src="${esc(v.logoUrl)}"` : 'hidden'}>
            <div class="idp-wordmark" data-pv="name"${v.logoUrl ? ' hidden' : ''}>${esc(v.brandName || v.name || 'Your brand')}</div>
            <p class="idp-tagline" data-pv="tagline"${v.tagline ? '' : ' hidden'}>${esc(v.tagline || '')}</p>
          </div>
          <hr class="idp-rule">
          <h2 class="idp-h">Login or Create an Account</h2>
          <div class="idp-view">
            <label class="idp-phone"><span class="idp-cc">+${esc(config.defaultCountryCode)}</span><input placeholder="Mobile number" disabled></label>
            <button class="idp-btn" type="button" tabindex="-1">Continue with mobile number</button>
          </div>
        </div></div></div>
      </div>
    </aside>
  </div>
</form>`;
}

export function newStorePage(ctx, { values, error }) {
  return layout({
    ...ctx,
    title: 'Add store',
    active: 'stores',
    extraHead: `<link rel="stylesheet" href="/static/login.css?v=${V}">`,
    body: `<p class="lead">Fill this in, save, and you'll get everything to paste into Shopify.</p>
      ${error && !error.field ? `<div class="flash flash-error">${esc(error.message)}</div>` : ''}
      ${storeForm({ values, error, isNew: true, csrf: ctx.csrf })}`,
  });
}

export function themeSnippet(store) {
  return `{%- comment -%} Login drawer for ${store.name}. Design comes from the login server. {%- endcomment -%}
{%- unless customer -%}
<div id="idp-login" data-idp="${issuerFor(store)}" data-store="${store.id}" hidden></div>
<script>
  fetch('${issuerFor(store)}/widget.js', { headers: { 'ngrok-skip-browser-warning': '1' } })
    .then(function (r) { return r.text(); })
    .then(function (code) { var s = document.createElement('script'); s.textContent = code; document.body.appendChild(s); });
</script>
{%- endunless -%}`;
}

export function storePage(ctx, { store, secret, values, error, customerCount }) {
  let stepNo = 0;
  const step = (_, title, body) => `<li><span class="step-n">${++stepNo}</span><div><h3>${title}</h3>${body}</div></li>`;
  return layout({
    ...ctx,
    title: store.name,
    active: 'stores',
    extraHead: `<link rel="stylesheet" href="/static/login.css?v=${V}">`,
    actions: `<span class="muted">${esc(store.shopDomain)}${store.loginDomain ? ` · login: ${esc(store.loginDomain)}` : ''} · ${customerCount} customers</span> ${groupBadge(store)} ${ownBadges(store)}`,
    body: `
    <section class="card">
      <h2>Connect in Shopify</h2>
      <ol class="steps">
        ${store.loginDomain ? step(0, `Point ${esc(store.loginDomain)} at this server`, `<p class="muted">Do this once, before connecting Shopify. You need access to the DNS of <b>${esc(store.loginDomain.split(':')[0].split('.').slice(1).join('.'))}</b> (GoDaddy, Cloudflare, Hostinger…).</p>
          <ol class="mini">
            <li>Render → this service → <b>Settings → Custom Domains → Add</b>: <code>${esc(store.loginDomain)}</code></li>
            <li>In the domain's DNS add a <b>CNAME</b> record:
              <dl class="kv"><dt>Name / Host</dt><dd>${copyable(store.loginDomain.split('.')[0])}</dd>
              <dt>Value / Points to</dt><dd>${copyable(new URL(config.issuer).host)}</dd></dl>
              <span class="muted small">On Cloudflare set the record to “DNS only” (grey cloud).</span></li>
            <li>Wait until Render shows <b>Certificate issued</b> (a few minutes to an hour), then check:</li>
          </ol>
          <form method="post" action="/admin/stores/${esc(store.id)}/check-domain">${csrfInput(ctx.csrf)}<button class="btn sm" type="submit">Check ${esc(store.loginDomain)}</button></form>`) : ''}
        ${step(1, 'Fill Shopify\'s identity provider form', `<p class="muted">Shopify admin → Settings → Customer accounts → Authentication → Manage → Connect → <b>Custom or other</b>.</p>
          <dl class="kv">
            <dt>Discovery URL</dt><dd>${copyable(`${issuerFor(store)}/.well-known/openid-configuration`)}</dd>
            <dt>Client ID</dt><dd>${copyable(store.clientId)}</dd>
            <dt>Client secret</dt><dd>${copyable(secret || '', { secret: true })}</dd>
            <dt>Additional scopes</dt><dd>${copyable('profile phone address offline_access')}</dd>
            <dt>Post-sign-out redirect URI parameter name</dt><dd>${copyable('post_logout_redirect_uri')}</dd>
          </dl>
          <p class="note">Shopify locks the Discovery URL and Client ID after the first customer signs in. Connect a live store only with your final server address.</p>
          <details class="inline"><summary>URLs Shopify should show on that screen</summary>
            <ul class="mono-list">${[...store.redirectUris, ...store.logoutUris].map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
            <p class="muted small">If Shopify shows a different URL, add it under Advanced below.</p></details>`)}
        ${step(2, 'Add the login drawer to the theme', `<p class="muted">Online Store → Themes → ⋯ → Edit code → Snippets → <b>Add a new snippet</b> named <code>idp-login</code>, paste this and save. Then in <b>layout/theme.liquid</b> add <code>{% render 'idp-login' %}</code> just before <code>&lt;/body&gt;</code>.</p>
          <div class="snippet"><textarea readonly rows="9" data-value>${esc(themeSnippet(store))}</textarea><button type="button" class="btn sm" data-copy-textarea>Copy snippet</button></div>
          <p class="muted small">You never need to change this snippet again — design changes come from here. Only if the server address changes.</p>`)}
        ${step(3, 'Test', `<p class="muted">Open the store in an incognito window and click the account icon.</p>
          <a class="btn sm" href="https://${esc(store.shopDomain)}" target="_blank" rel="noopener">Open store</a>`)}
      </ol>
    </section>

    ${error && !error.field ? `<div class="flash flash-error">${esc(error.message)}</div>` : ''}
    <h2 class="section-title">Store settings</h2>
    ${storeForm({ store, values, error, isNew: false, csrf: ctx.csrf })}

    <div class="grid-2 even">
      <section class="card"><h2>Test this store's SMS</h2>
        <p class="muted small">Uses ${store.own.sms ? 'this store\'s own' : 'the default'} SMS account and this store's SMS text. Save changes first.</p>
        <form method="post" action="/admin/stores/${esc(store.id)}/test-sms" class="stack">${csrfInput(ctx.csrf)}
          <label>Mobile number<input name="phone" inputmode="numeric" required placeholder="98765 43210"></label>
          <button class="btn" type="submit">Send test SMS</button></form></section>
      <section class="card"><h2>Test this store's email</h2>
        <p class="muted small">Uses ${store.own.mail ? 'this store\'s own' : 'the default'} email account. Save changes first.</p>
        <form method="post" action="/admin/stores/${esc(store.id)}/test-email" class="stack">${csrfInput(ctx.csrf)}
          <label>Email<input name="email" type="email" required value="${esc(ctx.admin.email)}"></label>
          <button class="btn" type="submit">Send test email</button></form></section>
    </div>

    <section class="card danger">
      <h2>Danger zone</h2>
      <div class="danger-row">
        <div><h3>New client secret</h3><p class="muted">Makes a new secret. Paste it into Shopify straight away, or logins stop working.</p></div>
        <form method="post" action="/admin/stores/${esc(store.id)}/secret">${csrfInput(ctx.csrf)}
          <label class="confirm"><span>Type <b>${esc(store.id)}</b> to confirm</span><input name="confirm" autocomplete="off" required></label>
          <button class="btn" type="submit">Make new secret</button></form>
      </div>
      <div class="danger-row">
        <div><h3>Delete store</h3><p class="muted">Removes the store and its login client. Customers are kept. Remove the identity provider in Shopify first.</p></div>
        <form method="post" action="/admin/stores/${esc(store.id)}/delete">${csrfInput(ctx.csrf)}
          <label class="confirm"><span>Type <b>${esc(store.id)}</b> to confirm</span><input name="confirm" autocomplete="off" required></label>
          <button class="btn danger-btn" type="submit">Delete store</button></form>
      </div>
    </section>`,
  });
}

// ---------- customers ----------

export function customersPage(ctx, { list, q, group, page, pages, total, groups }) {
  const groupName = (g) => {
    const names = (groups[g] || []).map((s) => s.name);
    return names.length ? names.join(' + ') : g;
  };
  const rows = list.map((u) => `<tr>
    <td><a class="strong" href="/admin/customers/${u._id}">${esc([u.firstName, u.lastName].filter(Boolean).join(' ') || '—')}</a></td>
    <td>${esc(u.email || '—')} ${u.email ? (u.emailVerified ? badge('verified', 'ok') : badge('unverified', 'warn')) : ''}</td>
    <td>${esc(u.phone || '—')} ${u.phone ? (u.phoneVerified ? badge('verified', 'ok') : badge('unverified', 'warn')) : ''}</td>
    <td>${(u.identities || []).map((i) => badge(i.provider)).join(' ') || '—'}</td>
    <td>${esc(groupName(u.group || 'default'))}<div class="muted small">${esc((u.stores || []).join(', ') || '—')}</div></td>
    <td>${fmtDate(u.lastLoginAt)}</td>
    <td>${u.status === 'blocked' ? badge('blocked', 'bad') : ''}</td></tr>`).join('');
  const link = (p) => `/admin/customers?${new URLSearchParams({ ...(q ? { q } : {}), ...(group ? { group } : {}), page: String(p) })}`;
  const groupKeys = Object.keys(groups);
  return layout({
    ...ctx,
    title: 'Customers',
    active: 'customers',
    body: `<form class="search" method="get" action="/admin/customers">
      <input name="q" value="${esc(q || '')}" placeholder="Search by email, mobile number or name" aria-label="Search">
      ${groupKeys.length > 1 ? `<select name="group" aria-label="Customer list"><option value="">All stores</option>${groupKeys.map((g) => `<option value="${esc(g)}"${g === group ? ' selected' : ''}>${esc(groupName(g))}</option>`).join('')}</select>` : ''}
      <button class="btn" type="submit">Search</button>${q || group ? '<a class="btn" href="/admin/customers">Clear</a>' : ''}</form>
    <p class="muted small">${total} customer${total === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}${group ? ` in ${esc(groupName(group))}` : ''}. The same person can appear once per separate store.</p>
    ${list.length ? `<section class="card flush"><div class="scroll"><table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Linked</th><th>Store</th><th>Last login</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></section>` : '<section class="card empty"><p class="muted">No customers found.</p></section>'}
    ${pages > 1 ? `<nav class="pager">${page > 1 ? `<a class="btn sm" href="${link(page - 1)}">← Previous</a>` : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn sm" href="${link(page + 1)}">Next →</a>` : ''}</nav>` : ''}`,
  });
}

export function customerPage(ctx, { u }) {
  const post = (path, label, cls = '', extra = '') => `<form method="post" action="/admin/customers/${u._id}/${path}">${csrfInput(ctx.csrf)}${extra}<button class="btn ${cls}" type="submit">${label}</button></form>`;
  return layout({
    ...ctx,
    title: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.phone || 'Customer',
    active: 'customers',
    actions: '<a class="btn" href="/admin/customers">← All customers</a>',
    body: `<section class="card">
      <dl class="kv">
        <dt>Email</dt><dd>${esc(u.email || '—')} ${u.email ? (u.emailVerified ? badge('verified', 'ok') : badge('unverified', 'warn')) : ''}</dd>
        <dt>Mobile</dt><dd>${esc(u.phone || '—')} ${u.phone ? (u.phoneVerified ? badge('verified', 'ok') : badge('unverified', 'warn')) : ''}</dd>
        <dt>Password</dt><dd>${u.passwordHash ? 'Set' : 'Not set'}</dd>
        <dt>Customer list</dt><dd>${esc((stores.all().filter((s) => s.customerGroup === (u.group || 'default')).map((s) => s.name).join(' + ')) || u.group || 'default')} <span class="muted small">(${esc(u.group || 'default')})</span></dd>
        <dt>Stores used</dt><dd>${esc((u.stores || []).join(', ') || '—')}</dd>
        <dt>Status</dt><dd>${u.status === 'blocked' ? badge('blocked', 'bad') : badge('active', 'ok')}</dd>
        <dt>Last login</dt><dd>${fmtDate(u.lastLoginAt)} ${u.lastLoginMethod ? `<span class="muted">(${esc(u.lastLoginMethod)})</span>` : ''}</dd>
        <dt>Created</dt><dd>${fmtDate(u.createdAt)}</dd>
        <dt>Customer ID (sub)</dt><dd><code>${u._id}</code></dd>
      </dl>
    </section>
    <section class="card">
      <h2>Linked sign-ins</h2>
      ${(u.identities || []).length ? `<ul class="list">${u.identities.map((i) => `<li><span>${badge(i.provider)} ${esc(i.email || '')} <span class="muted small">linked ${fmtDate(i.linkedAt)}</span></span>
        ${post('unlink', 'Remove link', 'sm', `<input type="hidden" name="provider" value="${esc(i.provider)}"><input type="hidden" name="providerUserId" value="${esc(i.providerUserId)}">`)}</li>`).join('')}</ul>`
      : '<p class="muted">No Google / Facebook / Apple sign-in linked.</p>'}
    </section>
    <section class="card danger">
      <h2>Actions</h2>
      <div class="danger-row"><div><h3>${u.status === 'blocked' ? 'Unblock' : 'Block'} customer</h3><p class="muted">${u.status === 'blocked' ? 'Allow this customer to log in again.' : 'Stops this customer from logging in. Their Shopify orders are not affected.'}</p></div>
        ${post(u.status === 'blocked' ? 'unblock' : 'block', u.status === 'blocked' ? 'Unblock' : 'Block', u.status === 'blocked' ? '' : 'danger-btn')}</div>
      <div class="danger-row"><div><h3>Delete customer</h3><p class="muted">Deletes the login record here. Shopify keeps the customer and their orders; they can sign up again.</p></div>
        ${post('delete', 'Delete', 'danger-btn', '<label class="confirm"><span>Type <b>DELETE</b> to confirm</span><input name="confirm" autocomplete="off" required></label>')}</div>
    </section>`,
  });
}

// ---------- settings ----------

// One settings input. `name` is the form field name, `val` the current value
// (for secrets: whether one is saved).
function fieldInput(f, name, val) {
  const attrs = `name="${esc(name)}" id="f-${esc(name)}"`;
  if (f.secret) {
    const ph = val ? 'Saved — leave empty to keep' : 'Not set';
    return f.type === 'textarea'
      ? `<textarea ${attrs} rows="4" placeholder="${ph}" autocomplete="off"></textarea>`
      : `<input ${attrs} type="password" placeholder="${ph}" autocomplete="new-password">`;
  }
  if (f.type === 'select') {
    return `<select ${attrs}${f.group === 'sms' || f.group === 'mail' ? ' data-switch' : ''}>${f.options.map((o) => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (f.type === 'checkbox') return `<input type="hidden" name="${esc(name)}__present" value="1"><input ${attrs} type="checkbox"${val ? ' checked' : ''}>`;
  if (f.type === 'textarea') return `<textarea ${attrs} rows="3">${esc(val ?? '')}</textarea>`;
  return `<input ${attrs} ${f.type === 'number' ? `type="number"${f.min !== undefined ? ` min="${f.min}" max="${f.max}"` : ''}` : 'type="text"'} value="${esc(val ?? '')}" autocomplete="off">`;
}

const fieldBox = (f, name, input, meta = '') => `<div class="field${f.type === 'checkbox' ? ' field-check' : ''}"${f.when ? ` data-when="${esc(f.when)}"` : ''}>
    <div class="field-top"><label for="f-${esc(name)}">${esc(f.label)}</label><span class="field-meta">${meta}</span></div>
    ${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</div>`;

function field(f) {
  const src = sourceOf(f.path);
  const val = currentValue(f.path);
  const tag = src === 'panel' ? badge('saved here', 'ok') : src === 'env' ? badge('from .env') : badge('not set');
  const clear = src === 'panel' ? `<label class="clear"><input type="checkbox" name="_clear" value="${esc(f.path)}"> reset</label>` : '';
  return fieldBox(f, f.path, fieldInput(f, f.path, f.secret ? Boolean(val) : val), tag + clear);
}

// A store's own key: the value typed in (after a form error) or the saved one.
function storeField(f, store, values) {
  const name = `cred:${f.path}`;
  let val = storeCredValue(store, f.path);
  if (values && !f.secret) {
    if (f.type === 'checkbox') val = values[`${name}__present`] !== undefined ? values[name] === 'on' : val;
    else if (values[name] !== undefined) val = values[name];
  }
  if (val === undefined && f.type === 'select') val = currentValue(f.path); // start from the default provider
  return fieldBox(f, name, fieldInput(f, name, val));
}

const SOCIAL_HELP = {
  google: ['Google', 'console.cloud.google.com → APIs &amp; Services → Credentials → OAuth client ID (Web application). Add your Gmail as a test user while the app is in Testing.'],
  facebook: ['Facebook', 'developers.facebook.com → your app → Facebook Login → Valid OAuth Redirect URIs.'],
  apple: ['Apple', 'developer.apple.com → Services ID → Sign in with Apple → Return URL. Domain: your server address.'],
};

function defaultSummary(section) {
  if (section === 'sms') return config.sms.provider;
  if (section === 'mail') return config.mail.transport === 'smtp' ? config.mail.smtp.host || 'smtp' : 'console';
  const on = Object.keys(enabledSocial).filter((k) => enabledSocial[k]);
  return on.length ? on.join(', ') : 'none';
}

// "SMS, email & social login" card on the store form.
function sendingCard(store, values) {
  const own = (k) => (values?.[`own_${k}`] !== undefined ? values[`own_${k}`] === '1' : Boolean(store?.own?.[k]));
  const block = (k, title, body) => `<div class="own-block" data-own-block>
      <label><span>${title}</span>
        <select name="own_${k}" data-own>
          <option value="0"${own(k) ? '' : ' selected'}>Use default from Settings (${esc(defaultSummary(k))})</option>
          <option value="1"${own(k) ? ' selected' : ''}>This store's own</option>
        </select></label>
      <div class="own-body" data-own-body${own(k) ? '' : ' hidden'}>${body}</div>
    </div>`;
  const fields = (group) => STORE_FIELDS.filter((f) => f.group === group).map((f) => storeField(f, store, values)).join('');
  const social = Object.entries(SOCIAL_HELP).map(([p, [title, steps]]) => `<div class="provider">
      <div class="field-top"><h3>${title}</h3></div>
      <p class="muted small">${steps}</p>
      <div class="kv-inline"><span>Redirect URI</span>${copyable(`${issuerFor(store)}/social/${p}/callback`)}</div>
      ${STORE_FIELDS.filter((f) => f.provider === p).map((f) => storeField(f, store, values)).join('')}</div>`).join('');
  return `<section class="card" id="sending">
        <h2>SMS, email &amp; social login</h2>
        <p class="muted small">Normally a store uses the accounts in Settings. Pick "This store's own" to use a different Gupshup, email or Google / Facebook / Apple account for this store only.</p>
        ${block('sms', 'SMS (mobile OTP)', `<div class="fields" data-group="sms">${fields('sms')}</div>`)}
        ${block('mail', 'Email (email OTP, forgot password)', `<div class="fields" data-group="mail">${fields('mail')}</div>
          <p class="muted small">On Render's free plan use port 2525 (e.g. Brevo: smtp-relay.brevo.com) with SSL off.</p>`)}
        ${block('social', 'Social logins', `<p class="muted small">Only the logins whose keys you fill in show for this store.</p>${social}`)}
      </section>`;
}

const ownBadges = (s) => ['sms', 'mail', 'social'].filter((k) => s.own?.[k])
  .map((k) => badge(`own ${k === 'mail' ? 'email' : k}`)).join(' ');

// Settings social keys are used on the main address and on the login domains
// of stores that use the default keys: each needs its redirect URI.
const redirectUris = (list) => [...new Set([config.issuer, ...list.filter((s) => !s.own?.social).map(issuerFor)])];

export function settingsPage(ctx, { storesList, dbName }) {
  const group = (g) => FIELDS.filter((f) => f.group === g).map(field).join('');
  const social = (p, title, steps) => `<div class="provider">
    <div class="field-top"><h3>${title}</h3>${enabledSocial[p] ? badge('on', 'ok') : badge('off')}</div>
    <p class="muted small">${steps}</p>
    ${redirectUris(storesList).map((iss) => `<div class="kv-inline"><span>Redirect URI</span>${copyable(`${iss}/social/${p}/callback`)}</div>`).join('')}
    ${FIELDS.filter((f) => f.provider === p).map(field).join('')}</div>`;
  return layout({
    ...ctx,
    title: 'Settings',
    active: 'settings',
    body: `<p class="lead">These are the defaults for every store. A store can use its own SMS, email or social login accounts: Stores → open the store → <b>SMS, email &amp; social login</b>.${(() => {
      const own = storesList.filter((s) => s.own?.sms || s.own?.mail || s.own?.social);
      return own.length ? ` Stores with their own: ${own.map((s) => `<a href="/admin/stores/${esc(s.id)}#sending">${esc(s.name)}</a>`).join(', ')}.` : '';
    })()}</p>
    <form method="post" action="/admin/settings" class="settings">
    ${csrfInput(ctx.csrf)}
    <section class="card" id="sms"><h2>SMS (mobile OTP)</h2><div class="fields" data-group="sms">${group('sms')}</div></section>
    <section class="card" id="mail"><h2>Email (email OTP, forgot password)</h2><div class="fields" data-group="mail">${group('mail')}</div></section>
    <section class="card" id="social"><h2>Social logins</h2>
      <p class="muted">A button shows in the login drawer once its keys are filled in. Add the redirect URI in that provider's console.</p>
      ${social('google', 'Google', 'console.cloud.google.com → APIs &amp; Services → Credentials → OAuth client ID (Web application). Add your Gmail as a test user while the app is in Testing.')}
      ${social('facebook', 'Facebook', 'developers.facebook.com → your app → Facebook Login → Valid OAuth Redirect URIs.')}
      ${social('apple', 'Apple', 'developer.apple.com → Services ID → Sign in with Apple → Return URL. Domain: your server address.')}
    </section>
    <section class="card" id="otp"><h2>OTP rules</h2><div class="fields cols">${group('otp')}</div></section>
    <div class="form-actions sticky"><button class="btn primary" type="submit">Save settings</button><span class="muted small">Secrets are stored encrypted. Empty secret fields keep the saved value.</span></div>
  </form>

  <div class="grid-2 even">
    <section class="card"><h2>Send a test SMS</h2>
      <form method="post" action="/admin/settings/test-sms" class="stack">${csrfInput(ctx.csrf)}
        <label>Mobile number<input name="phone" inputmode="numeric" required placeholder="98765 43210"></label>
        <label>SMS text from store<select name="store"><option value="">Default text</option>${storesList.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <button class="btn" type="submit">Send test SMS</button></form></section>
    <section class="card"><h2>Send a test email</h2>
      <form method="post" action="/admin/settings/test-email" class="stack">${csrfInput(ctx.csrf)}
        <label>Email<input name="email" type="email" required value="${esc(ctx.admin.email)}"></label>
        <button class="btn" type="submit">Send test email</button></form></section>
  </div>

  <section class="card"><h2>Server (from .env)</h2>
    <p class="muted">These are needed to start the server, so they stay in the <code>.env</code> file.</p>
    <dl class="kv">
      <dt>Server address (ISSUER)</dt><dd>${copyable(config.issuer)}</dd>
      <dt>Database</dt><dd><code>${esc(dbName)}</code></dd>
      <dt>Mode</dt><dd>${badge(config.isProd ? 'production' : 'development')}</dd>
      <dt>/dev test page</dt><dd>${config.devTestClient ? badge('on', 'warn') : badge('off')}</dd>
    </dl></section>`,
  });
}

// ---------- admins ----------

export function adminsPage(ctx, { list }) {
  return layout({
    ...ctx,
    title: 'Admins',
    active: 'admins',
    body: `<section class="card flush"><table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Last login</th><th></th></tr></thead>
      <tbody>${list.map((a) => `<tr><td>${esc(a.name || '—')}</td><td>${esc(a.email)}</td><td>${fmtDate(a.lastLoginAt)}</td>
        <td class="right">${String(a._id) === String(ctx.admin._id) ? badge('you') : `<form method="post" action="/admin/admins/${a._id}/delete">${csrfInput(ctx.csrf)}<button class="btn sm danger-btn" type="submit">Remove</button></form>`}</td></tr>`).join('')}</tbody>
    </table></section>
    <div class="grid-2 even">
      <section class="card"><h2>Add admin</h2>
        <form method="post" action="/admin/admins" class="stack">${csrfInput(ctx.csrf)}
          <label>Name<input name="name"></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"><span class="help">Share it with them privately; they can change it after signing in.</span></label>
          <button class="btn primary" type="submit">Add admin</button></form></section>
      <section class="card"><h2>Change my password</h2>
        <form method="post" action="/admin/admins/password" class="stack">${csrfInput(ctx.csrf)}
          <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
          <label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
          <button class="btn" type="submit">Change password</button></form></section>
    </div>`,
  });
}
