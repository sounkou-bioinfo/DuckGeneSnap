import { quote, rows } from "./db.js";
import { localFileUrl } from "../vendor/duckhts-loader.js";

const normChrom = (chrom) => chrom.replace(/^chr/i, "").toUpperCase().replace(/^M$/, "MT");

// Single-base chip calls need a reference allele before they can become VCF.
// fasta_nuc is the DuckHTS indexed reader; no reference sequence is guessed.
export async function convertChip(db, conn, file, fasta, fai, { sample = "SAMPLE", emitHomAlt = true } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(sample)) throw new Error("Sample ID must use letters, digits, underscore, dot or hyphen.");
  const index = new Map((await fai.text()).trim().split(/\r?\n/).map((line) => {
    const [chrom] = line.split("\t"); return [normChrom(chrom), chrom];
  }));
  const calls = [], regions = new Set();
  for (const line of (await file.text()).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#") || /^(rsid|id|marker|marker_id)\s/i.test(line)) continue;
    const [marker, chrom, pos, gt] = line.trim().split(/\s+/);
    if (!marker || !chrom || !/^\d+$/.test(pos || "") || Number(pos) < 1 || !gt) continue;
    const resolved = index.get(normChrom(chrom)) || "";
    calls.push({ marker, chrom, pos: Number(pos), gt: gt.toUpperCase(), resolved });
    if (resolved) regions.add(`${resolved}\t${Number(pos) - 1}\t${pos}`);
  }
  if (!calls.length) throw new Error("No valid chip rows to convert.");
  if (!regions.size) throw new Error("No chip chromosome names matched the FASTA index.");
  const ref = localFileUrl(fasta), refIndex = localFileUrl(fai);
  const bed = localFileUrl(new Blob([[...regions].join("\n") + "\n"]));
  try {
    const tsv = "marker\tchrom\tpos\tgt\tresolved\n" + calls.map(({ marker, chrom, pos, gt, resolved }) =>
      [marker, chrom, pos, gt, resolved || "_"].join("\t")).join("\n") + "\n";
    await db.registerFileBuffer("chip-conversion.tsv", new TextEncoder().encode(tsv));
    await conn.query(`CREATE OR REPLACE TABLE chip_conversion_source AS SELECT marker, chrom,
      pos::BIGINT AS pos, gt, nullif(resolved, '_') AS resolved FROM read_csv('chip-conversion.tsv',
      delim='\t', header=true, all_varchar=true)`);
    await conn.query(`CREATE OR REPLACE TABLE chip_ref_bases AS SELECT chrom AS resolved,
      start + 1 AS pos, upper(seq) AS ref FROM fasta_nuc(${quote(ref.url)},
      bed_path := ${quote(bed.url)}, index_path := ${quote(refIndex.url)}, include_seq := true)`);
    const rc = (base) => `CASE ${base} WHEN 'A' THEN 'T' WHEN 'T' THEN 'A' WHEN 'C' THEN 'G' WHEN 'G' THEN 'C' END`;
    await conn.query(`CREATE OR REPLACE TABLE chip_conversion_qc AS WITH joined AS (
      SELECT c.*, r.ref, substr(gt, 1, 1) AS a, substr(gt, 2, 1) AS b
      FROM chip_conversion_source c LEFT JOIN chip_ref_bases r USING (resolved, pos)
    ), oriented AS (SELECT *, ${rc("a")} AS arc, ${rc("b")} AS brc FROM joined)
    SELECT marker, chrom, pos, gt, resolved, ref,
      CASE WHEN a = ref AND b <> ref THEN b WHEN b = ref AND a <> ref THEN a
        WHEN arc = ref AND brc <> ref THEN brc WHEN brc = ref AND arc <> ref THEN arc
        WHEN a = b AND a <> ref AND ${emitHomAlt ? "TRUE" : "FALSE"} THEN a END AS alt,
      CASE WHEN a = b AND a <> ref AND ${emitHomAlt ? "TRUE" : "FALSE"} THEN '1/1'
        WHEN a = ref OR b = ref OR arc = ref OR brc = ref THEN '0/1' END AS vcf_gt,
      CASE WHEN a = ref OR b = ref THEN 'forward'
        WHEN a <> b AND (arc = ref OR brc = ref) THEN 'reverse_complement'
        WHEN a = b AND ${emitHomAlt ? "TRUE" : "FALSE"} THEN 'forward_assumed_hom_alt' ELSE '' END AS orientation,
      CASE WHEN gt = '--' THEN 'no_call'
        WHEN NOT regexp_matches(gt, '^[ACGT]{2}$') THEN 'not_biallelic_snv'
        WHEN ref IS NULL THEN 'missing_reference'
        WHEN a = ref AND b = ref THEN 'hom_ref'
        WHEN a = ref OR b = ref THEN 'called_alt'
        WHEN a <> b AND (arc = ref OR brc = ref) THEN 'called_alt'
        WHEN a = b AND ${emitHomAlt ? "TRUE" : "FALSE"} THEN 'called_alt'
        WHEN a = b THEN 'hom_alt_skipped' ELSE 'reference_mismatch' END AS status
    FROM oriented`);
    const evaluated = rows(await conn.query("SELECT * FROM chip_conversion_qc ORDER BY chrom, pos, marker"));
    const records = evaluated.filter((r) => r.status === "called_alt" && r.ref !== r.alt && /^[ACGT]$/.test(r.ref));
    const vcf = ["##fileformat=VCFv4.2", "##source=DuckGeneSnap", "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">",
      `#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t${sample}`,
      ...records.map((r) => `${r.resolved}\t${r.pos}\t${r.marker}\t${r.ref}\t${r.alt}\t.\tPASS\t.\tGT\t${r.vcf_gt}`)].join("\n") + "\n";
    const fields = ["marker", "chrom", "pos", "gt", "resolved", "ref", "alt", "vcf_gt", "orientation", "status"];
    const qc = fields.join("\t") + "\n" + evaluated.map((r) => fields.map((f) => r[f]).join("\t")).join("\n") + "\n";
    return { vcf: new Blob([vcf], { type: "text/vcf" }), qc: new Blob([qc], { type: "text/tab-separated-values" }),
      staged: calls.length, written: records.length };
  } finally { ref.revoke(); refIndex.revoke(); bed.revoke(); }
}
