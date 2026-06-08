#!/usr/bin/env Rscript
# Build DuckGeneSnap static annotation assets.
#
# Matching is locus-first: genome build + normalized chromosome + 1-based
# position. rsIDs are retained only as source/display metadata. The main
# artifact is a compressed DuckDB database that the static site can stage into
# the browser filesystem and ATTACH read-only. Parquet sidecars are emitted for
# inspection and fallback.

options(warn = 1)

if (!requireNamespace("optparse", quietly = TRUE)) {
  stop(
    paste(
      "The optparse package is required.",
      "Install it with install.packages('optparse')."
    ),
    call. = FALSE
  )
}

make_opt <- optparse::make_option

option_list <- list(
  make_opt(
    c("--repo-root"),
    default = NULL,
    metavar = "DIR",
    help = paste(
      "Repository root.",
      "Defaults to the parent of this script."
    )
  ),
  make_opt(
    c("--seed-dir"),
    default = NULL,
    metavar = "DIR",
    help = "Seed TSV directory [default: <repo-root>/data/seed]."
  ),
  make_opt(
    c("--out-dir"),
    default = NULL,
    metavar = "DIR",
    help = "Output asset directory [default: <repo-root>/public/data]."
  ),
  make_opt(
    c("--duckdb-file"),
    default = "duckgenesnap.duckdb",
    metavar = "NAME",
    help = "Output DuckDB database filename [default: %default]."
  ),
  make_opt(
    c("--skip-seed"),
    action = "store_true",
    default = FALSE,
    help = "Do not load demo seed TSV annotations."
  ),
  make_opt(
    c("--clinvar-grch37-bcf"),
    default = NULL,
    metavar = "PATH",
    help = "Optional ClinVar GRCh37/hg19 VCF/BCF to inject."
  ),
  make_opt(
    c("--clinvar-grch38-bcf"),
    default = NULL,
    metavar = "PATH",
    help = "Optional ClinVar GRCh38/hg38 VCF/BCF to inject."
  ),
  make_opt(
    c("--clinvar-row-limit"),
    type = "integer",
    default = 0,
    metavar = "N",
    help = paste(
      "Limit ClinVar rows per build for size tests.",
      "Use 0 for no limit [default: %default]."
    )
  ),
  make_opt(
    c("--gwas-tsv"),
    default = NULL,
    metavar = "PATH",
    help = "Optional GWAS Catalog associations TSV to inject."
  ),
  make_opt(
    c("--gwas-zip"),
    default = NULL,
    metavar = "PATH",
    help = paste(
      "Optional GWAS Catalog ZIP.",
      "The first .tsv member is extracted."
    )
  ),
  make_opt(
    c("--gwas-build"),
    default = "GRCh38",
    metavar = "BUILD",
    help = paste(
      "Build label for GWAS CHR_ID/CHR_POS coordinates",
      "[default: %default]."
    )
  ),
  make_opt(
    c("--gwas-pvalue-threshold"),
    type = "double",
    default = 5e-8,
    metavar = "P",
    help = "GWAS p-value cutoff [default: %default]."
  ),
  make_opt(
    c("--gwas-row-limit"),
    type = "integer",
    default = 0,
    metavar = "N",
    help = paste(
      "Limit GWAS rows after filtering for size tests.",
      "Use 0 for no limit [default: %default]."
    )
  ),
  make_opt(
    c("--pharmgkb-tsv"),
    default = NULL,
    metavar = "PATH",
    help = paste(
      "Optional PharmGKB TSV.",
      "Coordinate-bearing rows are injected by locus."
    )
  ),
  make_opt(
    c("--pharmgkb-build"),
    default = "GRCh38",
    metavar = "BUILD",
    help = paste(
      "Build label for coordinate-bearing PharmGKB rows",
      "[default: %default]."
    )
  ),
  make_opt(
    c("--skip-parquet"),
    action = "store_true",
    default = FALSE,
    help = "Skip Parquet sidecar emission."
  ),
  make_opt(
    c("--parquet-row-group-size"),
    type = "integer",
    default = 50000,
    metavar = "N",
    help = paste(
      "Parquet ROW_GROUP_SIZE for sorted sidecars.",
      "Smaller groups improve locus pruning but add metadata",
      "[default: %default]."
    )
  ),
  make_opt(
    c("--parquet-compression-level"),
    type = "integer",
    default = 22,
    metavar = "N",
    help = paste(
      "ZSTD compression level for Parquet sidecars.",
      "Use 22 for smallest static assets [default: %default]."
    )
  ),
  make_opt(
    c("--skip-indexes"),
    action = "store_true",
    default = FALSE,
    help = "Skip persistent DuckDB indexes for size experiments."
  ),
  make_opt(
    c("--size-report"),
    default = NULL,
    metavar = "PATH",
    help = "Write size report TSV [default: <out-dir>/size_report.tsv]."
  )
)

parser <- optparse::OptionParser(
  usage = "%prog [options]",
  description = "Build DuckGeneSnap DuckDB/Parquet annotation assets.",
  option_list = option_list
)
opts <- optparse::parse_args(parser)

`%||%` <- function(x, y) {
  if (is.null(x) || length(x) == 0 || is.na(x)) y else x
}

opt <- function(name) {
  hyphen_name <- gsub("_", "-", name, fixed = TRUE)
  opts[[name]] %||% opts[[hyphen_name]]
}

