import * as duckdb from "../vendor/duckdb.js";
import { loadDuckhts } from "../vendor/duckhts-loader.js";

export const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export const rows = (table) => table.toArray().map((row) => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value])));

export async function openDatabase({ dev = false } = {}) {
  const bundles = {
    mvp: { mainModule: new URL("../vendor/duckdb/duckdb-mvp.wasm", import.meta.url).href,
      mainWorker: new URL("../vendor/duckdb/duckdb-browser-mvp.worker.js", import.meta.url).href },
    eh: { mainModule: new URL("../vendor/duckdb/duckdb-eh.wasm", import.meta.url).href,
      mainWorker: new URL("../vendor/duckdb/duckdb-browser-eh.worker.js", import.meta.url).href },
  };
  const bundle = await duckdb.selectBundle(bundles);
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule);
    await db.open({ allowUnsignedExtensions: dev });
    const conn = await db.connect();
    await loadDuckhts(conn, { baseUrl: new URL(dev ? "../vendor/duckhts-dev/" : "../vendor/duckhts/", import.meta.url).href });
    const platform = String((await conn.query("PRAGMA platform")).getChildAt(0).get(0));
    const parquetUrl = new URL(`../vendor/parquet/${platform}/parquet.duckdb_extension.wasm`, import.meta.url);
    await conn.query(`LOAD ${quote(parquetUrl.href)}`);
    return { db, conn, close: async () => { await conn.close(); await db.terminate(); worker.terminate(); } };
  } catch (error) {
    await db.terminate(); worker.terminate();
    throw error;
  }
}

export async function loadAssets(db, conn) {
  for (const name of ["variant_annotations", "genotype_interpretations", "variant_keys"]) {
    const url = new URL(`../public/data/${name}.parquet`, import.meta.url).href;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}`);
    await db.registerFileBuffer(`${name}.parquet`, new Uint8Array(await response.arrayBuffer()));
    await conn.query(`CREATE VIEW ${name} AS SELECT * FROM read_parquet(${quote(name + ".parquet")})`);
  }
}
