# Shopify Login Server (Node.js + MongoDB)

A customer identity provider for Shopify stores: **mobile OTP, email OTP, email and password, password reset, Google, Facebook and Apple**. Customers are stored in your own MongoDB database, and Shopify connects to the server as a **"Custom or other" identity provider** (OpenID Connect).

- The store's account icon opens a **login drawer** on the storefront.
- Checkout "Sign in" opens a simple hosted login page.
- The **Admin Panel** (`/admin`) manages stores, settings, customers and admins without editing code.

> Adding a new client store? Open **Admin Panel → Setup guide** first. It lists everything to collect from the client, why it is needed, and where it goes.

---

## 1. Running the server

```bash
npm install
npm start
```

Only these settings are required in `.env` (see `.env.example`):

| Setting | Purpose |
|---|---|
| `ISSUER` | The server's public HTTPS address. On Render it can be left out; `https://<name>.onrender.com` is used. |
| `MONGODB_URI` | MongoDB connection string |
| `COOKIE_KEYS`, `OTP_SECRET` | Long random strings. Never change `OTP_SECRET`: it encrypts the passwords and keys saved in the Admin Panel. |
| `PORT`, `NODE_ENV` | Server port and mode |

SMS, email, Google/Facebook/Apple keys and OTP rules can also be set in `.env`, but **Admin Panel → Settings** is easier. Values saved in the panel take priority over `.env`.

## 2. Admin Panel

1. Start the server. On first run the terminal shows a **setup code**.
2. Open `<ISSUER>/admin` and enter the setup code, your email and a password.
3. Sign in with that email and password from then on.

Forgot your password? Another admin can add you again under **Admins**, or run this from the project folder with a `.env` that points to the same database:

```
npm run admin:reset -- you@email.com NewPassword123
```

### Adding a store
1. **Stores → Add store**: store ID, name, Shopify domain, Shop ID, login domain, branding and SMS text. A live preview is shown next to the form.
2. The store page then shows each step with copy buttons:
   - **Login domain** (if set): the Render custom domain and DNS record to add, with a **Check** button.
   - **Shopify identity provider form**: Discovery URL, Client ID, Client secret, scopes and logout parameter.
   - **Theme snippet**: paste it into a new snippet named `idp-login`, then add `{% render 'idp-login' %}` before `</body>` in `layout/theme.liquid`.
3. Changes to the logo, colours or text apply to the drawer immediately; the snippet never needs to be pasted again unless the login address changes.

### Login domain per store (e.g. `login.brand.com`)
Each store can have its own login address. One server answers on all of them. Leave the field empty to use the server's main address. After saving, the store page shows the exact CNAME record. Connect the store in Shopify only after **Check** confirms the domain works, because Shopify locks the Discovery URL after the first customer signs in. Google and Facebook need a redirect URI for each login domain; the panel lists them.

### SMS, email and social sign-in per store
Store page → **SMS, email & social login**. For each part choose:
- **Use default from Settings**: the account configured in Settings (shared by all stores).
- **This store's own**: a separate Gupshup/MSG91/Twilio account, SMTP account, or Google/Facebook/Apple keys for this store only.

The store page has **Test this store's SMS** and **Test this store's email** buttons. Passwords and keys are stored encrypted. OTP rules and the default country code come from Settings for all stores.

### Customer lists
Each store either keeps a **separate** customer list (the default for new stores) or **shares** one with other stores. With separate lists the same email or mobile number can exist once per store, and signing in on one store does not sign the customer in on another. If a store's list is changed after customers have signed in and Shopify shows "The sign-in method you used doesn't match this account", unlink the customer in Shopify admin → Customers.

Stores and customers created before customer lists existed are in the shared list `default`.

### Other pages
- **Settings**: default SMS provider and text, email, social keys and OTP rules, with test SMS and test email buttons.
- **Customers**: search by email, mobile or name, filter by customer list, view details, block or unblock, remove a social link, or delete.
- **Setup guide**: client requirements, setup order and a ready-to-send request for the client.
- **Admins**: add or remove admins and change your password.

## 3. Deploying on Render

1. Push the code to a private GitHub repository.
2. Render → **New → Blueprint** → select the repository. `render.yaml` configures the service; Render asks for two values:
   - `MONGODB_URI`: the same Atlas connection string as in `.env`.
   - `OTP_SECRET`: **exactly** the value from `.env`, so the secrets saved in the panel can be decrypted.
3. After the first deploy:
   - Add the service's outbound IP ranges (Render → service → **Connect → Outbound**) to MongoDB Atlas → Network Access.
   - Add `https://<server address>/social/google/callback` (and one per login domain) to the Google OAuth client.
   - Sign in to `/admin` with your existing admin account; the database is shared.
   - Copy each store's new snippet into its theme and update the Discovery URL in Shopify.

`render.yaml` uses the **free** plan, which sleeps after 15 minutes of inactivity and takes about a minute to wake. Use it for testing only.

## 4. Before going live

- The client's store must be on **Shopify Plus**. Shopify allows a custom identity provider only on Plus.
- Use a **paid, always-on** instance. Shopify requires the discovery, token and userinfo endpoints to respond within one second. Keep MongoDB Atlas in the same region as the server.
- Set `NODE_ENV=production` and `DEV_TEST_CLIENT=false`.
- Decide each store's final login address before connecting it in Shopify. Shopify locks the Discovery URL and Client ID after the first customer signs in.

## Commands

```
npm start                                   start the server
npm run admin:reset -- <email> <password>   restore admin access
npm run sms:test -- <mobile> [store id]     send one test SMS
npm run user:check -- <email> "<password>"  explain why a customer cannot sign in
npm test                                    run all tests (needs MongoDB)
```

## Project structure

```
src/
  server.js      server start-up
  admin.js       Admin Panel routes
  adminViews.js  Admin Panel pages
  adminGuide.js  Admin Panel setup guide
  settings.js    panel settings and per-store keys (encrypted)
  stores.js      stores (MongoDB)
  issuers.js     login addresses (per-store login domains)
  login.js       login API, hosted login page, Google/Facebook/Apple
  oidc.js        OpenID Connect provider used by Shopify
  otp.js         one-time codes, SMS and email
  users.js       account merging and social linking
  db.js          MongoDB models
  social.js, pages.js, dev.js, config.js
public/
  login.js, login.css    login drawer and page
  admin.js, admin.css    Admin Panel
scripts/                 admin-reset, sms-test, check-user
test/e2e.test.js         end-to-end tests
```