script_path <- NULL
file_arg <- grep(
  "^--file=",
  commandArgs(trailingOnly = FALSE),
  value = TRUE
)
if (length(file_arg)) {
  script_path <- normalizePath(
    sub("^--file=", "", file_arg[[1]]),
    mustWork = TRUE
  )
}

repo_root <- if (!is.null(opt("repo_root"))) {
  normalizePath(opt("repo_root"), mustWork = TRUE)
} else if (!is.null(script_path)) {
  normalizePath(file.path(dirname(script_path), ".."), mustWork = TRUE)
} else {
  normalizePath(getwd(), mustWork = TRUE)
}

seed_dir <- normalizePath(
  opt("seed_dir") %||% file.path(repo_root, "data", "seed"),
  mustWork = FALSE
)
out_dir <- normalizePath(
  opt("out_dir") %||% file.path(repo_root, "public", "data"),
  mustWork = FALSE
)
size_report_path <- normalizePath(
  opt("size_report") %||% file.path(out_dir, "size_report.tsv"),
  mustWork = FALSE
)

dir.create(seed_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

parquet_row_group_size <- as.integer(opt("parquet_row_group_size"))
if (is.na(parquet_row_group_size) || parquet_row_group_size < 1) {
  stop("--parquet-row-group-size must be a positive integer", call. = FALSE)
}
parquet_compression_level <- as.integer(opt("parquet_compression_level"))
if (
  is.na(parquet_compression_level) ||
    parquet_compression_level < 1 ||
    parquet_compression_level > 22
) {
  stop("--parquet-compression-level must be between 1 and 22", call. = FALSE)
}

db_path <- file.path(out_dir, opt("duckdb_file"))
unlink(
  c(
    db_path,
    paste0(db_path, ".wal"),
    file.path(out_dir, "variants.parquet")
  ),
  force = TRUE
)

required_packages <- c("DBI", "duckdb", "Rduckhts", "jsonlite")
missing_packages <- required_packages[
  !vapply(
    required_packages,
    requireNamespace,
    logical(1),
    quietly = TRUE
  )
]
if (length(missing_packages)) {
  stop(
    "Missing required R packages: ",
    paste(missing_packages, collapse = ", "),
    call. = FALSE
  )
}

sql <- function(...) {
  paste(..., sep = "\n")
}

sql_quote_string <- function(x) {
  paste0("'", gsub("'", "''", x, fixed = TRUE), "'")
}

sql_quote_ident <- function(x) {
  paste0('"', gsub('"', '""', x, fixed = TRUE), '"')
}

exec <- function(statement) {
  invisible(DBI::dbExecute(con, statement))
}

path_arg <- function(x) {
  if (is.null(x) || is.na(x) || !nzchar(x)) {
    return(NULL)
  }
  normalizePath(x, mustWork = TRUE)
}

read_seed <- function(path) {
  utils::read.delim(
    path,
    sep = "\t",
    quote = "",
    comment.char = "",
    stringsAsFactors = FALSE,
    check.names = FALSE,
    na.strings = c("")
  )
}

normalize_genotype <- function(x) {
  vapply(
    strsplit(toupper(x), "", fixed = TRUE),
    function(chars) {
      if (length(chars) == 2 && all(chars %in% c("A", "C", "G", "T"))) {
        paste(sort(chars), collapse = "")
      } else {
        paste(chars, collapse = "")
      }
    },
    character(1)
  )
}

chrom_norm_expr <- function(chrom_sql) {
  no_prefix <- sql(
    "CASE",
    sprintf("  WHEN starts_with(lower(%s), 'chr')", chrom_sql),
    sprintf("  THEN substr(%s, 4)", chrom_sql),
    sprintf("  ELSE %s", chrom_sql),
    "END"
  )
  sql(
    "CASE",
    sprintf("  WHEN upper(%s) IN ('M', 'MT') THEN 'MT'", no_prefix),
    sprintf("  ELSE upper(%s)", no_prefix),
    "END"
  )
}

score_case <- function(significance_sql) {
  sql(
    "CASE",
    sprintf("  WHEN %s = 'pathogenic' THEN 10", significance_sql),
    sprintf("  WHEN %s = 'likely_pathogenic' THEN 8", significance_sql),
    sprintf("  WHEN %s = 'risk_factor' THEN 5", significance_sql),
    sprintf("  WHEN %s = 'drug_response' THEN 4", significance_sql),
    sprintf("  WHEN %s = 'association' THEN 2", significance_sql),
    "  ELSE 1",
    "END"
  )
}

count_annotations <- function(source, build = NULL) {
  where <- sprintf("source = %s", sql_quote_string(source))
  if (!is.null(build)) {
    where <- paste(where, "AND build =", sql_quote_string(build))
  }
  query <- sql(
    "SELECT count(*) AS n",
    "FROM variant_annotations",
    sprintf("WHERE %s", where)
  )
  DBI::dbGetQuery(con, query)$n[[1]]
}

rows_to_lists <- function(data) {
  lapply(seq_len(nrow(data)), function(i) {
    as.list(data[i, , drop = FALSE])
  })
}

rel_path <- function(path, root) {
  if (startsWith(path, root)) {
    substring(path, nchar(root) + 2)
  } else {
    path
  }
}

con <- DBI::dbConnect(
  duckdb::duckdb(
    db_path,
    config = list(allow_unsigned_extensions = "true")
  )
)
on.exit(
  try(DBI::dbDisconnect(con, shutdown = TRUE), silent = TRUE),
  add = TRUE
)
Rduckhts::rduckhts_load(con)

exec(sql(
  "CREATE TABLE variant_annotations (",
  "  annotation_id VARCHAR,",
  "  source VARCHAR,",
  "  source_id VARCHAR,",
  "  build VARCHAR,",
  "  chrom VARCHAR,",
  "  chrom_norm VARCHAR,",
  "  pos BIGINT,",
  "  gene VARCHAR,",
  "  category VARCHAR,",
  "  name VARCHAR,",
  "  significance VARCHAR,",
  "  description VARCHAR,",
  "  risk_allele VARCHAR,",
  "  normal_allele VARCHAR,",
  "  external_ids VARCHAR,",
  "  publications VARCHAR,",
  "  clinvar_stars INTEGER,",
  "  odds_ratio DOUBLE,",
  "  score DOUBLE,",
  "  source_payload VARCHAR",
  ")"
))

exec(sql(
  "CREATE TABLE genotype_interpretations (",
  "  annotation_id VARCHAR,",
  "  source_id VARCHAR,",
  "  genotype VARCHAR,",
  "  genotype_norm VARCHAR,",
  "  interpretation VARCHAR,",
  "  risk_level VARCHAR",
  ")"
))

load_seed_annotations <- function() {
  variants_path <- file.path(seed_dir, "curated_variants.tsv")
  interpretations_path <- file.path(seed_dir, "genotype_interpretations.tsv")
  if (!file.exists(variants_path)) {
    stop("Missing ", variants_path, call. = FALSE)
  }
  if (!file.exists(interpretations_path)) {
    stop("Missing ", interpretations_path, call. = FALSE)
  }

  variants <- read_seed(variants_path)
  interpretations <- read_seed(interpretations_path)

  variants$pos <- as.integer(variants$pos)
  variants$clinvar_stars <- as.integer(variants$clinvar_stars)
  variants$odds_ratio <- suppressWarnings(as.numeric(variants$odds_ratio))
  variants$build <- ifelse(
    is.na(variants$build) | variants$build == "",
    "GRCh37",
    variants$build
  )
  variants$chrom <- as.character(variants$chrom)
  variants$risk_allele <- toupper(variants$risk_allele)
  variants$normal_allele <- toupper(variants$normal_allele)

  interpretations$genotype <- toupper(interpretations$genotype)
  interpretations$genotype_norm <- normalize_genotype(
    interpretations$genotype
  )

  DBI::dbWriteTable(con, "seed_variants", variants, overwrite = TRUE)
  DBI::dbWriteTable(
    con,
    "seed_interpretations",
    interpretations,
    overwrite = TRUE
  )

  seed_chrom_norm <- chrom_norm_expr("chrom")
  seed_score <- score_case("significance")
  seed_sql <- sql(
    "INSERT INTO variant_annotations",
    "SELECT",
    "  (",
    "    'seed:' || build || ':' ||",
    "    (%s) || ':' || pos::VARCHAR || ':' || rsid",
    "  )::VARCHAR AS annotation_id,",
    "  'seed'::VARCHAR AS source,",
    "  rsid::VARCHAR AS source_id,",
    "  build::VARCHAR AS build,",
    "  chrom::VARCHAR AS chrom,",
    "  (%s)::VARCHAR AS chrom_norm,",
    "  pos::BIGINT AS pos,",
    "  gene::VARCHAR AS gene,",
    "  category::VARCHAR AS category,",
    "  name::VARCHAR AS name,",
    "  significance::VARCHAR AS significance,",
    "  description::VARCHAR AS description,",
    "  risk_allele::VARCHAR AS risk_allele,",
    "  normal_allele::VARCHAR AS normal_allele,",
    "  external_ids::VARCHAR AS external_ids,",
    "  publications::VARCHAR AS publications,",
    "  coalesce(clinvar_stars, 0)::INTEGER AS clinvar_stars,",
    "  odds_ratio::DOUBLE AS odds_ratio,",
    "  round((%s) * (1 + coalesce(clinvar_stars, 0)) *",
    "    greatest(coalesce(odds_ratio, 1.0), 1.0), 1) AS score,",
    "  NULL::VARCHAR AS source_payload",
    "FROM seed_variants",
    "WHERE chrom IS NOT NULL AND pos IS NOT NULL"
  )
  exec(sprintf(seed_sql, seed_chrom_norm, seed_chrom_norm, seed_score))

  exec(sql(
    "INSERT INTO genotype_interpretations",
    "SELECT",
    "  a.annotation_id,",
    "  i.rsid::VARCHAR AS source_id,",
    "  i.genotype::VARCHAR AS genotype,",
    "  i.genotype_norm::VARCHAR AS genotype_norm,",
    "  i.interpretation::VARCHAR AS interpretation,",
    "  i.risk_level::VARCHAR AS risk_level",
    "FROM seed_interpretations i",
    "JOIN variant_annotations a",
    "  ON a.source = 'seed'",
    " AND a.source_id = i.rsid"
  ))

  count_annotations("seed")
}

load_clinvar <- function(path, build_label, row_limit = 0L) {
  if (is.null(path)) {
    return(0L)
  }
  path <- path_arg(path)
  message("Injecting ClinVar ", build_label, " from ", path)

  view_name <- paste0(
    "clinvar_raw_",
    gsub("[^A-Za-z0-9_]", "_", tolower(build_label))
  )
  exec(sql(
    sprintf("CREATE OR REPLACE TEMP VIEW %s AS", view_name),
    sprintf("SELECT * FROM read_bcf(%s)", sql_quote_string(path))
  ))

  limit_sql <- ""
  if (!is.null(row_limit) && row_limit > 0) {
    limit_sql <- sprintf("LIMIT %d", row_limit)
  }
  cn <- chrom_norm_expr("c.CHROM")
  build_sql <- sql_quote_string(build_label)

  clinvar_sql <- sql(
    "INSERT INTO variant_annotations",
    "WITH expanded AS (",
    "  SELECT",
    "    c.*,",
    "    u.alt::VARCHAR AS alt_allele,",
    "    array_to_string(c.INFO_CLNSIG, '|') AS clnsig_text,",
    "    array_to_string(c.INFO_CLNREVSTAT, '|') AS clnrevstat_text,",
    "    array_to_string(c.INFO_CLNDN, '|') AS clndn_text,",
    "    array_to_string(c.INFO_RS, '|') AS rs_text,",
    "    regexp_extract(c.INFO_GENEINFO, '^([^:;]+)', 1) AS gene_symbol,",
    "    (%s) AS chrom_norm_value",
    sprintf("  FROM %s c", view_name),
    "  LEFT JOIN LATERAL UNNEST(c.ALT) AS u(alt) ON TRUE",
    ")",
    "SELECT",
    "  (",
    "    'clinvar:' || %s || ':' || chrom_norm_value || ':' ||",
    "    POS::VARCHAR || ':' ||",
    "    coalesce(INFO_ALLELEID::VARCHAR, ID, REF || '>' ||",
    "      coalesce(alt_allele, ''))",
    "  )::VARCHAR AS annotation_id,",
    "  'clinvar'::VARCHAR AS source,",
    "  coalesce(NULLIF(rs_text, ''), ID, INFO_ALLELEID::VARCHAR)",
    "    ::VARCHAR AS source_id,",
    "  %s::VARCHAR AS build,",
    "  CHROM::VARCHAR AS chrom,",
    "  chrom_norm_value::VARCHAR AS chrom_norm,",
    "  POS::BIGINT AS pos,",
    "  NULLIF(gene_symbol, '')::VARCHAR AS gene,",
    "  'health_risk'::VARCHAR AS category,",
    "  (",
    "    'ClinVar ' || coalesce(NULLIF(clnsig_text, ''),",
    "      'clinical variant') ||",
    "    coalesce(' - ' || NULLIF(gene_symbol, ''), '')",
    "  )::VARCHAR AS name,",
    "  CASE",
    "    WHEN contains(lower(coalesce(clnsig_text, '')), 'likely')",
    "    THEN 'likely_pathogenic'",
    "    ELSE 'pathogenic'",
    "  END::VARCHAR AS significance,",
    "  (",
    "    'ClinVar ' || coalesce(clnsig_text, '') || '; ' ||",
    "    coalesce(clndn_text, '') || '; review=' ||",
    "    coalesce(clnrevstat_text, '')",
    "  )::VARCHAR AS description,",
    "  alt_allele::VARCHAR AS risk_allele,",
    "  REF::VARCHAR AS normal_allele,",
    "  (",
    "    '{\"alleleid\":' || coalesce(INFO_ALLELEID::VARCHAR, 'null') ||",
    "    ',\"id\":\"' || coalesce(ID, '') || '\"}'",
    "  )::VARCHAR AS external_ids,",
    "  NULL::VARCHAR AS publications,",
    "  CASE",
    "    WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "      'practice_guideline') THEN 4",
    "    WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "      'reviewed_by_expert_panel') THEN 4",
    "    WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "      'criteria_provided') THEN 1",
    "    ELSE 0",
    "  END::INTEGER AS clinvar_stars,",
    "  NULL::DOUBLE AS odds_ratio,",
    "  (",
    "    CASE",
    "      WHEN contains(lower(coalesce(clnsig_text, '')), 'likely')",
    "      THEN 8 ELSE 10",
    "    END::DOUBLE *",
    "    (1 + CASE",
    "      WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "        'practice_guideline') THEN 4",
    "      WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "        'reviewed_by_expert_panel') THEN 4",
    "      WHEN contains(lower(coalesce(clnrevstat_text, '')),",
    "        'criteria_provided') THEN 1",
    "      ELSE 0",
    "    END)::DOUBLE",
    "  ) AS score,",
    "  (",
    "    'clnsig=' || coalesce(clnsig_text, '') ||",
    "    ';clnrevstat=' || coalesce(clnrevstat_text, '') ||",
    "    ';clndn=' || coalesce(clndn_text, '')",
    "  )::VARCHAR AS source_payload",
    "FROM expanded",
    "WHERE CHROM IS NOT NULL AND POS IS NOT NULL",
    "%s"
  )
  exec(sprintf(clinvar_sql, cn, build_sql, build_sql, limit_sql))
  count_annotations("clinvar", build_label)
}

