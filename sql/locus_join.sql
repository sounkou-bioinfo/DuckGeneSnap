-- Reference locus-first DuckGeneSnap join over Parquet sidecars.
WITH uploaded_loci AS (
  SELECT
    'GRCh37' AS build,
    '1' AS chrom,
    '1' AS chrom_norm,
    169519049::BIGINT AS pos,
    'AG' AS genotype_norm
),
variant_annotations AS (
  SELECT *
  FROM read_parquet('public/data/variant_annotations.parquet')
),
genotype_interpretations AS (
  SELECT *
  FROM read_parquet('public/data/genotype_interpretations.parquet')
)
SELECT
  a.annotation_id,
  a.source,
  a.source_id,
  a.gene,
  a.name,
  a.significance,
  gi.risk_level,
  gi.interpretation
FROM uploaded_loci u
JOIN variant_annotations a
  ON a.build = u.build
 AND a.chrom_norm = u.chrom_norm
 AND a.pos = u.pos
LEFT JOIN genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = u.genotype_norm;
