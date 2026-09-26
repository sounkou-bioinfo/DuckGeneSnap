import { quote, rows } from "./db.js";

const risk = `coalesce(gi.risk_level, CASE a.significance
  WHEN 'pathogenic' THEN 'high_risk' WHEN 'likely_pathogenic' THEN 'increased_risk'
  WHEN 'drug_response' THEN 'drug_response' WHEN 'risk_factor' THEN 'increased_risk'
  ELSE 'annotation_match' END)`;
const interpretation = `coalesce(gi.interpretation, CASE
  WHEN a.significance = 'conflicting' THEN 'Input genotype matched a ClinVar locus with conflicting classifications. Do not treat this as pathogenic without clinical review.'
  WHEN a.significance IN ('pathogenic', 'likely_pathogenic') THEN 'Input genotype matched a ClinVar pathogenicity locus. This is not medical advice; confirm with clinical-grade testing.'
  WHEN a.significance = 'drug_response' THEN 'Input genotype matched a ClinVar drug-response locus. Discuss medication relevance with a qualified clinician or pharmacist.'
  ELSE 'Input genotype matched this annotation locus. No genotype-specific interpretation is available.' END)`;

export async function matchLoci(conn, { kind, build }) {
  const chip = kind === "chip";
  const source = chip ? "user_snps s" : "user_variant_keyed s";
  const keyJoin = chip ? "" : `LEFT JOIN variant_keys vk_exact ON vk_exact.annotation_id = a.annotation_id AND vk_exact.build = a.build AND vk_exact.variant_key = s.variant_key
    LEFT JOIN (SELECT DISTINCT annotation_id, build FROM variant_keys) vk_any ON vk_any.annotation_id = a.annotation_id AND vk_any.build = a.build`;
  const keyWhere = chip ? "" : "WHERE vk_any.annotation_id IS NULL OR vk_exact.annotation_id IS NOT NULL";
  await conn.query(`CREATE OR REPLACE TABLE analysis_matches AS SELECT
    ${quote(chip ? "23andMe" : "VCF/BCF")}::VARCHAR AS input_kind,
    ${chip ? "s.marker_id" : "NULL::VARCHAR"} AS marker_id, a.annotation_id, a.source_id,
    ${chip ? "s.chrom" : "s.input_chrom"} AS input_chrom,
    ${chip ? "s.pos" : "s.input_pos"} AS input_pos,
    ${chip ? "NULL::VARCHAR" : "s.sample_id"} AS sample_id,
    ${chip ? "s.genotype" : "s.input_genotype"} AS input_genotype, s.genotype_norm,
    ${chip ? "vk.variant_key, vk.variant_key_hex" : "s.variant_key, s.variant_key_hex"},
    a.build, a.gene, a.category, a.name, a.significance, a.description,
    a.risk_allele, a.normal_allele, a.source, a.publications, a.external_ids,
    a.clinvar_stars, a.odds_ratio, a.score, ${risk} AS risk_level,
    ${interpretation} AS interpretation
    FROM ${source} JOIN variant_annotations a ON a.build = ${quote(build)} AND a.chrom_norm = s.chrom_norm AND a.pos = s.pos
    LEFT JOIN genotype_interpretations gi ON gi.annotation_id = a.annotation_id AND gi.genotype_norm = s.genotype_norm
    ${chip ? "LEFT JOIN variant_keys vk ON vk.annotation_id = a.annotation_id AND vk.is_primary_key" : keyJoin}
    ${keyWhere}`);
  return rows(await conn.query("SELECT count(*) AS n FROM analysis_matches"))[0].n;
}

const columns = new Set(["category", "risk_level", "source", "significance", "build"]);
export function resultQuery(filters = {}) {
  const parts = [];
  for (const key of columns) {
    if (filters[key]) parts.push(`${key} = ${quote(filters[key])}`);
  }
  if (filters.gene) parts.push(`contains(lower(coalesce(gene, '')), lower(${quote(filters.gene)}))`);
  if (filters.minStars !== "" && filters.minStars !== undefined) {
    const stars = Number(filters.minStars);
    if (!Number.isInteger(stars) || stars < 0 || stars > 4) throw new Error("Invalid review-star filter.");
    parts.push(`source = 'clinvar' AND coalesce(clinvar_stars, 0) >= ${stars}`);
  }
  if (filters.search) {
    const term = `lower(${quote(filters.search)})`;
    parts.push(`(${["gene", "source_id", "annotation_id", "name", "significance", "category", "source", "input_genotype", "genotype_norm", "description"]
      .map((column) => `contains(lower(coalesce(${column}, '')), ${term})`).join(" OR ")})`);
  }
  return `FROM analysis_matches ${parts.length ? "WHERE " + parts.join(" AND ") : ""}`;
}

export async function pageMatches(conn, filters = {}, limit = 25, offset = 0) {
  const from = resultQuery(filters);
  const total = rows(await conn.query(`SELECT count(*) AS n ${from}`))[0].n;
  const data = rows(await conn.query(`SELECT * ${from} ORDER BY CASE risk_level WHEN 'high_risk' THEN 0 WHEN 'increased_risk' THEN 1 WHEN 'carrier' THEN 2 WHEN 'drug_response' THEN 3 ELSE 4 END,
    score DESC NULLS LAST, gene, annotation_id LIMIT ${Math.max(1, Math.min(100, limit | 0))} OFFSET ${Math.max(0, offset | 0)}`));
  return { total, rows: data };
}