resolve_gwas_tsv <- function() {
  if (!is.null(opt("gwas_tsv")) && nzchar(opt("gwas_tsv"))) {
    return(path_arg(opt("gwas_tsv")))
  }
  if (is.null(opt("gwas_zip")) || !nzchar(opt("gwas_zip"))) {
    return(NULL)
  }

  zip_path <- path_arg(opt("gwas_zip"))
  listing <- utils::unzip(zip_path, list = TRUE)
  tsv_name <- listing$Name[
    grepl("\\.tsv$", listing$Name, ignore.case = TRUE)
  ][1]
  if (is.na(tsv_name)) {
    stop("No .tsv member found in ", zip_path, call. = FALSE)
  }

  extract_dir <- file.path(
    tempdir(),
    paste0("duckgenesnap_gwas_", Sys.getpid())
  )
  dir.create(extract_dir, recursive = TRUE, showWarnings = FALSE)
  utils::unzip(
    zip_path,
    files = tsv_name,
    exdir = extract_dir,
    overwrite = TRUE
  )
  file.path(extract_dir, tsv_name)
}

load_gwas <- function(
  path,
  build_label,
  p_threshold = 5e-8,
  row_limit = 0L
) {
  if (is.null(path)) {
    return(0L)
  }
  path <- path_arg(path)
  message("Injecting GWAS Catalog ", build_label, " from ", path)

  exec(sql(
    "CREATE OR REPLACE TEMP VIEW gwas_raw AS",
    sprintf(
      "SELECT * FROM read_csv(%s, delim='\\t', header=true,",
      sql_quote_string(path)
    ),
    "  all_varchar=true, ignore_errors=true)"
  ))

  limit_sql <- ""
  if (!is.null(row_limit) && row_limit > 0) {
    limit_sql <- sprintf("LIMIT %d", row_limit)
  }
  cn <- chrom_norm_expr('"CHR_ID"')
  build_sql <- sql_quote_string(build_label)

  gwas_sql <- sql(
    "INSERT INTO variant_annotations",
    "WITH filtered AS (",
    "  SELECT",
    "    *,",
    "    (%s) AS chrom_norm_value,",
    "    try_cast(\"CHR_POS\" AS BIGINT) AS pos_value,",
    "    try_cast(\"P-VALUE\" AS DOUBLE) AS p_value,",
    "    try_cast(\"OR or BETA\" AS DOUBLE) AS effect_value,",
    "    upper(regexp_extract(",
    "      \"STRONGEST SNP-RISK ALLELE\",",
    "      '-([ACGT])$',",
    "      1",
    "    )) AS parsed_risk_allele",
    "  FROM gwas_raw",
    "  WHERE try_cast(\"CHR_POS\" AS BIGINT) IS NOT NULL",
    "    AND regexp_matches(",
    "      coalesce(\"CHR_ID\", ''),",
    "      '^(chr)?([0-9]{1,2}|X|Y|M|MT)$'",
    "    )",
    "    AND try_cast(\"P-VALUE\" AS DOUBLE) <= %.17g",
    "    AND coalesce(\"CNV\", 'N') <> 'Y'",
    "),",
    "chosen AS (",
    "  SELECT *",
    "  FROM filtered",
    "  ORDER BY p_value ASC NULLS LAST",
    "  %s",
    ")",
    "SELECT",
    "  (",
    "    'gwas_catalog:' || %s || ':' || chrom_norm_value ||",
    "    ':' || pos_value::VARCHAR || ':' ||",
    "    coalesce(NULLIF(\"SNPS\", ''),",
    "      NULLIF(\"SNP_ID_CURRENT\", ''), 'unknown')",
    "  )::VARCHAR AS annotation_id,",
    "  'gwas_catalog'::VARCHAR AS source,",
    "  coalesce(NULLIF(\"SNPS\", ''), NULLIF(\"SNP_ID_CURRENT\", ''))",
    "    ::VARCHAR AS source_id,",
    "  %s::VARCHAR AS build,",
    "  \"CHR_ID\"::VARCHAR AS chrom,",
    "  chrom_norm_value::VARCHAR AS chrom_norm,",
    "  pos_value::BIGINT AS pos,",
    "  coalesce(",
    "    NULLIF(\"MAPPED_GENE\", ''),",
    "    NULLIF(\"REPORTED GENE(S)\", '')",
    "  )::VARCHAR AS gene,",
    "  'trait'::VARCHAR AS category,",
    "  coalesce(NULLIF(\"DISEASE/TRAIT\", ''),",
    "    'GWAS Catalog association')::VARCHAR AS name,",
    "  'association'::VARCHAR AS significance,",
    "  (",
    "    'GWAS Catalog association: ' ||",
    "    coalesce(\"DISEASE/TRAIT\", '') || '; p=' ||",
    "    coalesce(\"P-VALUE\", '') || '; effect=' ||",
    "    coalesce(\"OR or BETA\", '') || '; study=' ||",
    "    coalesce(\"STUDY\", '')",
    "  )::VARCHAR AS description,",
    "  NULLIF(parsed_risk_allele, '')::VARCHAR AS risk_allele,",
    "  NULL::VARCHAR AS normal_allele,",
    "  (",
    "    '{\"pubmed\":\"' || coalesce(\"PUBMEDID\", '') ||",
    "    '\",\"link\":\"' || coalesce(\"LINK\", '') || '\"}'",
    "  )::VARCHAR AS external_ids,",
    "  NULLIF(\"PUBMEDID\", '')::VARCHAR AS publications,",
    "  0::INTEGER AS clinvar_stars,",
    "  effect_value::DOUBLE AS odds_ratio,",
    "  2.0::DOUBLE * greatest(coalesce(effect_value, 1.0), 1.0)",
    "    AS score,",
    "  (",
    "    'p=' || coalesce(\"P-VALUE\", '') || ';pmid=' ||",
    "    coalesce(\"PUBMEDID\", '') || ';risk_allele=' ||",
    "    coalesce(\"STRONGEST SNP-RISK ALLELE\", '')",
    "  )::VARCHAR AS source_payload",
    "FROM chosen"
  )
  exec(sprintf(gwas_sql, cn, p_threshold, limit_sql, build_sql, build_sql))
  count_annotations("gwas_catalog", build_label)
}

