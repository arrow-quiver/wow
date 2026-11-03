// Service worker: shows push notifications and opens the right page when one is tapped.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'wow guild', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'wow guild', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag, renotify: true, data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
