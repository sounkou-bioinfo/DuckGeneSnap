# DuckGeneSnap

DuckGeneSnap is a static, browser-side genomic annotation explorer. It reads
23andMe-style text and VCF/BCF/VCF.GZ, joins loci against shipped GRCh37 and
GRCh38 ClinVar/GWAS Parquet assets and curated seed interpretations, and keeps
queries in DuckDB-Wasm with DuckHTS. It is informational, **not medical advice**;
clinical findings need clinical-grade confirmation.

## Run

```sh
npm ci
npm run vendor
npm run stage
npm run stage:dev
npm run serve
# open http://127.0.0.1:8000/?duckhts=dev
npm test
```

`vendor/` is never committed. `npm run stage` checks the DuckHTS and Parquet
Wasm downloads against pinned SHA-256 manifests. `npm run stage:dev` fetches a
pinned unsigned DuckHTS CI artifact using `gh`; it can also accept an existing
`gh run download` directory as its argument. The signed DuckHTS 1.5.2 build
cannot read browser `blob:` inputs. Use `?duckhts=dev` for VCF/BCF, indexed
FASTA and liftover; the default page rejects local VCF/BCF inputs with an
explanation. Once `duckhts@dev` is published, the npm package can replace this
verified CI artifact. The site must be served over HTTP, not opened as `file:`.

The browser downloads static annotations from its own origin; no query or
upload is sent to a third-party service. A same-origin Service Worker provides
temporary byte-range access to paired FASTA/.fai and chain uploads needed by
liftover. These files are cleared from browser Cache Storage after each
operation; a browser crash can leave them in site storage until site data is
cleared. Large references require sufficient local storage.

## Features

- 23andMe-style chip text (including gzip text), VCF, BCF and VCF.GZ input;
  GRCh37/GRCh38 selection, called-alternate or all-concrete VCF mode.
- Locus-first matching, exact VariantKey refinement for annotations with
  known alleles, genotype interpretation for curated seed rows.
- Local result counts, search, gene/category/risk/source/classification and
  ClinVar review-star filters, paging, details, and filtered TSV/CSV/Parquet
  downloads. No spreadsheet library is needed; Excel is not provided.
- DuckHTS SQL liftover with uploaded chain and indexed source/destination
  FASTAs, yielding VCF, TSV or Parquet; chip-to-VCF plus QC TSV using indexed
  `fasta_nuc` reference reads. Chip conversion emits biallelic SNVs only.
- Included synthetic examples in `public/demo/`, with headless Chromium tests
  (`npm test`). The HTML is intentionally unstyled so page design can be
  supplied separately.

## Asset pipeline

The R asset builder and committed Parquet files remain independent of the web
runtime. Rebuild with `Rscript scripts/build_assets.R` (requires `optparse`,
`DBI`, `duckdb`, `Rduckhts`, `jsonlite`). See `docs/ASSET_SCHEMA.md`,
`docs/ARCHITECTURE.md`, and `docs/SIZE_TESTS.md`.

## Matching contract

Input and annotation rows first join on `(build, chrom_norm, pos)`. VCF/BCF
rows then compute `variantkey(chrom,pos,ref,alt)` after optional liftover and
require exact keys when the annotation has one. Chip text has no reference
allele, so its results remain locus-only. rsIDs are display metadata, not
join keys.

DuckGeneSnap is an independent browser implementation inspired by GeneSnap
(<https://github.com/syao13/GeneSnap>); its local SQL architecture follows
DuckHTS and duckpeakwhere (<https://github.com/sounkou-bioinfo/duckpeakwhere>).