load_pharmgkb <- function(path, build_label) {
  if (is.null(path)) {
    return(0L)
  }
  path <- path_arg(path)
  message("Loading PharmGKB from ", path)

  exec(sql(
    "CREATE OR REPLACE TABLE source_pharmgkb_raw AS",
    sprintf(
      "SELECT * FROM read_csv(%s, delim='\\t', header=true,",
      sql_quote_string(path)
    ),
    "  all_varchar=true, ignore_errors=true)"
  ))

  cols <- DBI::dbGetQuery(con, "DESCRIBE source_pharmgkb_raw")$column_name
  lower_cols <- tolower(cols)
  pick <- function(candidates) {
    idx <- match(tolower(candidates), lower_cols)
    idx <- idx[!is.na(idx)]
    if (length(idx)) cols[idx[1]] else NULL
  }

  chrom_col <- pick(c("chrom", "chr", "chromosome", "Chromosome"))
  pos_col <- pick(c("pos", "position", "start", "Position"))
  if (is.null(chrom_col) || is.null(pos_col)) {
    warning(
      paste(
        "PharmGKB TSV has no recognizable coordinate columns;",
        "stored source_pharmgkb_raw only."
      )
    )
    return(0L)
  }

  gene_col <- pick(c("gene", "Gene")) %||% chrom_col
  variant_col <- pick(c("variant", "Variant/Haplotypes", "Variant"))
  variant_col <- variant_col %||% chrom_col
  drug_col <- pick(c("chemicals", "Drug(s)", "drug", "Drug"))
  drug_col <- drug_col %||% chrom_col
  phenotype_col <- pick(c("phenotypes", "Phenotype(s)", "phenotype"))
  phenotype_col <- phenotype_col %||% chrom_col
  level_col <- pick(c("level of evidence", "Level of Evidence", "level"))
  level_col <- level_col %||% chrom_col

  chrom_sql <- sql_quote_ident(chrom_col)
  pos_sql <- sql_quote_ident(pos_col)
  cn <- chrom_norm_expr(chrom_sql)
  build_sql <- sql_quote_string(build_label)

  pharm_sql <- sql(
    "INSERT INTO variant_annotations",
    "WITH filtered AS (",
    "  SELECT",
    "    *,",
    "    (%s) AS chrom_norm_value,",
    "    try_cast(%s AS BIGINT) AS pos_value",
    "  FROM source_pharmgkb_raw",
    "  WHERE try_cast(%s AS BIGINT) IS NOT NULL",
    ")",
    "SELECT",
    "  (",
    "    'pharmgkb:' || %s || ':' || chrom_norm_value || ':' ||",
    "    pos_value::VARCHAR || ':' || coalesce(%s, 'unknown')",
    "  )::VARCHAR AS annotation_id,",
    "  'pharmgkb'::VARCHAR AS source,",
    "  %s::VARCHAR AS source_id,",
    "  %s::VARCHAR AS build,",
    "  %s::VARCHAR AS chrom,",
    "  chrom_norm_value::VARCHAR AS chrom_norm,",
    "  pos_value::BIGINT AS pos,",
    "  %s::VARCHAR AS gene,",
    "  'pharmacogenomics'::VARCHAR AS category,",
    "  ('PharmGKB ' || coalesce(%s, '') ||",
    "    coalesce(' - ' || %s, ''))::VARCHAR AS name,",
    "  'drug_response'::VARCHAR AS significance,",
    "  (",
    "    'PharmGKB annotation: drug=' || coalesce(%s, '') ||",
    "    '; phenotype=' || coalesce(%s, '') ||",
    "    '; level=' || coalesce(%s, '')",
    "  )::VARCHAR AS description,",
    "  NULL::VARCHAR AS risk_allele,",
    "  NULL::VARCHAR AS normal_allele,",
    "  NULL::VARCHAR AS external_ids,",
    "  NULL::VARCHAR AS publications,",
    "  0::INTEGER AS clinvar_stars,",
    "  NULL::DOUBLE AS odds_ratio,",
    "  4.0::DOUBLE AS score,",
    "  (",
    "    'drug=' || coalesce(%s, '') || ';phenotype=' ||",
    "    coalesce(%s, '') || ';level=' || coalesce(%s, '')",
    "  )::VARCHAR AS source_payload",
    "FROM filtered"
  )
  exec(sprintf(
    pharm_sql,
    cn,
    pos_sql,
    pos_sql,
    build_sql,
    sql_quote_ident(variant_col),
    sql_quote_ident(variant_col),
    build_sql,
    chrom_sql,
    sql_quote_ident(gene_col),
    sql_quote_ident(variant_col),
    sql_quote_ident(drug_col),
    sql_quote_ident(drug_col),
    sql_quote_ident(phenotype_col),
    sql_quote_ident(level_col),
    sql_quote_ident(drug_col),
    sql_quote_ident(phenotype_col),
    sql_quote_ident(level_col)
  ))

  count_annotations("pharmgkb", build_label)
}

