import { quote, rows } from "./db.js";
import { localFileUrl } from "../vendor/duckhts-loader.js";

const chromKey = (expr) => `CASE WHEN upper(regexp_replace(${expr}, '^chr', '', 'i')) IN ('M', 'MT') THEN 'MT' ELSE upper(regexp_replace(${expr}, '^chr', '', 'i')) END`;

export async function readChip(db, conn, file) {
  const text = file.name.toLowerCase().endsWith(".gz")
    ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await file.text();
  const calls = [], stats = { data_lines: 0, skipped_no_call: 0, skipped_malformed: 0 };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^(rsid|id|marker|marker_id)\s/i.test(trimmed)) continue;
    stats.data_lines++;
    const [marker, chrom, pos, genotype] = trimmed.split(/\s+/);
    if (!marker || !chrom || !/^\d+$/.test(pos || "") || Number(pos) < 1 || !genotype) {
      stats.skipped_malformed++; continue;
    }
    if (genotype === "--") { stats.skipped_no_call++; continue; }
    const gt = genotype.toUpperCase();
    calls.push([marker, chrom, pos, gt, /^[ACGT]{2}$/.test(gt) ? [...gt].sort().join("") : gt]);
  }
  if (!calls.length) throw new Error("No analyzable genotype rows found in the 23andMe-style file.");
  const tsv = "marker_id\tchrom\tpos\tgenotype\tgenotype_norm\n" + calls.map((r) => r.join("\t")).join("\n") + "\n";
  await db.registerFileBuffer("calls.tsv", new TextEncoder().encode(tsv));
  await conn.query(`CREATE OR REPLACE TABLE user_snps AS SELECT marker_id::VARCHAR AS marker_id, chrom::VARCHAR AS chrom,
    ${chromKey("chrom::VARCHAR")} AS chrom_norm, pos::BIGINT AS pos, genotype::VARCHAR AS genotype,
    genotype_norm::VARCHAR AS genotype_norm FROM read_csv('calls.tsv', delim='\\t', header=true, all_varchar=true)`);
  return { ...stats, parsed_snps: calls.length };
}

export async function readVariants(conn, file, { inputBuild, build, filter = "called_alt", liftover = null } = {}) {
  // The signed 1.5.2 extension cannot open blob: files. Only the explicit
  // ?duckhts=dev switch stages the pinned unsigned build with local VFS support.
  const source = localFileUrl(file);
  try {
    const path = quote(source.url);
    const schema = rows(await conn.query(`DESCRIBE SELECT * FROM read_bcf(${path}, tidy_format := true, scan_mode := 'sequential')`));
    const col = (names, fallback = null) => {
      const found = schema.find((s) => names.some((n) => n.toLowerCase() === s.column_name.toLowerCase()));
      if (!found && fallback === null) throw new Error(`VCF reader missing ${names[0]}`);
      return found ? `"${found.column_name.replaceAll('"', '""')}"` : fallback;
    };
    const chrom = col(["CHROM", "#CHROM"]), pos = col(["POS"]), ref = col(["REF"]), alt = col(["ALT"]);
    const altType = schema.find((s) => s.column_name.toLowerCase() === "alt").column_type;
    const firstAlt = /\[\]|LIST/i.test(altType) ? `${alt}[1]` : `split_part(${alt}::VARCHAR, ',', 1)`;
    const countAlt = /\[\]|LIST/i.test(altType) ? `array_length(${alt})` : `array_length(string_split(${alt}::VARCHAR, ','))`;
    const gt = col(["FORMAT_GT", "GT", "GENOTYPE"], "''::VARCHAR");
    const sample = col(["SAMPLE_ID", "SAMPLE"], "''::VARCHAR");
    const hasGt = gt !== "''::VARCHAR";
    if (inputBuild !== build && !liftover) throw new Error("Builds differ; provide a chain and source/destination FASTA for liftover.");
    const lifted = liftover ? `bcftools_liftover(${chrom}::VARCHAR, ${pos}::BIGINT, ${ref}::VARCHAR, ${firstAlt}::VARCHAR,
      ${quote(liftover.chain)}, ${quote(liftover.destination)}, ${quote(liftover.source)}, 1, 250, false, NULL::BIGINT, false)` : "NULL";
    await conn.query(`CREATE OR REPLACE TABLE user_variant_source AS SELECT ${sample}::VARCHAR AS sample_id,
      ${gt}::VARCHAR AS gt, ${hasGt} AS has_gt, ${chrom}::VARCHAR AS input_chrom, ${pos}::BIGINT AS input_pos,
      ${ref}::VARCHAR AS input_ref, ${firstAlt}::VARCHAR AS input_alt,
      ${chrom}::VARCHAR AS chrom, ${pos}::BIGINT AS pos, ${ref}::VARCHAR AS ref, ${firstAlt}::VARCHAR AS alt,
      ${countAlt} AS alt_count, ${lifted} AS lo
      FROM read_bcf(${path}, tidy_format := true, scan_mode := 'sequential')`);
    const liftedSql = liftover ? "lo.dest_chrom::VARCHAR AS chrom, lo.dest_pos::BIGINT AS pos, lo.dest_ref::VARCHAR AS ref, lo.dest_alt::VARCHAR AS alt, lo.mapped AS mapped" : "chrom, pos, ref, alt, TRUE AS mapped";
    await conn.query(`CREATE OR REPLACE TABLE user_variant_keyed AS WITH lifted AS (
      SELECT sample_id, gt, has_gt, input_chrom, input_pos, input_ref, input_alt, ${liftedSql}, alt_count
      FROM user_variant_source), valid AS (SELECT * FROM lifted WHERE mapped AND chrom IS NOT NULL AND pos IS NOT NULL
      AND alt_count = 1 AND regexp_matches(upper(ref), '^[ACGT]+$') AND regexp_matches(upper(alt), '^[ACGT]+$')
      ${filter === "called_alt" ? "AND (NOT has_gt OR regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'))" : ""}),
      alleles AS (SELECT *, CASE regexp_extract(gt, '^([0-9.]+)', 1) WHEN '0' THEN ref WHEN '1' THEN alt END AS allele_a,
      CASE regexp_extract(gt, '^[0-9.]+[/|]([0-9.]+)', 1) WHEN '0' THEN ref WHEN '1' THEN alt END AS allele_b FROM valid)
      SELECT sample_id, gt AS input_genotype, input_chrom, input_pos, input_ref, input_alt, chrom,
      ${chromKey("chrom")} AS chrom_norm, pos, ref, alt,
      CASE WHEN allele_a IS NOT NULL AND allele_b IS NOT NULL AND length(allele_a) = 1 AND length(allele_b) = 1
        THEN least(upper(allele_a), upper(allele_b)) || greatest(upper(allele_a), upper(allele_b)) ELSE coalesce(gt, '') END AS genotype_norm,
      variantkey(chrom, pos, ref, alt) AS variant_key, variantkey_hex(variantkey(chrom, pos, ref, alt)) AS variant_key_hex FROM alleles`);
    return { raw_records: rows(await conn.query("SELECT count(*) AS n FROM user_variant_source"))[0].n,
      keyed_records: rows(await conn.query("SELECT count(*) AS n FROM user_variant_keyed"))[0].n };
  } finally { source.revoke(); }
}

export function detectKind(file) {
  return /\.(vcf|vcf\.gz|bcf)$/i.test(file.name) ? "vcf" : "chip";
}
