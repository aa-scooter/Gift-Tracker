// VERSION is bumped on every deploy so the cache name changes, which forces `activate` to
// evict every old cache below (old app-shell code can never linger indefinitely on an
// already-installed device again). Bump this string whenever app.js/styles.css/index.html
// change.
const VERSION = "v2-2026-08-10";
const CACHE = `aa-scooter-manager-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  // Activate this new worker immediately rather than waiting for every open tab/PWA
  // instance to be closed first — otherwise a phone can sit on an old worker indefinitely.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app shell (HTML/JS/CSS — the actual Gift Tracker code) always prefers the network
// when it's available, so a device that's had the app installed for weeks still gets
// today's deployed code the next time it opens with a connection. Only when the network
// request fails (genuinely offline) does it fall back to whatever was last cached, so the
// app still opens without a connection.
const SHELL_EXTENSIONS = [".html", ".js", ".css"];
function isAppShellRequest(url) {
  return url.pathname === "/" || url.pathname.endsWith("/") || SHELL_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (isAppShellRequest(url)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else (icons, manifest) changes rarely — cache-first is still fine there,
  // and keeps offline usage working exactly as before for those assets.
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