seed_n <- if (opt("skip_seed")) 0L else load_seed_annotations()
clinvar37_n <- load_clinvar(
  opt("clinvar_grch37_bcf"),
  "GRCh37",
  opt("clinvar_row_limit")
)
clinvar38_n <- load_clinvar(
  opt("clinvar_grch38_bcf"),
  "GRCh38",
  opt("clinvar_row_limit")
)
gwas_n <- load_gwas(
  resolve_gwas_tsv(),
  opt("gwas_build"),
  opt("gwas_pvalue_threshold"),
  opt("gwas_row_limit")
)
pharmgkb_n <- load_pharmgkb(opt("pharmgkb_tsv"), opt("pharmgkb_build"))

message(
  "Injected rows: seed=", seed_n,
  ", clinvar37=", clinvar37_n,
  ", clinvar38=", clinvar38_n,
  ", gwas=", gwas_n,
  ", pharmgkb=", pharmgkb_n
)

exec(sql(
  "CREATE OR REPLACE TABLE variant_keys AS",
  "WITH allele_pairs AS (",
  "  SELECT",
  "    annotation_id,",
  "    source,",
  "    source_id,",
  "    build,",
  "    chrom,",
  "    chrom_norm,",
  "    pos,",
  "    normal_allele AS ref,",
  "    risk_allele AS alt,",
  "    TRUE AS is_primary_key,",
  "    'normal_to_risk' AS key_role",
  "  FROM variant_annotations",
  "  WHERE length(normal_allele) = 1",
  "    AND length(risk_allele) = 1",
  "    AND normal_allele <> risk_allele",
  "  UNION ALL",
  "  SELECT",
  "    annotation_id,",
  "    source,",
  "    source_id,",
  "    build,",
  "    chrom,",
  "    chrom_norm,",
  "    pos,",
  "    risk_allele AS ref,",
  "    normal_allele AS alt,",
  "    FALSE AS is_primary_key,",
  "    'risk_to_normal' AS key_role",
  "  FROM variant_annotations",
  "  WHERE length(normal_allele) = 1",
  "    AND length(risk_allele) = 1",
  "    AND normal_allele <> risk_allele",
  "),",
  "keyed AS (",
  "  SELECT",
  "    *,",
  "    variantkey(chrom, pos, ref, alt) AS variant_key",
  "  FROM allele_pairs",
  ")",
  "SELECT",
  "  annotation_id::VARCHAR AS annotation_id,",
  "  source::VARCHAR AS source,",
  "  source_id::VARCHAR AS source_id,",
  "  build::VARCHAR AS build,",
  "  chrom::VARCHAR AS chrom,",
  "  chrom_norm::VARCHAR AS chrom_norm,",
  "  pos::BIGINT AS pos,",
  "  ref::VARCHAR AS ref,",
  "  alt::VARCHAR AS alt,",
  "  variant_key,",
  "  variantkey_hex(variant_key)::VARCHAR AS variant_key_hex,",
  "  is_primary_key,",
  "  key_role::VARCHAR AS key_role",
  "FROM keyed"
))

