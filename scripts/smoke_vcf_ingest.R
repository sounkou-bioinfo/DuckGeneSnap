#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(Rduckhts)
})

args <- commandArgs(trailingOnly = FALSE)
file_arg <- args[startsWith(args, "--file=")][1]
if (!is.na(file_arg)) {
  script_path <- sub("^--file=", "", file_arg)
  repo <- normalizePath(file.path(dirname(script_path), ".."), mustWork = TRUE)
} else {
  repo <- normalizePath(getwd(), mustWork = TRUE)
}

con <- dbConnect(duckdb::duckdb(config = list(allow_unsigned_extensions = "true")))
on.exit(dbDisconnect(con, shutdown = TRUE), add = TRUE)
invisible(Rduckhts::rduckhts_load(con))

ann_path <- file.path(repo, "public/data/variant_annotations.parquet")
fixture <- file.path(repo, "public/demo/example_deepvariant_grch37.vcf.gz")

invisible(DBI::dbExecute(con, sprintf(
  "CREATE OR REPLACE VIEW variant_annotations AS SELECT * FROM read_parquet(%s)",
  DBI::dbQuoteString(con, ann_path)
)))
Rduckhts::rduckhts_bcf(
  con,
  "user_variants_raw",
  fixture,
  tidy_format = TRUE,
  overwrite = TRUE
)

schema <- DBI::dbGetQuery(con, "DESCRIBE user_variants_raw")
stopifnot("FORMAT_GT" %in% schema$column_name)
stopifnot("ALT" %in% schema$column_name)

invisible(DBI::dbExecute(con, "
CREATE OR REPLACE TABLE user_variant_keyed AS
WITH source_rows AS (
  SELECT
    coalesce(FORMAT_GT, '')::VARCHAR AS gt,
    CHROM::VARCHAR AS chrom,
    POS::BIGINT AS pos,
    REF::VARCHAR AS ref,
    ALT[1]::VARCHAR AS alt,
    coalesce(array_length(ALT), 0) AS alt_count
  FROM user_variants_raw
), filtered AS (
  SELECT *
  FROM source_rows
  WHERE alt_count = 1
    AND chrom IS NOT NULL
    AND pos IS NOT NULL
    AND ref IS NOT NULL
    AND alt IS NOT NULL
    AND regexp_matches(upper(ref), '^[ACGT]+$')
    AND regexp_matches(upper(alt), '^[ACGT]+$')
    AND coalesce(regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'), false)
), gt_parts AS (
  SELECT
    *,
    regexp_extract(gt, '^([0-9.]+)', 1) AS gt_a,
    regexp_extract(gt, '^[0-9.]+[/|]([0-9.]+)', 1) AS gt_b
  FROM filtered
), allele_calls AS (
  SELECT
    *,
    CASE gt_a WHEN '0' THEN ref WHEN '1' THEN alt ELSE NULL END AS allele_a,
    CASE gt_b WHEN '0' THEN ref WHEN '1' THEN alt ELSE NULL END AS allele_b
  FROM gt_parts
)
SELECT
  chrom,
  CASE
    WHEN upper(
      CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4)
      ELSE chrom END
    ) IN ('M', 'MT') THEN 'MT'
    ELSE upper(
      CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4)
      ELSE chrom END
    )
  END AS chrom_norm,
  pos,
  ref,
  alt,
  gt AS input_genotype,
  CASE
    WHEN allele_a IS NOT NULL
      AND allele_b IS NOT NULL
      AND length(allele_a) = 1
      AND length(allele_b) = 1
    THEN least(upper(allele_a), upper(allele_b)) ||
      greatest(upper(allele_a), upper(allele_b))
    ELSE coalesce(gt, '')
  END AS genotype_norm,
  variantkey(chrom, pos, ref, alt) AS variant_key,
  variantkey_hex(variantkey(chrom, pos, ref, alt)) AS variant_key_hex
FROM allele_calls
"))

invisible(DBI::dbExecute(con, "
CREATE OR REPLACE TABLE analysis_matches AS
SELECT a.annotation_id, a.source, a.source_id, k.input_genotype, k.genotype_norm
FROM user_variant_keyed k
JOIN variant_annotations a
  ON a.build = 'GRCh37'
 AND a.chrom_norm = k.chrom_norm
 AND a.pos = k.pos
"))

counts <- DBI::dbGetQuery(con, "
SELECT
  (SELECT count(*) FROM user_variants_raw)::BIGINT AS raw_records,
  (SELECT count(*) FROM user_variant_keyed)::BIGINT AS keyed_records,
  (SELECT count(*) FROM analysis_matches)::BIGINT AS matched_records
")
stopifnot(counts$raw_records == 6L)
stopifnot(counts$keyed_records == 2L)
stopifnot(counts$matched_records >= 2L)
cat("DeepVariant-style VCF.GZ smoke test passed\n")
