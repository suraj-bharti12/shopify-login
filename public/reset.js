// Password reset page (opened from the email link): show / hide password and
// check that both fields match before sending.
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var eye = e.target.closest('[data-eye]');
    if (!eye) return;
    var input = eye.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    eye.classList.toggle('on', input.type === 'text');
  });
  var form = document.querySelector('form[action="/reset-password"]');
  var box = document.querySelector('.idp-error');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    var msg = '';
    if (!form.password.value) msg = 'Please enter a new password.';
    else if (form.password.value !== form.confirmPassword.value) msg = 'The passwords don’t match. Please enter the same password twice.';
    if (msg) { e.preventDefault(); box.textContent = msg; box.hidden = false; return; }
    form.querySelector('button[type=submit]').disabled = true;
  });
})();
