// Service worker minimal : condition nécessaire à l'installabilité PWA sur Chrome/Android.
// Pas de mise en cache agressive (l'appli dépend de contenu TMDB à jour) : on se contente
// d'un fetch réseau direct, avec un léger cache de secours pour la coquille de l'appli.
const CACHE_NAME = "ce-soir-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Notifications push (voir index.js côté Worker pour l'envoi chiffré RFC 8291). Le payload est
// un JSON simple { title, body, icon, url } — pas de contenu sensible, la notif ne fait que
// pointer vers l'app.
self.addEventListener("push", (event) => {
  let data = { title: "Quoi regarder", body: "Nouvelle notification" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "./icon-192.png",
      badge: "./icon-192.png",
      data: { url: data.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
