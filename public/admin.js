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

  // Store form: show a store's own SMS / email / social fields only when chosen
  document.querySelectorAll('[data-own]').forEach(function (sel) {
    var body = sel.closest('[data-own-block]').querySelector('[data-own-body]');
    var update = function () { body.hidden = sel.value !== '1'; };
    sel.addEventListener('change', update);
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

  // Customer import: read the chosen CSV file into the form
  var csvFile = document.querySelector('[data-csv-file]');
  if (csvFile) {
    var importForm = csvFile.form;
    var info = importForm.querySelector('[data-csv-info]');
    csvFile.addEventListener('change', function () {
      var f = csvFile.files[0];
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) { info.textContent = 'This file is larger than 15 MB. Split it into smaller files.'; csvFile.value = ''; return; }
      var reader = new FileReader();
      reader.onload = function () {
        importForm.csv.value = reader.result;
        importForm.fileName.value = f.name;
        var lines = String(reader.result).split(/\r?\n/).filter(function (l) { return l.trim(); }).length;
        info.textContent = f.name + ': about ' + Math.max(0, lines - 1).toLocaleString('en-IN') + ' rows.';
      };
      reader.onerror = function () { info.textContent = 'Could not read this file.'; };
      reader.readAsText(f);
    });
    importForm.addEventListener('submit', function (e) {
      if (!importForm.csv.value) { e.preventDefault(); info.textContent = 'Choose a CSV file first.'; }
    });
  }

  // Store form: fill an email HTML box with the starter template
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-starter]');
    if (!b) return;
    var type = b.getAttribute('data-starter');
    var box = document.querySelector('textarea[name="' + type + 'Html"]');
    var tpl = document.getElementById('starter-' + type);
    if (!box || !tpl) return;
    if (box.value.trim() && !window.confirm('Replace the HTML in this box with the starter template?')) return;
    var t = document.createElement('textarea'); t.innerHTML = tpl.innerHTML; // decode
    box.value = t.value;
    box.rows = 16;
    box.focus();
  });

  // Store form: "After the new password is saved" only matters for link resets
  var forgotSel = document.querySelector('select[name="forgotMode"]');
  var afterReset = document.querySelector('[data-after-reset]');
  if (forgotSel && afterReset) {
    var syncReset = function () { afterReset.hidden = forgotSel.value !== 'link'; };
    forgotSel.addEventListener('change', syncReset);
    syncReset();
  }

  // Store form: warn before changing a connected store's login domain
  var domainInput = document.querySelector('[data-domain-input]');
  var domainWarn = document.querySelector('[data-domain-warn]');
  if (domainInput && domainWarn && domainInput.getAttribute('data-initial')) {
    domainInput.addEventListener('input', function () {
      domainWarn.hidden = domainInput.value.trim().toLowerCase() === domainInput.getAttribute('data-initial');
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

    // Login window design: preview classes + the little screen showing the drawer width
    var design = function () {
      var get = function (k) { var el = document.querySelector('[data-design="' + k + '"]'); return el ? el.value : ''; };
      root.classList.toggle('idp--filled', get('button') === 'filled');
      root.classList.toggle('idp--rounded', get('corners') === 'rounded');
      root.classList.toggle('idp--sans', get('font') === 'sans');
      var drawer = document.querySelector('.screen-drawer');
      if (drawer) {
        drawer.style.width = (get('width') || '30') + '%';
        drawer.classList.toggle('left', get('side') === 'left');
      }
    };
    document.addEventListener('change', function (e) { if (e.target.matches('[data-design]')) design(); });
    design();
  }
})();
