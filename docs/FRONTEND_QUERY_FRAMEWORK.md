# Frontend Query Framework Notes

DuckGeneSnap's future per-variant detail panels should follow the same broad
client-side idea as Sasha Gusev's GWAS Lookup:

- repository: <https://github.com/sashagusev/gwas_lookup>
- no application backend
- ES module-style source organization
- URL-addressable variant/locus state
- parallel section loading with independent error states
- source-specific API modules separated from rendering code

DuckGeneSnap differs in the first query layer:

1. resolve uploaded file rows locally with DuckDB/Rduckhts;
2. join local `variant_annotations` by `build + chrom_norm + pos`;
3. render local results immediately;
4. fetch remote details only when a user opens a row or detail panel.

Suggested module split once the single-file prototype is broken up:

```text
src/app.js                  orchestration and URL state
src/runtime/webr-duckdb.js  webR, DuckDB, Rduckhts lifecycle
src/input/parse-chip.js     23andMe-style parser
src/input/read-vcf.js       VCF/BCF staging via Rduckhts
src/query/local-locus.js    DuckDB annotation queries
src/query/enrich-clinvar.js optional REST/VCF detail fetch
src/query/enrich-gwas.js    optional GWAS detail fetch
src/ui/results.js           summary cards and result tables
src/ui/detail-panels.js     lazy detail panel rendering
```

Credit should remain visible in the README and site links when using this
frontend-only query-panel pattern.
