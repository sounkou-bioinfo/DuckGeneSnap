# Frontend query boundary

Local `analysis_matches` is the source for result filters, paging and exports.
Modules under `src/` keep database work separate from `app.js` DOM wiring.
The page intentionally has no outbound detail fetch, third-party scripts,
URL-based external lookup, or external links. A future detail view can use
shipped metadata (`external_ids`, `publications`, `description`, VariantKey and
review stars) without exposing an uploaded genotype to another origin.

Any future enrichment feature needs an explicit privacy and network policy.
The present runtime and its tests require requests to stay on the page origin.
