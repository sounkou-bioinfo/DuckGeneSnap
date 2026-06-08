
# DuckGeneSnap

DuckGeneSnap is a pure static, browser-side reproduction of the core
GeneSnap idea: parse personal genotype/variant files, match clinically
or biologically annotated loci, and present categorized results without
running a backend.

It follows the DuckBedQC pattern: the page loads `webR`, `duckdb`, and
`Rduckhts` in the browser. User files are staged into the browser
filesystem and queried locally. No genotype data is uploaded to a
server.

> **Disclaimer:** DuckGeneSnap is informational only and is not medical
> advice. Clinically significant findings require clinical-grade
> confirmation and review by a qualified professional.

## What works now

- Static `index.html` with local browser-side analysis.
- 23andMe-style raw text upload.
- VCF/BCF/VCF.GZ upload through
  `Rduckhts::rduckhts_bcf(..., tidy_format = TRUE)`, including
  DeepVariant-style `FORMAT_GT` genotype fields.
- Locus-first matching:
  `build + normalized chromosome + 1-based position`.
- Sorted ZSTD Parquet annotation assets staged into webR and queried
  with DuckDB.
- Configurable Parquet row group size and compression level.
- Auxiliary `variant_keys` table for allele-aware display, QA, and
  future exact-key refinement.
- Optional VCF/BCF liftover hook using `bcftools_liftover()` when chain
  and FASTA files are supplied by the user.
- DuckBedQC-style step timing modal and per-run timing table.
- HTMX is included for static fragment loading; computation remains in
  the local DuckDB/webR layer.
- Demo 23andMe-style file at `public/demo/example_23andme.txt`.

The committed annotation assets include ClinVar variant-summary rows for
GRCh37 and GRCh38 (pathogenic/likely pathogenic, drug response, risk
factor, and association records), GWAS Catalog associations filtered at
genome-wide significance, and a small GRCh37 seed set used by the local
demo files.

## Hosted site

GitHub Pages is configured for the repository root:

<https://sounkou-bioinfo.github.io/DuckGeneSnap/>

## Run locally

Serve the repository over HTTP; do not open `index.html` with `file://`.
For local testing, prefer goServeR because it supports range requests
out of the box:

``` bash
cd DuckGeneSnap
Rscript -e "goserveR::runServer(dir='.', prefix='/', addr='127.0.0.1:8000')"
# open http://127.0.0.1:8000/
```

If needed, install goServeR from
<https://github.com/sounkou-bioinfo/goServeR>.

First browser use can take a while because webR installs `DBI`,
`duckdb`, `jsonlite`, and `Rduckhts` into the browser runtime.

## Rebuild static assets

Requires R packages `optparse`, `DBI`, `duckdb`, `Rduckhts`, and
`jsonlite`.

``` bash
cd DuckGeneSnap
Rscript scripts/build_assets.R
```

Useful size-test examples:

``` bash
Rscript scripts/build_assets.R \
  --out-dir .size_tests/clinvar_tsv_noidx \
  --clinvar-tsv path/to/variant_summary.txt.gz \
  --skip-seed \
  --skip-indexes

Rscript scripts/build_assets.R \
  --out-dir .size_tests/gwas_full \
  --gwas-zip path/to/gwas-catalog-associations-full.zip \
  --skip-seed \
  --skip-indexes
```

Outputs:

- `public/data/variant_annotations.parquet`
- `public/data/genotype_interpretations.parquet`
- `public/data/variant_keys.parquet`
- `public/data/source_summary.parquet`
- `public/data/index_summary.parquet`
- `public/data/size_report.tsv`
- `public/data/manifest.json`

See `docs/SIZE_TESTS.md` for measured ClinVar/GWAS bundle sizes, index
overhead, ZSTD compression-level tests, `parquet-linter` output, and
Parquet row group trade-offs.

## Committed annotation asset sizes

| file                             |    bytes |    mib |
|:---------------------------------|---------:|-------:|
| variant_annotations.parquet      | 57275402 | 54.622 |
| genotype_interpretations.parquet |     3367 |  0.003 |
| variant_keys.parquet             |  9431974 |  8.995 |
| asset_summary.parquet            |      484 |  0.000 |
| source_summary.parquet           |      554 |  0.001 |
| index_summary.parquet            |     1262 |  0.001 |

## Demo and test inputs

The repository includes small synthetic input files for testing both
supported input paths and both builds represented in the committed
assets:

- `public/demo/example_23andme.txt`
- `public/demo/example_23andme_grch37.txt`
- `public/demo/example_23andme_grch38.txt`
- `public/demo/example_grch37.vcf`
- `public/demo/example_grch37.bcf`
- `public/demo/example_deepvariant_grch37.vcf.gz`
- `public/demo/example_grch38.vcf`
- `public/demo/example_grch38.bcf`

## Repository layout

``` text
index.html                         static app shell
src/duckgenesnap.js                browser webR/DuckDB/Rduckhts runtime
public/data/*.parquet              sorted annotation and metadata assets
public/demo/*                      synthetic chip/VCF/BCF test inputs
data/seed/*.tsv                    GRCh37 seed curation source
scripts/build_assets.R             optparse asset builder/injector
docs/                              design, schema, size notes
```

## Matching and storage policy

Core ingestion does **not** depend on rsID identity. Uploaded rows are
matched by:

``` text
analysis_build + chrom_norm + pos
```

`source_id` may contain rsIDs or source-specific identifiers, but it is
display metadata only. `variant_keys` is kept as an auxiliary
allele-specific table for VCF/BCF QA, detail panels, and future exact
allele refinement.

A browser-side webR REPL is intentionally out of scope for the current
release, but the app keeps the DuckDB connection in the browser runtime
so a future REPL panel can expose plotting, ad hoc SQL, and additional
summary statistics.

Do not lift or mutate VariantKeys directly. For allele-aware paths:

``` text
source chrom/pos/ref/alt
  -> optional normalization/liftover
  -> recompute variantkey(chrom, pos, ref, alt)
  -> optional exact-key refinement
```

## Upstream attribution and frontend query credit

DuckGeneSnap is an independent static-site/DuckDB/Rduckhts
implementation inspired by the upstream GeneSnap project by syao13:
<https://github.com/syao13/GeneSnap>. DuckGeneSnap keeps the user-facing
idea of parsing raw genetic data and annotating clinically significant
variants, but moves the analysis into a backend-free browser runtime.

The planned variant detail panels also take inspiration from the
lightweight frontend-only query orchestration in Sasha Gusev’s GWAS
Lookup: <https://github.com/sashagusev/gwas_lookup>. DuckGeneSnap keeps
that spirit (client-side modules, URL-stateable variant queries,
parallel enrichment panels) but uses local DuckDB/Rduckhts assets first
and calls external APIs only for on-demand detail enrichment.

## Related projects

- Upstream GeneSnap: <https://github.com/syao13/GeneSnap>
- DuckBedQC: <https://github.com/sounkou-bioinfo/DuckBedQC>
- GWAS Lookup frontend inspiration:
  <https://github.com/sashagusev/gwas_lookup>
- Rduckhts / duckhts: <https://github.com/RGenomicsETL/duckhts>
