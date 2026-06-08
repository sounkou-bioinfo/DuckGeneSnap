# DuckGeneSnap Architecture

DuckGeneSnap is a static-site genomics analysis app. The runtime has no upload
endpoint and no persistent application service.

```text
build time
  ClinVar/GWAS/PharmGKB/seed sources
    -> DuckDB + Rduckhts injection
    -> sorted Parquet sidecars + manifest

browser runtime
  index.html + duckgenesnap.js
    -> webR
    -> R packages: DBI, duckdb, Rduckhts, jsonlite
    -> local DuckDB connection
    -> uploaded 23andMe/VCF/BCF staged in webR FS
    -> locus joins against sorted Parquet assets
```

## Runtime layers

1. **UI layer**: Bootstrap + small HTMX usage for static fragments.
2. **Browser filesystem layer**: uploads are written into webR's in-memory
   filesystem under `/duckgenesnap/upload`.
3. **DuckDB layer**: sorted Parquet sidecars are staged into webR and exposed as
   DuckDB views. For local testing, use a range-capable static server such as
   <https://github.com/sounkou-bioinfo/goServeR>.
4. **Rduckhts layer**: VCF/BCF parsing, VariantKey functions, and optional
   liftover are loaded through `Rduckhts::rduckhts_load(con)`.
5. **Rendering layer**: query results are returned as JSON and rendered locally.

## Analysis modes

### 23andMe-style raw text

Input columns are parsed as:

```text
marker_id chromosome position genotype
```

Rows with no-calls (`--`) are skipped. Matching is by selected analysis build,
normalized chromosome, and 1-based position. The marker ID is display metadata
only and is not used for ingestion.

### VCF/BCF

VCF/BCF input is loaded with:

```r
Rduckhts::rduckhts_bcf(con, "user_variants_raw", path, tidy_format = TRUE)
```

Core matching is still build/chrom/position. The runtime also computes
`variantkey(CHROM, POS, REF, ALT)` as auxiliary evidence for display and future
allele-exact refinement.

### VCF/BCF liftover

When enabled and builds differ, the app calls `bcftools_liftover()` with
user-supplied chain/source/destination reference assets. The lifted destination
locus is then used for matching. If allele-aware refinement is needed, the
VariantKey is recomputed after liftover.

## Parquet statistics

Sidecars are sorted by locus and written with configurable row group size so
row-group min/max statistics can prune genomic ranges. Static production bundles
use high ZSTD compression because write time is paid once at build time.

## Privacy model

All uploaded files are read by browser APIs and written only into the in-memory
webR filesystem. The static app fetches package and annotation assets, but it
has no upload endpoint for user genotypes.

## External enrichment

Following the GWAS Lookup frontend-only pattern, additional source details should
be fetched lazily for a selected variant/locus. The local DuckDB bundle remains
the first query layer; REST APIs, remote Parquet, or indexed VCF assets are used
only when a user expands a detail panel.
