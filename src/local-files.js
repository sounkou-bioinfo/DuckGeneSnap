const cacheName = "duckgenesnap-local-input-v1";

export async function stagePairedFiles(files) {
  if (!("serviceWorker" in navigator) || !("caches" in self)) throw new Error("Indexed FASTA liftover requires Service Worker and Cache Storage support.");
  await navigator.serviceWorker.register("/files-worker.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
  const root = `/local-input/${crypto.randomUUID()}/`;
  const cache = await caches.open(cacheName);
  const paths = [];
  try {
    for (const [filename, file] of Object.entries(files)) {
      if (!file) throw new Error(`Choose ${filename}.`);
      const url = new URL(root + filename, location.href).href;
      await cache.put(url, new Response(file));
      paths.push(url);
    }
    return { url: (filename) => new URL(root + filename, location.href).href,
      release: async () => { for (const path of paths) await cache.delete(path); } };
  } catch (error) {
    for (const path of paths) await cache.delete(path);
    throw error;
  }
}
