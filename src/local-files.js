const cacheName = "duckgenesnap-local-input-v1";

export async function stagePairedFiles(files) {
  if (!("serviceWorker" in navigator) || !("caches" in self)) throw new Error("Indexed FASTA liftover requires Service Worker and Cache Storage support.");
  const base = new URL("../", import.meta.url);
  await navigator.serviceWorker.register(new URL("files-worker.js", base), { scope: base.pathname });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
  const root = new URL(`local-input/${crypto.randomUUID()}/`, base);
  const cache = await caches.open(cacheName);
  const paths = [];
  try {
    for (const [filename, file] of Object.entries(files)) {
      if (!file) throw new Error(`Choose ${filename}.`);
      const url = new URL(filename, root).href;
      await cache.put(url, new Response(file));
      paths.push(url);
    }
    return { url: (filename) => new URL(filename, root).href,
      release: async () => { for (const path of paths) await cache.delete(path); } };
  } catch (error) {
    for (const path of paths) await cache.delete(path);
    throw error;
  }
}
