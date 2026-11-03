// Show stored UTC times in the viewer's own time zone.
(function () {
  var fmt = {
    full: { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
    time: { hour: '2-digit', minute: '2-digit' },
    date: { weekday: 'long', day: 'numeric', month: 'long' },
  };
  document.querySelectorAll('time[data-local]').forEach(function (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (!isNaN(d)) el.textContent = d.toLocaleString(undefined, fmt[el.dataset.local] || fmt.full);
  });
  // datetime-local inputs are in the browser's zone: send the UTC offset along so the server stores UTC.
  document.querySelectorAll('input[name="tz_offset"]').forEach(function (el) {
    el.value = String(new Date().getTimezoneOffset());
  });
  // Confirm buttons that can't be undone.
  document.querySelectorAll('[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) { if (!window.confirm(el.dataset.confirm)) e.preventDefault(); });
  });
})();

// Push notifications: Settings → "Turn on for this device".
(function () {
  var box = document.getElementById('push-controls');
  if (!box) return;
  var status = document.getElementById('push-status');
  var csrf = box.getAttribute('data-csrf');
  var say = function (t) { if (status) status.textContent = t; };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say('This browser can’t show notifications from websites. On iPhone, add this site to your Home Screen first.');
    box.querySelectorAll('[data-push]').forEach(function (b) { b.disabled = true; });
    return;
  }
  var post = function (url, body) {
    body._csrf = csrf;
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  };
  var keyBytes = function (b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  box.querySelector('[data-push="on"]').addEventListener('click', function () {
    say('Asking your browser…');
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { say('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'); return; }
      return navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
        return fetch('/push/key', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (k) {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.publicKey) });
        });
      }).then(function (sub) { return post('/push/subscribe', { subscription: sub.toJSON() }); })
        .then(function (r) { if (r.ok) { say('Notifications are on for this device.'); setTimeout(function () { location.reload(); }, 800); } else say('Couldn’t turn them on. Reload and try again.'); });
    }).catch(function (e) { say('Couldn’t turn them on: ' + e.message); });
  });
  var off = box.querySelector('[data-push="off"]');
  if (off) off.addEventListener('click', function () {
    navigator.serviceWorker.getRegistration().then(function (reg) { return reg && reg.pushManager.getSubscription(); })
      .then(function (sub) { var ep = sub && sub.endpoint; return (sub ? sub.unsubscribe() : Promise.resolve()).then(function () { return post('/push/unsubscribe', { endpoint: ep }); }); })
      .then(function () { say('Notifications are off for this device.'); setTimeout(function () { location.reload(); }, 800); });
  });
})();
