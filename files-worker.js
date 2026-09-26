// DuckHTS resolves reference.fa.fai beside reference.fa. Serve temporary
// same-origin uploads with HTTP Range semantics for its indexed readers.
const name = "duckgenesnap-local-input-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (!new URL(event.request.url).pathname.startsWith("/local-input/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(name);
    const saved = await cache.match(event.request.url);
    if (!saved) return new Response("Local file unavailable", { status: 404 });
    const blob = await saved.blob(), range = event.request.headers.get("Range");
    const headers = { "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" };
    if (!range) { headers["Content-Length"] = String(blob.size); return new Response(event.request.method === "HEAD" ? null : blob, { headers }); }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
    if (start >= blob.size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
    headers["Content-Range"] = `bytes ${start}-${end}/${blob.size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(event.request.method === "HEAD" ? null : blob.slice(start, end + 1), { status: 206, headers });
  })());
});
