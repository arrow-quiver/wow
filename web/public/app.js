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