index_specs <- data.frame(
  index_name = c(
    "idx_ann_locus",
    "idx_interp_annotation_genotype",
    "idx_vk_variantkey",
    "idx_vk_annotation"
  ),
  table_name = c(
    "variant_annotations",
    "genotype_interpretations",
    "variant_keys",
    "variant_keys"
  ),
  columns = c(
    "build, chrom_norm, pos",
    "annotation_id, genotype_norm",
    "build, variant_key",
    "annotation_id"
  ),
  purpose = c(
    "Batch exact locus joins from uploaded 23andMe/VCF rows.",
    "Genotype-specific interpretation after annotation match.",
    "Optional allele-exact VariantKey lookup and QA.",
    "Detail-panel lookup of auxiliary key rows for one annotation."
  ),
  stringsAsFactors = FALSE
)
DBI::dbWriteTable(con, "index_summary", index_specs, overwrite = TRUE)

if (!opt("skip_indexes")) {
  exec(sql(
    "CREATE INDEX idx_ann_locus",
    "ON variant_annotations(build, chrom_norm, pos)"
  ))
  exec(sql(
    "CREATE INDEX idx_interp_annotation_genotype",
    "ON genotype_interpretations(annotation_id, genotype_norm)"
  ))
  exec(sql(
    "CREATE INDEX idx_vk_variantkey",
    "ON variant_keys(build, variant_key)"
  ))
  exec(sql(
    "CREATE INDEX idx_vk_annotation",
    "ON variant_keys(annotation_id)"
  ))
}

