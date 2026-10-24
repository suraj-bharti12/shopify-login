# Shopify Login Server (Node.js + MongoDB)

Aapka apna customer login: **mobile OTP, email OTP, email + password, forgot password, Google, Facebook, Apple**. Customers aapke MongoDB mein rehte hain. Shopify isse **"Custom or other" identity provider** ki tarah use karta hai.

- **Store par:** account icon dabate hi right side se login drawer khulta hai, aur login ke baad customer usi page par wapas aata hai.
- **Checkout "Sign in" par:** simple login page khulta hai, same design mein.
- **Ek server, kai stores:** har store ki ek JSON file hoti hai, naya code nahi likhna padta.

---

## Folder

```
src/
  server.js    server start
  config.js    .env settings (sab stores ke liye same)
  stores.js    stores/*.json padhta hai
  login.js     login API + hosted page + Google/FB/Apple
  oidc.js      Shopify se baat (OpenID Connect)
  otp.js       OTP banana, SMS (Gupshup/MSG91/Twilio) aur email bhejna
  users.js     account merge / social linking
  db.js        MongoDB models
  social.js    Google / Facebook / Apple
  pages.js     HTML pages
  dev.js       /dev test page
public/
  login.js     login UI (drawer + page dono yahi)
  login.css    login design
stores/
  mojito-plus1.json   ek store = ek file
  _example.json       naye store ke liye template
scripts/
  store.js     store setup command
  sms-test.js  ek test SMS
test/e2e.test.js
```

---

## 1. Pehli baar chalana

```bash
npm install
copy .env.example .env        # Mac/Linux: cp .env.example .env
```

`.env` mein bharo: `ISSUER`, `MONGODB_URI`, `COOKIE_KEYS`, `OTP_SECRET`, Gupshup, Google keys. Har line ke upar comment mein likha hai kya daalna hai.

### ISSUER: ngrok ka permanent domain (testing)

Ngrok ka random URL (`xxxx.ngrok-free.app`) har restart par badal jata hai, aur tab Shopify **"Discovery document request error"** deta hai. Isliye free **permanent domain** use karo:

1. https://dashboard.ngrok.com/domains par apna domain dekho (jaise `abc-def.ngrok-free.dev`).
2. `.env` mein: `ISSUER=https://abc-def.ngrok-free.dev`
3. Hamesha isi command se ngrok chalao:
   ```
   ngrok http --url abc-def.ngrok-free.dev 3000
   ```

### Store setup

```bash
npm run store -- setup mojito-plus1
```

Ye command 3 kaam karti hai:
- Shopify form ke liye **Discovery URL, Client ID, Client secret** print karti hai.
- `theme/idp-login.mojito-plus1.liquid` naam ki theme snippet file banati hai.
- Batati hai ki Shopify screen par kaun se callback URLs dikhne chahiye. Ye pehle se allowed hote hain.

Phir:

```bash
npm run dev
```

Browser mein `http://localhost:3000/dev` kholo. Ye test page Shopify ki jagah kaam karta hai.

### Shopify form (Settings > Customer accounts > Authentication > Manage providers)

| Field | Value |
|---|---|
| Provider | Custom or other |
| Discovery URL | `https://<ISSUER>/.well-known/openid-configuration` |
| Client ID / Client secret | `store setup` ke output se |
| Additional scopes | `profile phone address offline_access` |
| Post-sign-out redirect URI parameter name | `post_logout_redirect_uri` |

### Theme mein drawer lagana

1. Shopify: **Online Store > Themes > Edit code > Snippets > Add a new snippet**, naam `idp-login`.
2. VS Code mein `theme/idp-login.<store>.liquid` kholo, **Ctrl+A**, copy karo, aur snippet mein paste karke **Save** karo.
3. **Layout > theme.liquid** mein `</body>` ke theek upar ye line daalo:
   ```liquid
   {% render 'idp-login' %}
   ```

Jab bhi `ISSUER` badle ya design (`public/login.css` / `login.js`) badlo, tab `npm run store -- snippet <store>` chalao aur nayi file snippet mein dobara paste karo.

---

## 2. Naya store jodna (koi naya code nahi)

