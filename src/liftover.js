import { quote, rows } from "./db.js";
import { readVariants } from "./ingest.js";

export async function liftVariants(db, conn, file, staged, format = "vcf") {
  if (!["vcf", "tsv", "parquet"].includes(format)) throw new Error("Unsupported liftover export format.");
  const chain = staged.url("map.chain"), source = staged.url("source.fa"), destination = staged.url("destination.fa");
  await readVariants(conn, file, { inputBuild: "source", build: "destination", filter: "all_concrete",
    liftover: { chain, source, destination } });
  await conn.query(`CREATE OR REPLACE TABLE liftover_results AS SELECT sample_id, gt, input_chrom, input_pos,
    input_ref, input_alt, lo.dest_chrom::VARCHAR AS chrom, lo.dest_pos::BIGINT AS pos,
    lo.dest_ref::VARCHAR AS ref, lo.dest_alt::VARCHAR AS alt, lo.mapped AS mapped,
    lo.reverse_complemented AS reverse_complemented, lo.swap AS swapped,
    lo.reject_reason::VARCHAR AS reject_reason, lo.note::VARCHAR AS note
    FROM user_variant_source WHERE alt_count = 1 AND regexp_matches(upper(input_ref), '^[ACGT]+$')
      AND regexp_matches(upper(input_alt), '^[ACGT]+$')`);
  const counts = rows(await conn.query("SELECT count(*) AS total, count(*) FILTER (WHERE mapped) AS mapped FROM liftover_results"))[0];
  if (format === "vcf") {
    await conn.query(`CREATE OR REPLACE TABLE liftover_vcf_records AS SELECT * FROM liftover_results
      WHERE mapped AND pos IS NOT NULL AND regexp_matches(upper(ref), '^[ACGT]+$') AND regexp_matches(upper(alt), '^[ACGT]+$')`);
    await conn.query(`CREATE OR REPLACE TABLE liftover_vcf_normalized AS SELECT *, pos_normed AS vcf_pos,
      ref_normed AS vcf_ref, alt_normed[1] AS vcf_alt FROM duckhts_bcftools_norm('liftover_vcf_records',
      ${quote(destination)}, chrom_col := 'chrom', pos_col := 'pos', ref_col := 'ref', alt_col := 'alt',
      fasta_index_path := ${quote(staged.url("destination.fa.fai"))}) WHERE array_length(alt_normed) = 1`);
  }
  const path = `lifted-${crypto.randomUUID()}.${format}`;
  try {
    if (format === "vcf") {
      const names = rows(await conn.query("SELECT DISTINCT sample_id FROM liftover_vcf_normalized WHERE sample_id <> '' AND sample_id IS NOT NULL LIMIT 2"));
      const sample = names.length === 1 && /^[A-Za-z0-9_.-]+$/.test(names[0].sample_id) ? names[0].sample_id : "SAMPLE";
      await conn.query(`COPY (SELECT chrom AS "#CHROM", vcf_pos AS POS, '.' AS ID, vcf_ref AS REF,
        vcf_alt AS ALT, '.' AS QUAL, 'PASS' AS FILTER, '.' AS INFO, 'GT' AS FORMAT,
        coalesce(nullif(gt, ''), './.') AS "${sample}" FROM liftover_vcf_normalized ORDER BY chrom, vcf_pos)
        TO ${quote(path)} (FORMAT CSV, HEADER true, DELIMITER '\t')`);
      const body = new TextDecoder().decode(await db.copyFileToBuffer(path));
      return { ...counts, blob: new Blob(["##fileformat=VCFv4.2\n##source=DuckGeneSnap\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n", body], { type: "text/vcf" }) };
    }
    await conn.query(`COPY (SELECT * FROM liftover_results ORDER BY input_chrom, input_pos) TO ${quote(path)}
      (${format === "parquet" ? "FORMAT PARQUET" : "FORMAT CSV, HEADER true, DELIMITER '\t'"})`);
    return { ...counts, blob: new Blob([await db.copyFileToBuffer(path)], { type: format === "parquet" ? "application/octet-stream" : "text/tab-separated-values" }) };
  } finally { await db.dropFile(path).catch(() => {}); }
}
