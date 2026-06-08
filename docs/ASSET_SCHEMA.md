# Static Asset Schema

DuckGeneSnap ships a DuckDB annotation database plus browser-readable Parquet
sidecars in `public/data/`.

## `variant_annotations`

One row per source annotation at a genomic locus.

| Column | Notes |
|---|---|
| `annotation_id` | Stable source/build/locus identifier. |
| `source` | `seed`, `clinvar`, `gwas_catalog`, `pharmgkb`, etc. |
| `source_id` | Source identifier, often rsID; display metadata only. |
| `build` | Genome build label, e.g. `GRCh37` or `GRCh38`. |
| `chrom` | Source chromosome label. |
| `chrom_norm` | Normalized chromosome used for joins. |
| `pos` | 1-based genomic position used for joins. |
| `gene` | Gene or locus label if known. |
| `category` | `health_risk`, `pharmacogenomics`, or `trait`. |
| `name` | Display name. |
| `significance` | `pathogenic`, `association`, `drug_response`, etc. |
| `description` | Display text. |
| `risk_allele` | Optional effect/risk allele. |
| `normal_allele` | Optional reference/normal allele. |
| `external_ids` | JSON string or source-specific payload. |
| `publications` | PMID/source publication field. |
| `clinvar_stars` | Evidence display/scoring field. |
| `odds_ratio` | Optional effect size. |
| `score` | Simple evidence score. |
| `source_payload` | Compact source-specific text. |

Primary runtime join:

```sql
SELECT *
FROM uploaded_loci u
JOIN variant_annotations a
  ON a.build = $analysis_build
 AND a.chrom_norm = u.chrom_norm
 AND a.pos = u.pos;
```

## `genotype_interpretations`

Optional genotype-level interpretation rows.

| Column | Notes |
|---|---|
| `annotation_id` | Links to `variant_annotations`. |
| `source_id` | Display/source identifier. |
| `genotype` | Original genotype string. |
| `genotype_norm` | Sorted diploid A/C/G/T genotype for joins. |
| `interpretation` | Display text. |
| `risk_level` | `normal`, `carrier`, `increased_risk`, `high_risk`. |

## `variant_keys`

Auxiliary allele-specific key table. This is not the primary ingestion identity.
It is useful for VCF/BCF QA, detail panels, and future allele-exact refinement.

| Column | Notes |
|---|---|
| `annotation_id` | Links to `variant_annotations`. |
| `source` | Source label. |
| `source_id` | Source identifier. |
| `build` | Genome build. |
| `chrom`, `chrom_norm`, `pos` | Key locus. |
| `ref`, `alt` | Allele pair used to compute the key. |
| `variant_key` | DuckHTS VariantKey code. |
| `variant_key_hex` | 16-character lowercase hex rendering. |
| `is_primary_key` | Preferred display key where available. |
| `key_role` | Provenance label. |

## `index_summary`

Machine-readable explanation of persistent DuckDB indexes. This table exists so
index choices are auditable instead of hidden in the build script.

## `source_summary` and `asset_summary`

Small manifest-like summary tables used by the app and by smoke tests.

## Parquet sidecars

Parquet sidecars are sorted by locus and written with configurable
`ROW_GROUP_SIZE` so row-group min/max statistics can prune locus/range queries.
They use ZSTD compression level 22 by default for smallest static assets. Use
`--parquet-row-group-size N` and `--parquet-compression-level N` to tune the
trade-off.
