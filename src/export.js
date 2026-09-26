import { resultQuery } from "./match.js";

export async function exportMatches(db, conn, format, filters = {}) {
  if (!["tsv", "csv", "parquet"].includes(format)) throw new Error(`Unsupported format: ${format}`);
  const path = `export-${crypto.randomUUID()}.${format}`;
  const options = format === "parquet" ? "FORMAT PARQUET" :
    format === "tsv" ? "FORMAT CSV, HEADER true, DELIMITER '\t'" : "FORMAT CSV, HEADER true";
  try {
    await conn.query(`COPY (SELECT * ${resultQuery(filters)} ORDER BY gene, annotation_id) TO '${path}' (${options})`);
    const bytes = await db.copyFileToBuffer(path);
    return new Blob([bytes], { type: format === "parquet" ? "application/octet-stream" : "text/plain;charset=utf-8" });
  } finally { await db.dropFile(path).catch(() => {}); }
}
