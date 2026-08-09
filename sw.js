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