1. `stores/_example.json` copy karke `stores/<naya-id>.json` banao, jaise `stores/fabindia.json`.
2. Usme ye values bharo:
   - `shopDomain`: `xyz.myshopify.com`
   - `shopId`: Shopify callback URL mein jo number hota hai (`shopify.com/<shopId>/...`)
   - `domains`: custom domain ho to, jaise `["www.fabindia.com"]`
   - `brand`: logo URL, naam, tagline, color
   - `smsTemplate`: us brand ka DLT-approved SMS text, OTP ki jagah `{otp}` likhna
3. Ye command chalao:
   ```
   npm run store -- setup <naya-id>
   ```
4. Server restart karo.
5. Shopify form bharo aur theme snippet lagao (upar wale steps).

Customers ka database sab stores mein shared hai. Ek customer ek hi mobile/email se har store mein login kar sakta hai, aur `users.stores` mein dikhta hai ki kis-kis store mein aaya.

**Custom domain:** agar Shopify ki screen par callback URL `account.yourbrand.com` jaisa ho, to store file mein `"accountDomain": "account.yourbrand.com"` daalo aur `setup` dobara chalao. Koi extra URL ho to `extraRedirectUris` / `extraLogoutUris` mein daal do.

### Store commands

```
npm run store -- list                      sab stores aur kaun setup hai
npm run store -- setup <id>                client + snippet (secret same rehta hai)
npm run store -- setup <id> --new-secret   naya client secret (Shopify mein bhi update karna)
npm run store -- snippet <id>              sirf theme snippet dobara banana
npm run store -- cleanup                   purane / bekaar clients hatana
```

---

## 3. Login providers

**Google** (console.cloud.google.com > APIs & Services):
1. OAuth consent screen banao. Testing mode mein apna Gmail **Test users** mein add karo.
2. Credentials > OAuth client ID > Web application. **Authorized redirect URI:** `https://<ISSUER>/social/google/callback`
3. `.env` mein `GOOGLE_CLIENT_ID` aur `GOOGLE_CLIENT_SECRET` daalo, phir server restart karo.

**Facebook:** Facebook Login > Valid OAuth Redirect URI: `https://<ISSUER>/social/facebook/callback`

**Apple:** Services ID > Return URL: `https://<ISSUER>/social/apple/callback`. Isme Domain bhi `ISSUER` wala daalna.

**Gupshup SMS:** `SMS_PROVIDER=gupshup`, user ID aur password `.env` mein. Store ka SMS text store file ke `smsTemplate` mein hota hai. Check karne ke liye:
```
npm run sms:test -- 98XXXXXXXX mojito-plus1
```

**Email:** testing mein `MAIL_TRANSPORT=console` rakho, code terminal mein dikhega. Asli email ke liye `smtp` (Gmail App Password, SES, Brevo...).

---

## 4. Live jaane se pehle

- Asli subdomain (`auth.yourbrand.com`) par deploy karo (Render / Railway / VPS). `.env` mein `NODE_ENV=production`, `DEV_TEST_CLIENT=false`, aur naye random `COOKIE_KEYS` / `OTP_SECRET`.
- `ISSUER` badalne ke baad: `npm run store -- snippet <id>` chalao, theme snippet dobara paste karo, aur Shopify mein Discovery URL update karo.
- Google, Facebook, Apple consoles mein naya redirect URI add karo.

## Security

- OTP: hashed, 10 min expiry, 5 galat try par lock, resend cooldown, ek code ek hi baar chalta hai.
- Passwords bcrypt se save hote hain.
- Har store ki API sirf usi store ki website se chalti hai (origin check). Login ke baad redirect sirf store ke ya Shopify ke URL par hota hai.
- Login ka aakhri step one-time ticket se hota hai, jo 2 minute mein expire ho jata hai.
- Kisi customer ko block karna ho to MongoDB `users` mein `status: "blocked"` kar do.

## Tests

```
MONGODB_URI=mongodb://127.0.0.1:27017/idp_test npm test
```

Tests mein ye sab check hota hai: hosted page, drawer, OTP, merge, password/forgot, Google, Facebook bina email, do stores ki isolation, galat site/URL block, deleted customer, refresh token aur logout.
