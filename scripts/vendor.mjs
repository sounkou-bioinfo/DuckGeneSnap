// Bundle DuckDB and Arrow locally. When duckhts@dev is published, replace the
// pinned staging manifest and local loader with its npm package exports.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const dist = "node_modules/@duckdb/duckdb-wasm/dist";
await mkdir("vendor/duckdb", { recursive: true });
await build({ entryPoints: [`${dist}/duckdb-browser.mjs`], outfile: "vendor/duckdb.js",
  bundle: true, format: "esm", minify: true, legalComments: "eof" });
for (const file of ["duckdb-mvp.wasm", "duckdb-browser-mvp.worker.js", "duckdb-eh.wasm", "duckdb-browser-eh.worker.js"]) {
  await copyFile(`${dist}/${file}`, `vendor/duckdb/${file}`);
}
await copyFile("src/duckhts-loader.js", "vendor/duckhts-loader.js");
