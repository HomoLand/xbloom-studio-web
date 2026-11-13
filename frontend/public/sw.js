/* Service worker shell: network-first for HTML, cache-first for hashed assets, never cache API/MCP. */
const CACHE = "xbloom-studio-web-v2";
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./studio-machine.png"];

function isBypassPath(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/healthz" ||
    pathname.endsWith("/sw.js")
  );
}

function isDocumentRequest(req, url) {
  if (req.mode === "navigate") return true;
  if (url.pathname.endsWith("/") || url.pathname.endsWith(".html")) return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isBypassPath(url.pathname)) {
    return;
  }

  if (isDocumentRequest(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html"))),
    );
    return;
  }

  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
