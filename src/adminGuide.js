// Admin panel: Setup guide (/admin/guide). What to collect from a client before
// adding their store, why each item is needed, and where it goes in the panel.
// Values such as the server address are filled in live.
import { config } from './config.js';
import { esc } from './pages.js';
import { layout, copyable } from './adminViews.js';

const row = (what, why, where) => `<tr><td>${what}</td><td>${why}</td><td>${where}</td></tr>`;
const table = (rows) => `<div class="scroll"><table class="table guide-table">
  <thead><tr><th>What to collect</th><th>Why it is needed</th><th>Where it goes</th></tr></thead>
  <tbody>${rows.join('')}</tbody></table></div>`;
const section = (id, title, intro, body) => `<section class="card" id="${id}"><h2>${title}</h2>${intro ? `<p class="muted">${intro}</p>` : ''}${body}</section>`;

const CLIENT_REQUEST = `Hello,

To set up your custom customer login (mobile OTP, email OTP, password, and Google / Facebook / Apple sign-in), please share the following:

1. Shopify
   - Confirmation that the store is on the Shopify Plus plan.
   - Collaborator access with permission for Settings (customer accounts), Online Store > Themes, and Customers.
   - The store's live domains (e.g. www.yourbrand.com).

2. Login address
   - The subdomain you would like customers to see on the login page (e.g. login.yourbrand.com).
   - A contact who can add one CNAME record to your DNS.

3. SMS (DLT registration)
   - DLT Principal Entity ID.
   - Approved Sender ID (header).
   - Approved OTP template text and its Template ID.
   - Your SMS gateway login, or approval to add our gateway as your telemarketer on the DLT portal.

4. Email
   - Sender address and name (e.g. Your Brand <no-reply@yourbrand.com>).
   - SMTP details from your email provider, and the SPF/DKIM DNS records they require.

5. Social sign-in (only the ones you want)
   - Google: OAuth Client ID and Client secret.
   - Facebook: App ID and App secret.
   - Apple: Services ID, Team ID, Key ID and the .p8 key file.

6. Branding
   - Logo (PNG or SVG with a transparent background), brand colour and support email.

Thank you.`;

