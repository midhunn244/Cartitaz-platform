(function () {
  'use strict';
  var base = document.querySelector('meta[name=admin-base]').content;
  var f = document.getElementById('f'), err = document.getElementById('err'), go = document.getElementById('go');
  var totpRow = document.getElementById('totpRow'), totp = document.getElementById('c');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var body = { username: f.username.value.trim(), password: f.password.value };
    if (!totpRow.hidden) body.totp = totp.value.trim();
    if (!body.username || !body.password) { err.textContent = 'Enter your username and password.'; return; }
    go.disabled = true;
    fetch(base + '/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok) { location.replace(base + '/'); return; }
        if (x.j.need_totp) { totpRow.hidden = false; totp.focus(); }
        err.textContent = x.j.error || 'Sign-in failed.';
        go.disabled = false;
      })
      .catch(function () { err.textContent = 'Network error. Try again.'; go.disabled = false; });
  });
})();
