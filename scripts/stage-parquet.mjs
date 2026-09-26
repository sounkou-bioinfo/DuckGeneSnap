import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("parquet-manifest.json", "utf8"));
for (const [platform, digest] of Object.entries(manifest.files)) {
  const url = manifest.source.replace("{platform}", platform);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error(`Invalid sha256: ${url}`);
  await mkdir(`vendor/parquet/${platform}`, { recursive: true });
  await writeFile(`vendor/parquet/${platform}/parquet.duckdb_extension.wasm`, bytes);
}