export function guidePage(ctx) {
  const serverHost = new URL(config.issuer).host;
  const otpMinutes = Math.round(config.otp.ttlSeconds / 60);
  const toc = [
    ['before', 'Before you start'], ['shopify', 'Shopify'], ['domain', 'Login domain'], ['sms', 'SMS (DLT)'],
    ['email', 'Email'], ['social', 'Social sign-in'], ['branding', 'Branding'], ['decisions', 'Decisions'],
    ['order', 'Setup order'], ['request', 'Request for the client'], ['hosting', 'Hosting notes'],
  ];

  return layout({
    ...ctx,
    title: 'Setup guide',
    active: 'guide',
    actions: '<a class="btn primary" href="/admin/stores/new">Add store</a>',
    body: `
    <p class="lead">Everything to collect from a client before adding their store, why each item is needed, and where it goes in this panel.</p>
    <nav class="toc card">${toc.map(([id, label], i) => `<a href="#${id}"><span>${i + 1}</span>${label}</a>`).join('')}</nav>

    ${section('before', 'Before you start', 'Confirm these two points first. Without them the login cannot go live.', `<ul class="checks">
      <li><b>The store is on Shopify Plus.</b> Shopify allows a custom identity provider (“Custom or other”) only on the Shopify Plus plan. Development and sandbox stores can be used for testing.</li>
      <li><b>The server runs on a paid, always-on instance.</b> Shopify requires the discovery, token and userinfo endpoints to respond within one second. A free instance sleeps after 15 minutes of inactivity and takes about a minute to wake up, so live sign-ins would fail. Keep the MongoDB Atlas cluster in the same region as the server (for Render Singapore: Atlas Singapore or Mumbai).</li>
    </ul>`)}

    ${section('shopify', 'Shopify', '', table([
      row('The store\'s <b>myshopify.com domain</b>', 'Identifies the store and builds Shopify\'s callback URLs.', 'Store → Shopify domain'),
      row('<b>Collaborator or staff access</b>: Settings (customer accounts), Online Store → Themes, Customers', 'Needed to connect the identity provider, add the theme snippet and unlink customers if required.', '—'),
      row('The store\'s <b>live domains</b> (e.g. www.brand.com)', 'The login drawer only runs on the store\'s own domains.', 'Store → Advanced: custom domains'),
      row('<b>Shop ID</b> (you can find it once you have access)', 'Shopify\'s callback URL contains this number.', 'Store → Shop ID'),
      row('Which theme is live and where the account icon is', 'The snippet opens the drawer from the account icon.', '—'),
    ]) + '<p class="muted small">Shop ID: Shopify admin → Settings → Customer accounts → Authentication → Connect → Custom. The callback URL there looks like <code>shopify.com/&lt;number&gt;/…</code>.</p>')}

    ${section('domain', 'Login domain', '', `${table([
      row('A <b>login subdomain</b> (e.g. login.brand.com)', 'Customers see the brand\'s own address on the login page. If hosting changes later, the Discovery URL in Shopify stays the same.', 'Store → Login domain'),
      row('<b>DNS access</b>, or someone who can add one <b>CNAME</b> record', 'Points the subdomain at this server.', 'Store page → step 1 shows the exact record'),
    ])}
    <dl class="kv"><dt>CNAME value for every login domain</dt><dd>${copyable(serverHost)}</dd></dl>
    <p class="note">Shopify locks the Discovery URL after the first customer signs in. Connect the provider in Shopify only after the store page's <b>Check</b> button confirms the login domain is working.</p>`)}

    ${section('sms', 'SMS (India: DLT)', '', `${table([
      row('<b>DLT Principal Entity ID</b>', 'Required by TRAI rules. Messages without the brand\'s registration are not delivered.', 'Store → SMS, email &amp; social login → SMS → DLT Principal Entity ID'),
      row('<b>Sender ID / header</b> (6 letters, e.g. FABIND)', 'The name the SMS comes from. It must be approved on DLT.', 'Sender ID (mask)'),
      row('<b>Approved OTP template text</b> and its <b>Template ID</b>', 'The SMS must match the approved template word for word, otherwise operators block it.', 'Store → SMS text, and DLT Template ID'),
      row('<b>SMS gateway account</b> (Gupshup, MSG91 or Twilio), or approval to use yours', 'Sends the messages. The client\'s header and template must be linked to that gateway; on the DLT portal this usually means adding the gateway as the client\'s telemarketer.', 'SMS → “This store\'s own” or the default in Settings'),
    ])}
    <p class="note">The template states how long the code is valid. Codes on this server are currently valid for <b>${otpMinutes} minute${otpMinutes === 1 ? '' : 's'}</b> (Settings → OTP rules), and the same setting applies to email codes. Ask for a template that matches, e.g. “valid for ${otpMinutes} minutes”.</p>`)}

    ${section('email', 'Email (email codes and password reset)', '', `${table([
      row('<b>Sender address and name</b> on the brand\'s domain (e.g. Brand &lt;no-reply@brand.com&gt;)', 'Codes arrive under the brand\'s name and are less likely to be marked as spam.', 'Email → From'),
      row('<b>SMTP account</b>: host, port, user, password or key (client\'s provider, or your Brevo account)', 'Sends the emails.', 'Email → “This store\'s own”'),
      row('<b>SPF and DKIM</b> DNS records from the email provider', 'Without them, codes go to spam or are rejected.', 'Client\'s DNS'),
    ])}
    <p class="muted small">Render's free plan only allows port 2525 for email (e.g. Brevo: smtp-relay.brevo.com, SSL off). Paid instances can also use 465 and 587.</p>`)}

    ${section('social', 'Social sign-in (optional)', 'Use the client\'s own accounts so the consent screens show the client\'s brand. The redirect URI to register is shown on the store page.', table([
      row('<b>Google</b>: OAuth client (Web application) with Client ID and Client secret', 'The consent screen needs the brand name, support email and privacy policy, and must be set to “In production”; in testing mode only test users can sign in. Adding a logo may require Google brand verification.', 'Store → Social logins → Google'),
      row('<b>Facebook</b>: Meta app with App ID and App secret', 'The app must be in Live mode with a privacy policy URL and data deletion URL; otherwise only app admins and testers can sign in.', 'Store → Social logins → Facebook'),
      row('<b>Apple</b>: paid Apple Developer Program membership, Services ID, Team ID, Key ID and .p8 key', 'Required for Sign in with Apple. Customers who hide their email get an @privaterelay.appleid.com address; to email them codes, the sender domain must be registered under Sign in with Apple for Email Communication.', 'Store → Social logins → Apple'),
    ]))}

    ${section('branding', 'Branding', 'A live preview is shown next to the store form.', table([
      row('<b>Logo</b> (PNG or SVG, transparent background)', 'Shown at the top of the login drawer and page. Upload it in Shopify admin → Content → Files and use its https link.', 'Store → Login look → Logo URL'),
      row('<b>Brand colour</b> (hex, e.g. #8b1d24)', 'Used for the brand name and accents.', 'Store → Brand color'),
      row('Welcome line, tagline and <b>support email</b>', 'Text shown in the drawer.', 'Store → Login look'),
    ]))}

    ${section('decisions', 'Decisions to agree with the client', '', `<div class="scroll"><table class="table guide-table">
      <thead><tr><th>Question</th><th>Why it matters</th></tr></thead><tbody>
      <tr><td><b>Customer list</b>: separate for this store, or shared with another store?</td><td>Choose shared only for stores of the same business. Separate is the default for new stores.</td></tr>
      <tr><td>After sign-in, return to <b>the same page</b> or the <b>account (orders) page</b>?</td><td>Store → After login.</td></tr>
      <tr><td>What happens to <b>existing customers</b>?</td><td>Nothing to migrate. They sign in with mobile or email OTP, or use “Forgot password”, and Shopify links them to their existing account and orders by email.</td></tr>
      <tr><td><b>Data agreement</b></td><td>Customer names, emails and mobile numbers are stored in your database. The client's privacy policy should mention this, and a data processing agreement between you and the client is recommended (India: DPDP Act).</td></tr>
      </tbody></table></div>`)}

    ${section('order', 'Setup order', 'Following this order avoids problems with Shopify locking the Discovery URL.', `<ol class="order">
      <li>Confirm Shopify Plus and collaborator access.</li>
      <li>Stores → <b>Add store</b>: Shopify details, login domain, branding and customer list. Save.</li>
      <li>On the store page, step 1: add the custom domain in Render, add the CNAME record, and wait until <b>Check</b> reports the domain is working.</li>
      <li>Enter the SMS, email and social keys. Use <b>Test this store's SMS</b> and <b>Test this store's email</b>.</li>
      <li>Connect the provider in Shopify (Discovery URL, Client ID, Client secret, scopes, logout parameter) and <b>activate</b> it, ideally at a quiet time. From this moment checkout “Sign in” opens the hosted login page.</li>
      <li>Immediately add the theme snippet so the account icon opens the drawer. Add it after the provider is active, not before.</li>
      <li>Test in a private window: mobile OTP, email OTP, password, forgot password, each social sign-in, checkout sign-in and sign-out.</li>
    </ol>`)}

    ${section('request', 'Request for the client', 'Copy and send this to the client.', `<div class="snippet"><textarea readonly rows="14" data-value>${esc(CLIENT_REQUEST)}</textarea><button type="button" class="btn sm" data-copy-textarea>Copy</button></div>`)}

    ${section('hosting', 'Hosting notes', '', `<ul class="checks">
      <li><b>Server address:</b> ${esc(config.issuer)}. Stores without a login domain use it, and it is also the address of this panel.</li>
      <li><b>MongoDB Atlas:</b> add the server's outbound IP addresses (Render → service → Connect → Outbound) under Atlas → Network Access.</li>
      <li><b>OTP_SECRET</b> in the server environment encrypts the passwords and keys saved in this panel. Never change it; if it changes, every saved secret must be entered again.</li>
      <li><b>Lost admin password:</b> another admin can add you again under Admins. Otherwise run <code>npm run admin:reset -- you@email.com NewPassword123</code> from the project folder on any computer whose <code>.env</code> points to the same database.</li>
      <li><b>Custom domains on Render:</b> the free workspace includes two; each additional domain has a small monthly charge.</li>
    </ul>`)}`,
  });
}
