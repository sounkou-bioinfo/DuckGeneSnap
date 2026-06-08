-- Reference locus-first DuckGeneSnap join.
ATTACH 'public/data/duckgenesnap.duckdb' AS ann (READ_ONLY);

WITH uploaded_loci AS (
  SELECT
    'GRCh37' AS build,
    '1' AS chrom,
    '1' AS chrom_norm,
    169519049::BIGINT AS pos,
    'AG' AS genotype_norm
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
JOIN ann.variant_annotations a
  ON a.build = u.build
 AND a.chrom_norm = u.chrom_norm
 AND a.pos = u.pos
LEFT JOIN ann.genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = u.genotype_norm;
