# Asset Size Tests

Generated with `scripts/build_assets.R` on 2026-06-08.

## Inputs tested

- ClinVar P/LP GRCh38 BCF from DuckBedQC:
  `clinvar_hg38_pathogenic_likelypathogenic.bcf`
- GWAS Catalog full associations ZIP, filtered at `p <= 5e-8`

## Results

Initial runs used DuckDB Parquet ZSTD level 1 unless otherwise noted.

| Bundle | Rows | Indexes | DuckDB | annotation Parquet | key Parquet |
|---|---:|---|---:|---:|---:|
| seed demo | 16 | yes | 3.51 MiB | 0.006 MiB | 0.003 MiB |
| ClinVar GRCh38 P/LP | 337,482 | yes | 123.51 MiB | 14.26 MiB | 5.28 MiB |
| ClinVar GRCh38 P/LP | 337,482 | no | 65.51 MiB | 14.26 MiB | 5.28 MiB |
| GWAS Catalog p<=5e-8 | 804,594 | no | 124.01 MiB | 37.13 MiB | 0 MiB |
| ClinVar + GWAS | 1,142,076 | no | 190.01 MiB | 55.17 MiB | 5.28 MiB |

Takeaway: the DuckDB database is convenient for `ATTACH`, but persistent indexes
roughly doubled the ClinVar test DB. Sorted Parquet sidecars are much smaller and
are likely the better browser default if HTTP range behavior for attached DuckDB
files is not good enough.

## ZSTD compression level test

For the combined ClinVar + GWAS annotation table, sorted by
`build, chrom_norm, pos, source, annotation_id`, with `ROW_GROUP_SIZE 50000`:

| ZSTD level | File size |
|---:|---:|
| 1 | 58 MiB |
| 3 | 56 MiB |
| 9 | 46 MiB |
| 15 | 43 MiB |
| 22 | 40 MiB |

The builder default is now `--parquet-compression-level 22` because these are
static web assets and write time is paid at build time.

## Parquet row group size test

For the combined ClinVar + GWAS annotation table, sorted by locus with ZSTD level
1 in the original row-group experiment:

| ROW_GROUP_SIZE | Row groups | File size |
|---:|---:|---:|
| 10,000 | 112 | 59 MiB |
| 50,000 | 23 | 56 MiB |
| 250,000 | 5 | 54 MiB |

Default is currently `--parquet-row-group-size 50000`.

Smaller row groups improve min/max pruning for locus and regional queries but add
metadata overhead. For this app, 50k is a reasonable starting point. For very
sparse point lookups, 10k may be worth the size cost. For mostly whole-table
scans, 250k is smaller.

## parquet-linter run

`parquet-linter` was run on the current tiny public Parquet files and on the
large combined ClinVar + GWAS annotation sidecar.

Useful findings:

- DuckDB-written files lack page-level column indexes/page statistics.
- It recommends page statistics and truncating string statistics.
- It recommends `byte_stream_split` for floating columns (`odds_ratio`, `score`).
- It recommends some per-column compression choices for low-cardinality fields.

Caution: blindly applying the exported prescription to the combined annotation
Parquet made the file much larger in this test:

| File | Size |
|---|---:|
| DuckDB sorted ZSTD level 1 | 56 MiB |
| `parquet-linter rewrite` prescription output | 402 MiB |

So for now we keep DuckDB's writer, high ZSTD compression, sorted row groups, and
record the linter output under `docs/parquet-linter/` for future Arrow-writer work
rather than applying the rewrite automatically.

## Indexes created by default

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `idx_ann_locus` | `variant_annotations` | `build, chrom_norm, pos` | Batch exact locus joins from uploaded 23andMe/VCF rows. |
| `idx_interp_annotation_genotype` | `genotype_interpretations` | `annotation_id, genotype_norm` | Genotype-specific interpretation after annotation match. |
| `idx_vk_variantkey` | `variant_keys` | `build, variant_key` | Optional allele-exact VariantKey lookup and QA. |
| `idx_vk_annotation` | `variant_keys` | `annotation_id` | Detail-panel lookup of auxiliary key rows. |

Use `--skip-indexes` for compressed static bundles where Parquet row-group stats
are the main pruning mechanism or where DuckDB HTTP attach range behavior is not
confirmed.
