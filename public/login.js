/*
 * Login widget. One file for both places:
 *  - store drawer (Shopify theme snippet): <div id="idp-login" data-idp=".." data-store=".." hidden>
 *    opens when the account icon is clicked.
 *  - hosted login page: same div with data-mode="page", shown as a card.
 */
(function () {
  'use strict';
  var root = document.getElementById('idp-login');
  if (!root || root.getAttribute('data-ready')) return;
  root.setAttribute('data-ready', '1');

  var d = root.dataset;
  var IDP = (d.idp || '').replace(/\/$/, '');
  var STORE = d.store;
  var MODE = d.mode === 'page' ? 'page' : 'drawer';
  var TRIGGER = d.trigger || '.header__icon--account, a[href*="/account"]:not([href*="logout"]), a[href*="customer_authentication/login"]';
  var state = { flowId: d.flow || null, cfg: null, linkHref: null, lastFocus: null, timer: null };

  var TITLES = {
    mobile: 'Login or Create an Account',
    otp: 'Verify OTP',
    profile: 'Complete Your Profile',
    password: 'Login Using Email & Password',
    forgot: 'Forgot Password',
    reset: 'Set New Password',
    loading: 'Signing you in'
  };
  var SUBS = {
    forgot: 'We’ll email you a code to set a new password. Works even if you have never made one.'
  };
  var NAMES = { google: 'Google', facebook: 'Facebook', apple: 'Apple' };
  var ICONS = {
    google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1877F2" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z"/></svg>',
    apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#000" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.6 1.3-.1 1.7-.8 3.3-.8 1.5 0 1.9.8 3.3.8 1.4 0 2.2-1.3 3-2.5 1-1.4 1.3-2.7 1.4-2.8-.1 0-2.4-.9-2.4-4.2zM13.9 4.9c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg>'
  };
  var EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  var X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

  function pw(name, auto, ph) {
    return '<div class="idp-pw"><input name="' + name + '" type="password" autocomplete="' + auto + '" placeholder="' + ph + '" aria-label="' + ph + '">' +
      '<button type="button" class="idp-eye" aria-label="Show password" data-eye>' + EYE + '</button></div>';
  }

  root.className = 'idp idp--' + MODE;
  root.innerHTML = [
    MODE === 'drawer' ? '<div class="idp-overlay" data-close></div>' : '',
    '<div class="idp-panel"' + (MODE === 'drawer' ? ' role="dialog" aria-modal="true"' : '') + ' aria-labelledby="idp-title" tabindex="-1">',
    MODE === 'drawer' ? '<button type="button" class="idp-x" data-close aria-label="Close">' + X + '</button>' : '',
    '<div class="idp-inner">',
    '<div class="idp-head"><p class="idp-welcome" data-b="welcome"></p><img class="idp-logo" data-b="logo" alt="" hidden>',
    '<div class="idp-wordmark" data-b="name"></div><p class="idp-tagline" data-b="tagline"></p></div>',
    '<hr class="idp-rule">',
    '<h2 class="idp-h" id="idp-title"></h2><p class="idp-sub" hidden></p><div class="idp-error" role="alert" hidden></div>',

    '<form class="idp-view" data-view="mobile" novalidate>',
    '<label class="idp-phone"><span class="idp-cc" data-b="cc">+91</span>',
    '<input name="mobile" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14" placeholder="Mobile number" aria-label="Mobile number"></label>',
    '<button class="idp-btn" type="submit">Continue with mobile number</button>',
    '<div class="idp-social"></div>',
    '<p class="idp-link"><a href="#" data-go="password">Login using password</a></p>',
    '</form>',

    '<form class="idp-view" data-view="otp" hidden novalidate>',
    '<input name="code" class="idp-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="Enter OTP" aria-label="OTP">',
    '<button class="idp-btn" type="submit">Verify</button>',
    '<p class="idp-muted">Didn’t receive the code? <button type="button" class="idp-textbtn" data-resend>Resend OTP</button></p>',
    '<p class="idp-back"><a href="#" data-go="mobile">‹ Back</a></p>',
    '</form>',

    '<form class="idp-view" data-view="profile" hidden novalidate>',
    '<div class="idp-row" data-need-name><input name="firstName" autocomplete="given-name" placeholder="First name" aria-label="First name">',
    '<input name="lastName" autocomplete="family-name" placeholder="Last name" aria-label="Last name"></div>',
    '<input name="email" type="email" autocomplete="email" placeholder="Email address" aria-label="Email address">',
    '<button class="idp-btn" type="submit">Continue</button>',
    '</form>',

    '<form class="idp-view" data-view="password" hidden novalidate>',
    '<input name="email" type="email" autocomplete="username" placeholder="Email address" aria-label="Email address">',
    pw('password', 'current-password', 'Password'),
    '<p class="idp-right"><a href="#" data-go="forgot">Forgot Password?</a></p>',
    '<button class="idp-btn" type="submit">Login</button>',
    '<div class="idp-social"></div>',
    '<p class="idp-link"><a href="#" data-go="mobile">Login using OTP</a></p>',
    '</form>',

    '<form class="idp-view" data-view="forgot" hidden novalidate>',
    '<input name="email" type="email" autocomplete="email" placeholder="Email address" aria-label="Email address">',
    '<button class="idp-btn" type="submit">Send request</button>',
    '<p class="idp-back"><a href="#" data-go="password">‹ Back</a></p>',
    '</form>',

    '<form class="idp-view" data-view="reset" hidden novalidate>',
    pw('password', 'new-password', 'New password (min 8, letters + numbers)'),
    pw('confirmPassword', 'new-password', 'Confirm new password'),
    '<button class="idp-btn" type="submit">Save and login</button>',
    '</form>',

    '<div class="idp-view idp-loading" data-view="loading" hidden><span class="idp-spinner" aria-hidden="true"></span><p>Signing you in…</p></div>',
    '</div></div>'
  ].join('');

  // ---------- helpers ----------
  function q(sel) { return root.querySelector(sel); }
  function form(name) { return q('[data-view="' + name + '"]'); }
  var title = q('#idp-title');
  var sub = q('.idp-sub');
  var errBox = q('.idp-error');

  function setError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; }

  function show(view, subtitle) {
    root.querySelectorAll('.idp-view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== view; });
    title.textContent = TITLES[view] || '';
    subtitle = subtitle || SUBS[view] || '';
    sub.textContent = subtitle;
    sub.hidden = !subtitle;
    setError('');
    var first = form(view) && form(view).querySelector('input:not([hidden])');
    if (first && (MODE === 'page' || !root.hidden)) setTimeout(function () { first.focus(); }, 60);
  }

  function api(path, body) {
    var opts = { method: body ? 'POST' : 'GET', headers: { 'ngrok-skip-browser-warning': '1' } };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(IDP + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
        return j;
      });
    }, function () { throw new Error('Could not reach the login server. Please check your internet and try again.'); });
  }

  // Where Shopify should take the customer after login
  function returnTo() {
    if (MODE === 'page') return d.returnTo;
    if (state.cfg && state.cfg.afterLogin === 'account' && state.linkHref) return state.linkHref;
    return location.origin + '/customer_authentication/login?return_to=' + encodeURIComponent(location.pathname + location.search);
  }

  function base(extra) {
    var b = { store: STORE, flowId: state.flowId, returnTo: returnTo() };
    for (var k in extra) b[k] = extra[k];
    return b;
  }

  // ---------- store branding + social buttons ----------
  function applyConfig(cfg) {
    state.cfg = cfg;
    var b = cfg.brand || {};
    if (b.color) root.style.setProperty('--idp-brand', b.color);
    var welcome = q('[data-b="welcome"]'); welcome.textContent = b.welcome || ''; welcome.hidden = !b.welcome;
    var tagline = q('[data-b="tagline"]'); tagline.textContent = b.tagline || ''; tagline.hidden = !b.tagline;
    var logo = q('[data-b="logo"]'); var name = q('[data-b="name"]');
    if (b.logoUrl) { logo.src = b.logoUrl; logo.alt = b.name || ''; logo.hidden = false; name.hidden = true; }
    else { logo.hidden = true; name.hidden = false; name.textContent = b.name || ''; }
    q('[data-b="cc"]').textContent = '+' + (cfg.countryCode || '91');
    form('otp').code.maxLength = cfg.otpLength || 6;
    renderSocial();
  }

  function renderSocial() {
    var s = (state.cfg && state.cfg.social) || {};
    var list = ['google', 'facebook', 'apple'].filter(function (p) { return s[p]; });
    root.querySelectorAll('.idp-social').forEach(function (box) {
      box.textContent = '';
      if (!list.length) return;
      var div = document.createElement('div'); div.className = 'idp-divider'; div.innerHTML = '<span>or</span>';
      var tiles = document.createElement('div'); tiles.className = 'idp-tiles'; tiles.style.setProperty('--cols', list.length);
      list.forEach(function (p) {
        var a = document.createElement('a');
        a.className = 'idp-tile';
        a.href = IDP + '/login/social/' + p + '?store=' + encodeURIComponent(STORE) + '&returnTo=' + encodeURIComponent(returnTo());
        a.innerHTML = ICONS[p] + '<span>' + NAMES[p] + '</span>';
        tiles.appendChild(a);
      });
      box.appendChild(div); box.appendChild(tiles);
    });
  }

  var cfgReady = null;
  function loadConfig() {
    if (!cfgReady) {
      cfgReady = (d.config ? Promise.resolve(JSON.parse(d.config)) : api('/api/login/config?store=' + encodeURIComponent(STORE)))
        .then(function (c) { applyConfig(c); return c; })
        .catch(function (e) { cfgReady = null; throw e; });
    }
    return cfgReady;
  }

  // ---------- steps ----------
  function startCountdown() {
    var b = q('[data-resend]');
    var left = (state.cfg && state.cfg.resendSeconds) || 30;
    clearInterval(state.timer);
    b.disabled = true;
    b.textContent = 'Resend OTP in ' + left + 's';
    state.timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { clearInterval(state.timer); b.disabled = false; b.textContent = 'Resend OTP'; return; }
      b.textContent = 'Resend OTP in ' + left + 's';
    }, 1000);
  }

  function step(res) {
    if (res.flowId) state.flowId = res.flowId;
    if (res.step === 'otp') {
      form('otp').code.value = '';
      show('otp', 'Enter the ' + (res.length || 6) + '-digit code sent to ' + res.masked);
      startCountdown();
    } else if (res.step === 'profile') {
      var p = form('profile');
      q('[data-need-name]').hidden = !res.needName;
      p.email.hidden = !res.needEmail;
      if (res.email) p.email.value = res.email;
      show('profile', res.needEmail ? 'Use the same email you used for your orders, so they show up in your account. We’ll send a code to verify it.' : 'Tell us your name to finish.');
    } else if (res.step === 'reset') {
      show('reset');
    } else if (res.step === 'done') {
      show('loading');
      window.location.href = res.redirect;
    }
  }

  function fail(err) {
    if (err && err.status === 410) { state.flowId = null; show('mobile'); }
    setError((err && err.message) || 'Something went wrong. Please try again.');
  }

  function onSubmit(name, handler) {
    form(name).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.currentTarget;
      if (f.getAttribute('data-busy')) return;
      var btn = f.querySelector('button[type=submit]');
      f.setAttribute('data-busy', '1'); if (btn) btn.disabled = true;
      setError('');
      Promise.resolve().then(function () { return handler(f); }).then(step).catch(fail)
        .then(function () { f.removeAttribute('data-busy'); if (btn) btn.disabled = false; });
    });
  }

  onSubmit('mobile', function (f) {
    var m = f.mobile.value.replace(/\D/g, '');
    if (m.length < 10) throw new Error('Please enter a valid 10-digit mobile number.');
    return api('/api/login/otp/send', base({ mobile: m }));
  });
  onSubmit('otp', function (f) {
    var c = f.code.value.replace(/\D/g, '');
    if (!c) throw new Error('Please enter the code.');
    return api('/api/login/otp/verify', { flowId: state.flowId, code: c });
  });
  onSubmit('profile', function (f) {
    return api('/api/login/profile', { flowId: state.flowId, firstName: f.firstName.value, lastName: f.lastName.value, email: f.email.value });
  });
  onSubmit('password', function (f) {
    return api('/api/login/password', base({ email: f.email.value, password: f.password.value }));
  });
  onSubmit('forgot', function (f) {
    return api('/api/login/forgot', base({ email: f.email.value }));
  });
  onSubmit('reset', function (f) {
    if (!f.password.value) throw new Error('Please enter a new password.');
    if (f.password.value !== f.confirmPassword.value) throw new Error('The passwords don’t match. Please enter the same password twice.');
    return api('/api/login/reset', { flowId: state.flowId, password: f.password.value, confirmPassword: f.confirmPassword.value });
  });

  q('[data-resend]').addEventListener('click', function () {
    setError('');
    api('/api/login/otp/resend', { flowId: state.flowId }).then(step).catch(fail);
  });

  root.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) {
      e.preventDefault();
      if (go.getAttribute('data-go') === 'mobile') state.flowId = null;
      show(go.getAttribute('data-go'));
      return;
    }
    if (e.target.closest('[data-close]')) { e.preventDefault(); close(); return; }
    var eye = e.target.closest('[data-eye]');
    if (eye) {
      var input = eye.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.classList.toggle('on', input.type === 'text');
    }
  });

  root.addEventListener('input', function (e) {
    if (e.target.name === 'code' || e.target.name === 'mobile') e.target.value = e.target.value.replace(/\D/g, '');
  });

  // ---------- drawer open / close ----------
  function open(href) {
    if (MODE !== 'drawer') return;
    state.linkHref = href || null;
    state.lastFocus = document.activeElement;
    state.flowId = null;
    root.hidden = false;
    document.documentElement.classList.add('idp-lock');
    requestAnimationFrame(function () { root.classList.add('is-open'); });
    show('mobile');
    loadConfig().then(renderSocial).catch(function () { setError('Login is not available right now. Please try again in a minute.'); });
  }

  function close() {
    if (MODE !== 'drawer') return;
    root.classList.remove('is-open');
    document.documentElement.classList.remove('idp-lock');
    setTimeout(function () { root.hidden = true; }, 300);
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  if (MODE === 'drawer') {
    root.hidden = true;
    loadConfig().catch(function () {});
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !root.hidden) close(); });
    // Account icon -> open drawer instead of leaving the page
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest(TRIGGER);
      if (!a || root.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      open(a.href);
    }, true);
    window.IdpLogin = { open: open, close: close };
  } else {
    root.hidden = false;
    loadConfig().catch(function () {});
    if (d.step === 'profile') step({ step: 'profile', flowId: d.flow, needName: !!d.needName, needEmail: true, email: d.email || '' });
    else show('mobile');
    if (d.error) setError(d.error);
  }
})();