exec(sql(
  "CREATE OR REPLACE TABLE asset_summary AS",
  "SELECT",
  "  'variant_annotations' AS asset,",
  "  count(*)::BIGINT AS row_count",
  "FROM variant_annotations",
  "UNION ALL",
  "SELECT",
  "  'genotype_interpretations',",
  "  count(*)::BIGINT",
  "FROM genotype_interpretations",
  "UNION ALL",
  "SELECT",
  "  'variant_keys',",
  "  count(*)::BIGINT",
  "FROM variant_keys",
  "UNION ALL",
  "SELECT",
  "  'index_summary',",
  "  count(*)::BIGINT",
  "FROM index_summary"
))

exec(sql(
  "CREATE OR REPLACE TABLE source_summary AS",
  "SELECT",
  "  source,",
  "  build,",
  "  count(*)::BIGINT AS row_count",
  "FROM variant_annotations",
  "GROUP BY source, build",
  "ORDER BY source, build"
))

copy_parquet <- function(table, filename, order_by = NULL) {
  path <- normalizePath(file.path(out_dir, filename), mustWork = FALSE)
  source_sql <- if (is.null(order_by)) {
    table
  } else {
    sprintf("(SELECT * FROM %s ORDER BY %s)", table, order_by)
  }
  copy_options <- sprintf(
    paste(
      "(FORMAT PARQUET, COMPRESSION ZSTD,",
      "COMPRESSION_LEVEL %d, ROW_GROUP_SIZE %d)"
    ),
    parquet_compression_level,
    parquet_row_group_size
  )
  exec(sql(
    sprintf("COPY %s", source_sql),
    sprintf("TO %s", sql_quote_string(path)),
    copy_options
  ))
}

