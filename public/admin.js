// Small helpers for the admin panel. Everything works without it, except copy/preview.
(function () {
  'use strict';

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    } else { fallback(text); done(); }
  }
  function fallback(text) {
    var t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(t);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (b) { copyText(b.parentElement.querySelector('code').getAttribute('data-value'), b); return; }
    b = e.target.closest('[data-copy-textarea]');
    if (b) { copyText(b.parentElement.querySelector('textarea').value, b); return; }
    b = e.target.closest('[data-reveal]');
    if (b) {
      var code = b.parentElement.querySelector('code');
      var shown = b.textContent === 'Hide';
      code.textContent = shown ? new Array(25).join('•') : code.getAttribute('data-value');
      b.textContent = shown ? 'Show' : 'Hide';
    }
  });

  // Settings: show only the fields for the chosen SMS provider / email mode
  document.querySelectorAll('[data-group]').forEach(function (group) {
    var sw = group.querySelector('[data-switch]');
    if (!sw) return;
    var update = function () {
      group.querySelectorAll('[data-when]').forEach(function (f) { f.hidden = f.getAttribute('data-when') !== sw.value; });
    };
    sw.addEventListener('change', update);
    update();
  });

  // Store form: warn before moving a store to another customer list
  var groupSel = document.querySelector('select[name="customerGroup"][data-initial]');
  var groupWarn = document.querySelector('[data-group-warn]');
  if (groupSel && groupWarn && groupSel.getAttribute('data-initial')) {
    groupSel.addEventListener('change', function () {
      groupWarn.hidden = groupSel.value === groupSel.getAttribute('data-initial');
    });
  }

  // Store page: live preview of the login drawer
  var root = document.querySelector('[data-preview-root]');
  if (root) {
    var pv = function (k) { return root.querySelector('[data-pv="' + k + '"]'); };
    var val = function (k) { var el = document.querySelector('[data-preview="' + k + '"]'); return el ? el.value.trim() : ''; };
    var nameInput = document.querySelector('input[name="name"]');
    var picker = document.querySelector('[data-color-picker]');
    var update = function () {
      pv('welcome').textContent = val('welcome'); pv('welcome').hidden = !val('welcome');
      var logo = val('logo');
      if (/^https:\/\//.test(logo)) { pv('logo').src = logo; pv('logo').hidden = false; pv('name').hidden = true; }
      else { pv('logo').hidden = true; pv('name').hidden = false; }
      pv('name').textContent = val('name') || (nameInput && nameInput.value.trim()) || 'Your brand';
      pv('tagline').textContent = val('tagline'); pv('tagline').hidden = !val('tagline');
      var c = val('color');
      if (/^#[0-9a-fA-F]{3,8}$/.test(c)) { root.style.setProperty('--idp-brand', c); if (picker && c.length === 7) picker.value = c; }
    };
    document.addEventListener('input', function (e) {
      if (e.target === picker) {
        var t = document.querySelector('[data-preview="color"]');
        t.value = picker.value;
      }
      if (e.target.matches('[data-preview], [data-color-picker], input[name="name"]')) update();
    });
    update();
  }
})();
