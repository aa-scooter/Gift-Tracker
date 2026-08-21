// VERSION is bumped on every deploy so the cache name changes, which forces `activate` to
// evict every old cache below (old app-shell code can never linger indefinitely on an
// already-installed device again). Bump this string whenever app.js/styles.css/index.html
// change, OR whenever this file itself changes (as it does here, 2026-08-21 -- see the
// isApiRequest fix below) so every device picks up the new fetch handler right away instead
// of running the old one until some unrelated shell change happens to bump it.
const VERSION = "v3-2026-08-21";
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

// /api/* is live, per-request data (customers, rentals, and -- since 2026-08-21 -- rewards),
// never a static asset, so it must never be cached. This used to fall through into the
// "everything else" cache-first branch below, which is a real bug, not a hypothetical one:
// this endpoint's very first live response was a Drive-side error, that error got cached as
// if it were valid data, and every device that had already loaded the app kept being served
// that same stale cached error/response on every subsequent GET /api/loyalty-rewards --
// completely invisible to and unfixable by any server-side deploy, since the browser never
// asked the network again. isApiRequest() routes these to network-only so a request that
// isn't currently reachable simply fails (app.js already handles that; see Manager: Synced
// state) instead of silently resurrecting whatever the first, possibly-broken, response was.
function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (isApiRequest(url)) {
    e.respondWith(fetch(e.request));
    return;
  }

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