if (!opt("skip_parquet")) {
  copy_parquet(
    "variant_annotations",
    "variant_annotations.parquet",
    "build, chrom_norm, pos, source, annotation_id"
  )
  copy_parquet(
    "genotype_interpretations",
    "genotype_interpretations.parquet",
    "annotation_id, genotype_norm"
  )
  copy_parquet(
    "variant_keys",
    "variant_keys.parquet",
    "build, chrom_norm, pos, annotation_id, is_primary_key DESC"
  )
  copy_parquet("asset_summary", "asset_summary.parquet")
  copy_parquet("source_summary", "source_summary.parquet")
  copy_parquet("index_summary", "index_summary.parquet")
}

summary <- DBI::dbGetQuery(
  con,
  "SELECT asset, row_count FROM asset_summary ORDER BY asset"
)
source_summary <- DBI::dbGetQuery(
  con,
  sql(
    "SELECT source, build, row_count",
    "FROM source_summary",
    "ORDER BY source, build"
  )
)
supported_builds <- DBI::dbGetQuery(
  con,
  sql(
    "SELECT DISTINCT build",
    "FROM variant_annotations",
    "ORDER BY build"
  )
)$build
exec("CHECKPOINT")
DBI::dbDisconnect(con, shutdown = TRUE)

asset_files <- c(
  file.path(out_dir, opt("duckdb_file")),
  if (!opt("skip_parquet")) {
    file.path(
      out_dir,
      c(
        "variant_annotations.parquet",
        "genotype_interpretations.parquet",
        "variant_keys.parquet",
        "asset_summary.parquet",
        "source_summary.parquet",
        "index_summary.parquet"
      )
    )
  } else {
    character(0)
  }
)
asset_files <- asset_files[file.exists(asset_files)]
size_report <- data.frame(
  file = basename(asset_files),
  bytes = as.integer(file.info(asset_files)$size),
  mib = round(file.info(asset_files)$size / 1024 / 1024, 3),
  stringsAsFactors = FALSE
)
utils::write.table(
  size_report,
  size_report_path,
  sep = "\t",
  row.names = FALSE,
  quote = FALSE
)

manifest <- list(
  name = "DuckGeneSnap locus annotation bundle",
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  schema_version = 3,
  matching_policy = "locus_first_build_chrom_pos",
  supported_builds = unname(as.list(supported_builds)),
  assets = list(
    duckdb_database = paste0("public/data/", opt("duckdb_file")),
    variant_annotations = "public/data/variant_annotations.parquet",
    genotype_interpretations = "public/data/genotype_interpretations.parquet",
    variant_keys = "public/data/variant_keys.parquet",
    asset_summary = "public/data/asset_summary.parquet",
    source_summary = "public/data/source_summary.parquet",
    index_summary = "public/data/index_summary.parquet",
    size_report = rel_path(size_report_path, repo_root)
  ),
  counts = stats::setNames(as.list(summary$row_count), summary$asset),
  sources = rows_to_lists(source_summary),
  indexes = rows_to_lists(index_specs),
  parquet = list(
    row_group_size = parquet_row_group_size,
    compression = "zstd",
    compression_level = parquet_compression_level
  ),
  sizes = rows_to_lists(size_report),
  notes = c(
    paste(
      "Core ingestion matches on genome build, normalized chromosome,",
      "and 1-based position."
    ),
    "source_id is metadata only and is not part of the ingestion join.",
    paste(
      "variant_keys is an auxiliary allele-specific table for",
      "injection/display/future refinement."
    ),
    paste(
      "The browser stages the DuckDB file into the webR filesystem by",
      "default; remote ATTACH over HTTPS can be tested separately for",
      "larger deployments."
    )
  )
)
jsonlite::write_json(
  manifest,
  file.path(out_dir, "manifest.json"),
  auto_unbox = TRUE,
  pretty = TRUE
)

message("Wrote DuckGeneSnap assets to ", out_dir)
message("DuckDB annotation database: ", db_path)
message("Size report: ", size_report_path)
print(summary)
print(source_summary)
print(size_report)
