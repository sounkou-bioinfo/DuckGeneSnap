import { WebR } from "https://webr.r-wasm.org/latest/webr.mjs";

const DATA_BASE = "public/data";
const DEMO_23ANDME = "public/demo/example_23andme.txt";
const VFS_ROOT = "/duckgenesnap";
const VFS_DATA = `${VFS_ROOT}/data`;
const VFS_UPLOAD = `${VFS_ROOT}/upload`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const state = {
  manifest: null,
  backend: {
    initPromise: null,
    webR: null,
    shelter: null,
    ready: false,
    assetsReady: false,
  },
  lastRows: [],
  lastSummary: null,
};

const nodes = {};

const riskOrder = {
  high_risk: 0,
  increased_risk: 1,
  carrier: 2,
  normal: 3,
};

const riskClasses = {
  high_risk: "danger",
  increased_risk: "warning",
  carrier: "info",
  normal: "success",
};

function byId(id) {
  return document.getElementById(id);
}

function initNodes() {
  [
    "runtime-status",
    "asset-status",
    "file-input",
    "input-kind",
    "input-build",
    "analysis-build",
    "liftover-mode",
    "chain-file",
    "src-ref-file",
    "dst-ref-file",
    "analyze-button",
    "demo-button",
    "reset-button",
    "download-button",
    "results",
    "messages",
    "liftover-card",
  ].forEach((id) => {
    nodes[id] = byId(id);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRString(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function rString(value) {
  return `'${escapeRString(value)}'`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sanitizeFilename(name, fallback = "upload.dat") {
  const cleaned = String(name || fallback).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || fallback;
}

function setStatus(message, kind = "secondary") {
  nodes["runtime-status"].className = `alert alert-${kind} mb-3`;
  nodes["runtime-status"].textContent = message;
}

function setAssetStatus(message, kind = "secondary") {
  nodes["asset-status"].className = `small text-${kind}`;
  nodes["asset-status"].textContent = message;
}

function showMessage(message, kind = "warning") {
  nodes.messages.innerHTML = `<div class="alert alert-${kind}" role="alert">${escapeHtml(message)}</div>`;
}

function clearMessage() {
  nodes.messages.innerHTML = "";
}

function setBusy(isBusy, label = "Analyze") {
  nodes["analyze-button"].disabled = isBusy;
  nodes["demo-button"].disabled = isBusy;
  nodes["reset-button"].disabled = isBusy;
  nodes["analyze-button"].innerHTML = isBusy
    ? `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${escapeHtml(label)}`
    : "Analyze locally";
}

async function ensureWebRDir(path) {
  try {
    await state.backend.webR.FS.lookupPath(path);
  } catch (_) {
    await state.backend.webR.FS.mkdir(path);
  }
}

async function runR(code) {
  if (!state.backend.shelter) {
    throw new Error("webR shelter is not ready");
  }
  return state.backend.shelter.captureR(code, { withAutoprint: false });
}

async function executeSql(sql) {
  await runR(`DBI::dbExecute(con, ${rString(sql)})`);
}

async function queryJson(sql) {
  const outputPath = `${VFS_ROOT}/query_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
  await runR(`
res <- DBI::dbGetQuery(con, ${rString(sql)})
jsonlite::write_json(res, ${rString(outputPath)}, dataframe = 'rows', na = 'null', auto_unbox = TRUE)
`);
  const bytes = await state.backend.webR.FS.readFile(outputPath);
  return JSON.parse(textDecoder.decode(bytes));
}

async function warmBackend() {
  if (state.backend.initPromise) {
    return state.backend.initPromise;
  }

  state.backend.initPromise = (async () => {
    setStatus("Starting webR. First load can take a minute while browser packages are installed...", "warning");
    const webR = new WebR();
    await webR.init();
    state.backend.webR = webR;

    await ensureWebRDir(VFS_ROOT);
    await ensureWebRDir(VFS_DATA);
    await ensureWebRDir(VFS_UPLOAD);

    setStatus("Installing browser DuckDB packages...", "warning");
    await webR.installPackages(["DBI", "duckdb", "jsonlite"], { repos: "https://repo.r-wasm.org/" });

    setStatus("Installing Rduckhts from R-universe...", "warning");
    await webR.installPackages(["Rduckhts"], {
      repos: ["https://rgenomicsetl.r-universe.dev", "https://repo.r-wasm.org/"],
      mount: false,
    });

    state.backend.shelter = await new webR.Shelter();
    await runR("library(DBI); library(duckdb); library(Rduckhts); library(jsonlite)");
    await runR("con <- DBI::dbConnect(duckdb::duckdb(config = list(allow_unsigned_extensions = 'true')))");
    await runR("Rduckhts::rduckhts_load(con)");
    state.backend.ready = true;
    setStatus("Browser DuckDB + Rduckhts runtime ready. No upload data leaves this page.", "success");
    return state.backend;
  })().catch((error) => {
    state.backend.initPromise = null;
    state.backend.ready = false;
    setStatus(`Runtime failed: ${error.message ?? String(error)}`, "danger");
    throw error;
  });

  return state.backend.initPromise;
}

async function fetchManifest() {
  if (state.manifest) return state.manifest;
  const response = await fetch(`${DATA_BASE}/manifest.json`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${DATA_BASE}/manifest.json`);
  }
  state.manifest = await response.json();
  return state.manifest;
}

function manifestBuilds(manifest) {
  if (Array.isArray(manifest.supported_builds)) return manifest.supported_builds;
  if (typeof manifest.supported_builds === "string") return [manifest.supported_builds];
  return ["GRCh37"];
}

async function populateBuildSelectors() {
  const manifest = await fetchManifest();
  const builds = manifestBuilds(manifest);
  const options = builds.map((build) => `<option value="${escapeHtml(build)}">${escapeHtml(build)}</option>`).join("");
  nodes["analysis-build"].innerHTML = options;
  nodes["input-build"].innerHTML = builds
    .map((build) => `<option value="${escapeHtml(build)}">${escapeHtml(build)}</option>`)
    .concat([`<option value="other">other / requires liftover</option>`])
    .join("");
  setAssetStatus(`${manifest.name}: ${manifest.counts?.variant_annotations ?? "?"} locus annotations, ${manifest.counts?.variant_keys ?? "?"} auxiliary VariantKey rows (${builds.join(", ")}).`, "muted");
}

async function stageAssets() {
  if (state.backend.assetsReady) return;
  await warmBackend();
  const manifest = await fetchManifest();
  const dbFilename = "duckgenesnap.duckdb";
  const dbUrl = `${DATA_BASE}/${dbFilename}`;
  const dbPath = `${VFS_DATA}/${dbFilename}`;

  try {
    const response = await fetch(dbUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await state.backend.webR.FS.writeFile(dbPath, new Uint8Array(await response.arrayBuffer()));
    await executeSql("DETACH ann").catch(() => {});
    await executeSql(`ATTACH '${dbPath}' AS ann (READ_ONLY)`);
    await executeSql("CREATE OR REPLACE VIEW variant_annotations AS SELECT * FROM ann.variant_annotations");
    await executeSql("CREATE OR REPLACE VIEW genotype_interpretations AS SELECT * FROM ann.genotype_interpretations");
    await executeSql("CREATE OR REPLACE VIEW variant_keys AS SELECT * FROM ann.variant_keys");
    setAssetStatus(`Attached local DuckDB annotation file: ${manifest.counts?.variant_annotations ?? "?"} locus annotations.`, "success");
  } catch (error) {
    console.warn("DuckDB file attach failed; falling back to Parquet assets", error);
    const assetEntries = [
      "variant_annotations.parquet",
      "genotype_interpretations.parquet",
      "variant_keys.parquet",
    ];
    for (const filename of assetEntries) {
      const url = `${DATA_BASE}/${filename}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to fetch asset ${url}`);
      await state.backend.webR.FS.writeFile(`${VFS_DATA}/${filename}`, new Uint8Array(await response.arrayBuffer()));
    }
    await executeSql(`CREATE OR REPLACE VIEW variant_annotations AS SELECT * FROM read_parquet('${VFS_DATA}/variant_annotations.parquet')`);
    await executeSql(`CREATE OR REPLACE VIEW genotype_interpretations AS SELECT * FROM read_parquet('${VFS_DATA}/genotype_interpretations.parquet')`);
    await executeSql(`CREATE OR REPLACE VIEW variant_keys AS SELECT * FROM read_parquet('${VFS_DATA}/variant_keys.parquet')`);
    setAssetStatus(`Loaded fallback Parquet assets: ${manifest.counts?.variant_annotations ?? "?"} locus annotations.`, "success");
  }

  state.backend.assetsReady = true;
}

function normalizeGenotype(genotype) {
  const gt = String(genotype || "").trim().toUpperCase();
  if (/^[ACGT]{2}$/.test(gt)) {
    return gt.split("").sort().join("");
  }
  return gt;
}

function parse23AndMe(text) {
  const rows = [];
  const stats = {
    total_lines: 0,
    data_lines: 0,
    parsed_snps: 0,
    skipped_comments: 0,
    skipped_no_call: 0,
    skipped_malformed: 0,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    stats.total_lines += 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      stats.skipped_comments += 1;
      continue;
    }
    const parts = line.split(/\t|\s+/);
    if (["rsid", "id", "marker", "marker_id"].includes(parts[0]?.toLowerCase())) continue;
    stats.data_lines += 1;
    if (parts.length < 4) {
      stats.skipped_malformed += 1;
      continue;
    }
    const [marker_id, chrom, posText, genotypeRaw] = parts;
    const genotype = genotypeRaw.toUpperCase();
    if (genotype === "--") {
      stats.skipped_no_call += 1;
      continue;
    }
    const pos = Number.parseInt(posText, 10);
    if (!Number.isFinite(pos) || !chrom) {
      stats.skipped_malformed += 1;
      continue;
    }
    rows.push({ marker_id, chrom, pos, genotype, genotype_norm: normalizeGenotype(genotype) });
  }
  stats.parsed_snps = rows.length;
  return { rows, stats };
}

function rowsToTsv(rows, columns) {
  const escapeCell = (value) => String(value ?? "").replaceAll("\t", " ").replaceAll("\n", " ").replaceAll("\r", " ");
  return `${columns.join("\t")}\n${rows.map((row) => columns.map((col) => escapeCell(row[col])).join("\t")).join("\n")}\n`;
}

async function stage23AndMe(file) {
  const text = await file.text();
  const parsed = parse23AndMe(text);
  if (!parsed.rows.length) {
    throw new Error("No analyzable genotype rows with chromosome/position were found in the 23andMe-style file.");
  }
  const path = `${VFS_UPLOAD}/user_23andme.tsv`;
  await state.backend.webR.FS.writeFile(path, textEncoder.encode(rowsToTsv(parsed.rows, ["marker_id", "chrom", "pos", "genotype", "genotype_norm"])));
  await executeSql(`
CREATE OR REPLACE TABLE user_snps AS
SELECT
  marker_id::VARCHAR AS marker_id,
  chrom::VARCHAR AS chrom,
  CASE
    WHEN upper(CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4) ELSE chrom END) IN ('M', 'MT') THEN 'MT'
    ELSE upper(CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4) ELSE chrom END)
  END AS chrom_norm,
  pos::BIGINT AS pos,
  genotype::VARCHAR AS genotype,
  genotype_norm::VARCHAR AS genotype_norm
FROM read_csv_auto('${path}', delim='\t', header=true)
`);
  return parsed.stats;
}

function buildRiskOrderSql(alias = "risk_level") {
  return `CASE ${alias} WHEN 'high_risk' THEN 0 WHEN 'increased_risk' THEN 1 WHEN 'carrier' THEN 2 WHEN 'normal' THEN 3 ELSE 9 END`;
}

async function analyze23AndMe(file, analysisBuild) {
  const stats = await stage23AndMe(file);
  await executeSql(`
CREATE OR REPLACE TABLE analysis_matches AS
SELECT
  '23andMe'::VARCHAR AS input_kind,
  s.marker_id,
  a.annotation_id,
  a.source_id,
  s.chrom AS input_chrom,
  s.pos AS input_pos,
  NULL::VARCHAR AS sample_id,
  s.genotype AS input_genotype,
  s.genotype_norm,
  vk.variant_key,
  vk.variant_key_hex,
  a.build,
  a.gene,
  a.category,
  a.name,
  a.significance,
  a.description,
  a.risk_allele,
  a.normal_allele,
  a.source,
  a.publications,
  a.external_ids,
  a.clinvar_stars,
  a.odds_ratio,
  a.score,
  coalesce(gi.risk_level, 'normal') AS risk_level,
  coalesce(gi.interpretation, 'No genotype-specific interpretation is available for this genotype.') AS interpretation
FROM user_snps s
JOIN variant_annotations a
  ON a.build = ${sqlString(analysisBuild)}
 AND a.chrom_norm = s.chrom_norm
 AND a.pos = s.pos
LEFT JOIN genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = s.genotype_norm
LEFT JOIN variant_keys vk
  ON vk.annotation_id = a.annotation_id
 AND vk.is_primary_key
ORDER BY ${buildRiskOrderSql("coalesce(gi.risk_level, 'normal')")}, a.score DESC, a.gene, a.annotation_id
`);
  return { stats, inputKind: "23andMe" };
}

function detectInputKind(file, selectedKind) {
  if (selectedKind && selectedKind !== "auto") return selectedKind;
  const name = file.name.toLowerCase();
  if (name.endsWith(".bcf") || name.endsWith(".vcf") || name.endsWith(".vcf.gz") || name.endsWith(".bcf.gz")) {
    return "vcf_bcf";
  }
  return "23andme";
}

async function writeBrowserFile(file, vfsPath) {
  await state.backend.webR.FS.writeFile(vfsPath, new Uint8Array(await file.arrayBuffer()));
}

function selectedOptionalFile(id) {
  const input = nodes[id];
  return input?.files?.[0] || null;
}

async function stageLiftoverFile(inputId, targetName) {
  const file = selectedOptionalFile(inputId);
  if (!file) return null;
  const path = `${VFS_UPLOAD}/${targetName}_${sanitizeFilename(file.name)}`;
  await writeBrowserFile(file, path);
  return path;
}

function genotypeSqlFromAlleles() {
  return `
CASE
  WHEN allele_a IS NOT NULL AND allele_b IS NOT NULL AND length(allele_a) = 1 AND length(allele_b) = 1
  THEN least(upper(allele_a), upper(allele_b)) || greatest(upper(allele_a), upper(allele_b))
  ELSE coalesce(gt, '')
END`;
}

async function analyzeVcfBcf(file, inputBuild, analysisBuild, liftoverMode) {
  const filePath = `${VFS_UPLOAD}/${sanitizeFilename(file.name, "upload.vcf")}`;
  await writeBrowserFile(file, filePath);
  await runR(`Rduckhts::rduckhts_bcf(con, 'user_variants_raw', ${rString(filePath)}, tidy_format = TRUE, overwrite = TRUE)`);

  const needsLiftover = inputBuild !== analysisBuild && inputBuild !== "other";
  let sourceSql = `
SELECT
  coalesce(SAMPLE_ID, '')::VARCHAR AS sample_id,
  coalesce(GT, '')::VARCHAR AS gt,
  CHROM::VARCHAR AS input_chrom,
  POS::BIGINT AS input_pos,
  REF::VARCHAR AS input_ref,
  ALT::VARCHAR AS input_alt,
  CHROM::VARCHAR AS chrom,
  POS::BIGINT AS pos,
  REF::VARCHAR AS ref,
  ALT::VARCHAR AS alt,
  TRUE AS mapped,
  NULL::VARCHAR AS reject_reason
FROM user_variants_raw
`;

  if (needsLiftover) {
    if (liftoverMode === "off") {
      throw new Error("Input build differs from the analysis build. Enable liftover or choose the matching analysis build.");
    }
    const chainPath = await stageLiftoverFile("chain-file", "chain");
    const srcRefPath = await stageLiftoverFile("src-ref-file", "src_ref");
    const dstRefPath = await stageLiftoverFile("dst-ref-file", "dst_ref");
    if (!chainPath || !srcRefPath || !dstRefPath) {
      throw new Error("Liftover requires chain, source FASTA, and destination FASTA files. These remain local in the browser VFS.");
    }
    sourceSql = `
WITH lifted AS (
  SELECT
    coalesce(SAMPLE_ID, '')::VARCHAR AS sample_id,
    coalesce(GT, '')::VARCHAR AS gt,
    CHROM::VARCHAR AS input_chrom,
    POS::BIGINT AS input_pos,
    REF::VARCHAR AS input_ref,
    ALT::VARCHAR AS input_alt,
    bcftools_liftover(
      CHROM, POS, REF, ALT,
      ${sqlString(chainPath)}, ${sqlString(dstRefPath)}, ${sqlString(srcRefPath)},
      1, 250, false, NULL::BIGINT, false
    ) AS lo
  FROM user_variants_raw
)
SELECT
  sample_id,
  gt,
  input_chrom,
  input_pos,
  input_ref,
  input_alt,
  lo.dest_chrom::VARCHAR AS chrom,
  lo.dest_pos::BIGINT AS pos,
  lo.dest_ref::VARCHAR AS ref,
  lo.dest_alt::VARCHAR AS alt,
  lo.mapped AS mapped,
  lo.reject_reason::VARCHAR AS reject_reason
FROM lifted
`;
  }

  await executeSql(`
CREATE OR REPLACE TABLE user_variant_keyed AS
WITH source_rows AS (${sourceSql}),
filtered AS (
  SELECT *
  FROM source_rows
  WHERE mapped
    AND chrom IS NOT NULL
    AND pos IS NOT NULL
    AND ref IS NOT NULL
    AND alt IS NOT NULL
    AND NOT contains(alt, ',')
), gt_parts AS (
  SELECT
    *,
    regexp_extract(gt, '^([0-9.]+)', 1) AS gt_a,
    regexp_extract(gt, '^[0-9.]+[/|]([0-9.]+)', 1) AS gt_b
  FROM filtered
), allele_calls AS (
  SELECT
    *,
    CASE gt_a WHEN '0' THEN ref WHEN '1' THEN alt ELSE NULL END AS allele_a,
    CASE gt_b WHEN '0' THEN ref WHEN '1' THEN alt ELSE NULL END AS allele_b
  FROM gt_parts
)
SELECT
  sample_id,
  gt AS input_genotype,
  input_chrom,
  input_pos,
  input_ref,
  input_alt,
  chrom,
  CASE
    WHEN upper(CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4) ELSE chrom END) IN ('M', 'MT') THEN 'MT'
    ELSE upper(CASE WHEN starts_with(lower(chrom), 'chr') THEN substr(chrom, 4) ELSE chrom END)
  END AS chrom_norm,
  pos,
  ref,
  alt,
  ${genotypeSqlFromAlleles()} AS genotype_norm,
  variantkey(chrom, pos, ref, alt) AS variant_key,
  variantkey_hex(variantkey(chrom, pos, ref, alt)) AS variant_key_hex
FROM allele_calls
`);

  await executeSql(`
CREATE OR REPLACE TABLE analysis_matches AS
SELECT
  'VCF/BCF'::VARCHAR AS input_kind,
  NULL::VARCHAR AS marker_id,
  a.annotation_id,
  a.source_id,
  k.input_chrom,
  k.input_pos,
  k.sample_id,
  k.input_genotype,
  k.genotype_norm,
  k.variant_key,
  k.variant_key_hex,
  a.build,
  a.gene,
  a.category,
  a.name,
  a.significance,
  a.description,
  a.risk_allele,
  a.normal_allele,
  a.source,
  a.publications,
  a.external_ids,
  a.clinvar_stars,
  a.odds_ratio,
  a.score,
  coalesce(gi.risk_level, 'normal') AS risk_level,
  coalesce(gi.interpretation, 'No genotype-specific interpretation is available for this genotype.') AS interpretation
FROM user_variant_keyed k
JOIN variant_annotations a
  ON a.build = ${sqlString(analysisBuild)}
 AND a.chrom_norm = k.chrom_norm
 AND a.pos = k.pos
LEFT JOIN genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = k.genotype_norm
ORDER BY ${buildRiskOrderSql("coalesce(gi.risk_level, 'normal')")}, a.score DESC, a.gene, a.annotation_id
`);

  const keyedStats = await queryJson(`
SELECT
  (SELECT count(*) FROM user_variants_raw)::BIGINT AS raw_records,
  (SELECT count(*) FROM user_variant_keyed)::BIGINT AS keyed_records,
  (SELECT count(*) FROM analysis_matches)::BIGINT AS matched_records
`);
  return { stats: keyedStats[0] || {}, inputKind: "VCF/BCF" };
}

async function collectResults(context) {
  const summaryRows = await queryJson(`
SELECT
  count(*)::BIGINT AS total_variants_found,
  count(*) FILTER (WHERE category = 'health_risk')::BIGINT AS health_risk_count,
  count(*) FILTER (WHERE category = 'pharmacogenomics')::BIGINT AS pharmacogenomics_count,
  count(*) FILTER (WHERE category = 'trait')::BIGINT AS trait_count,
  count(*) FILTER (WHERE risk_level = 'high_risk')::BIGINT AS high_risk_count
FROM analysis_matches
`);
  const rows = await queryJson(`
SELECT *
FROM analysis_matches
ORDER BY ${buildRiskOrderSql()}, score DESC, category, gene, annotation_id
LIMIT 1000
`);
  const summary = summaryRows[0] || {};
  state.lastRows = rows;
  state.lastSummary = { ...summary, ...context };
  return { summary: state.lastSummary, rows };
}

function categoryLabel(category) {
  return {
    health_risk: "Health risks",
    pharmacogenomics: "Pharmacogenomics",
    trait: "Traits",
  }[category] || category;
}

function riskBadge(risk) {
  const cls = riskClasses[risk] || "secondary";
  return `<span class="badge text-bg-${cls}">${escapeHtml(String(risk || "unknown").replaceAll("_", " "))}</span>`;
}

function externalLinks(row) {
  const links = [];
  if (/^rs\d+$/i.test(row.source_id || "")) links.push(`<a href="https://www.ncbi.nlm.nih.gov/snp/${escapeHtml(row.source_id)}" target="_blank" rel="noopener">dbSNP</a>`);
  if (/^rs\d+$/i.test(row.source_id || "")) links.push(`<a href="https://www.snpedia.com/index.php/${escapeHtml(row.source_id)}" target="_blank" rel="noopener">SNPedia</a>`);
  if (row.gene) links.push(`<a href="https://www.ncbi.nlm.nih.gov/gene/?term=${encodeURIComponent(row.gene)}" target="_blank" rel="noopener">NCBI Gene</a>`);
  return links.join(" · ");
}

function renderStats(summary) {
  const stats = summary.stats || {};
  if (summary.inputKind === "23andMe") {
    return `${Number(stats.parsed_snps || 0).toLocaleString()} SNP rows parsed; ${Number(stats.skipped_no_call || 0).toLocaleString()} no-calls skipped.`;
  }
  return `${Number(stats.raw_records || 0).toLocaleString()} raw records; ${Number(stats.keyed_records || 0).toLocaleString()} VariantKey rows; ${Number(stats.matched_records || 0).toLocaleString()} curated matches.`;
}

function renderTable(rows, category) {
  const filtered = rows.filter((row) => row.category === category);
  if (!filtered.length) {
    return `<p class="text-muted mb-0">No ${escapeHtml(categoryLabel(category).toLowerCase())} matches in the current asset bundle.</p>`;
  }
  const body = filtered.map((row, idx) => `
<tr>
  <td>${riskBadge(row.risk_level)}</td>
  <td><strong>${escapeHtml(row.gene)}</strong><br><span class="text-muted small">${escapeHtml(row.source_id || row.annotation_id)}</span></td>
  <td>${escapeHtml(row.name)}</td>
  <td><code>${escapeHtml(row.input_genotype || row.genotype_norm)}</code><br><span class="text-muted small">norm ${escapeHtml(row.genotype_norm)}</span></td>
  <td>${escapeHtml(row.significance?.replaceAll("_", " "))}<br><span class="text-muted small">score ${escapeHtml(row.score)}</span></td>
  <td>
    <button class="btn btn-sm btn-outline-dark" type="button" data-bs-toggle="collapse" data-bs-target="#detail-${category}-${idx}">Details</button>
  </td>
</tr>
<tr class="collapse-row">
  <td colspan="6" class="p-0 border-0">
    <div class="collapse" id="detail-${category}-${idx}">
      <div class="p-3 bg-light border-bottom">
        <div class="row g-3">
          <div class="col-lg-7">
            <h6>Interpretation</h6>
            <p>${escapeHtml(row.interpretation)}</p>
            <h6>Description</h6>
            <p class="mb-0">${escapeHtml(row.description)}</p>
          </div>
          <div class="col-lg-5 small">
            <dl class="row mb-2">
              <dt class="col-5">VariantKey</dt><dd class="col-7"><code>${escapeHtml(row.variant_key_hex)}</code></dd>
              <dt class="col-5">Build</dt><dd class="col-7">${escapeHtml(row.build)}</dd>
              <dt class="col-5">Input locus</dt><dd class="col-7">${escapeHtml(row.input_chrom)}:${escapeHtml(row.input_pos)}</dd>
              <dt class="col-5">Alleles</dt><dd class="col-7">normal ${escapeHtml(row.normal_allele)} · risk/effect ${escapeHtml(row.risk_allele)}</dd>
              <dt class="col-5">Source</dt><dd class="col-7">${escapeHtml(row.source)}</dd>
              <dt class="col-5">PMIDs</dt><dd class="col-7">${escapeHtml(row.publications || "")}</dd>
            </dl>
            <div>${externalLinks(row)}</div>
          </div>
        </div>
      </div>
    </div>
  </td>
</tr>`).join("");

  return `
<div class="table-responsive">
  <table class="table table-hover align-middle">
    <thead>
      <tr>
        <th>Risk</th><th>Gene / source</th><th>Variant</th><th>Your genotype</th><th>Evidence</th><th></th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

function renderResults(summary, rows) {
  const total = Number(summary.total_variants_found || 0);
  const categories = ["health_risk", "pharmacogenomics", "trait"];
  const categoryTabs = categories.map((category, idx) => `
<li class="nav-item" role="presentation">
  <button class="nav-link ${idx === 0 ? "active" : ""}" id="${category}-tab" data-bs-toggle="tab" data-bs-target="#${category}-pane" type="button" role="tab">
    ${categoryLabel(category)} <span class="badge text-bg-secondary ms-1">${Number(summary[`${category === "health_risk" ? "health_risk" : category}_count`] || 0)}</span>
  </button>
</li>`).join("");
  const panes = categories.map((category, idx) => `
<div class="tab-pane fade ${idx === 0 ? "show active" : ""}" id="${category}-pane" role="tabpanel" aria-labelledby="${category}-tab">
  ${renderTable(rows, category)}
</div>`).join("");

  nodes.results.innerHTML = `
<section class="my-4">
  <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
    <div>
      <h2 class="h3 mb-1">Analysis results</h2>
      <p class="text-muted mb-0">${escapeHtml(renderStats(summary))}</p>
    </div>
    <div class="text-end small text-muted">
      Input: ${escapeHtml(summary.inputKind)}<br>
      Analysis build: ${escapeHtml(summary.analysisBuild)}
    </div>
  </div>

  <div class="row g-3 mb-4">
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Curated matches</div><div class="display-6">${total.toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">High risk</div><div class="display-6 text-danger">${Number(summary.high_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Health</div><div class="display-6">${Number(summary.health_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Pharma + traits</div><div class="display-6">${(Number(summary.pharmacogenomics_count || 0) + Number(summary.trait_count || 0)).toLocaleString()}</div></div></div></div>
  </div>

  <ul class="nav nav-tabs" role="tablist">${categoryTabs}</ul>
  <div class="tab-content border border-top-0 p-3 bg-white">${panes}</div>
</section>`;
  nodes["download-button"].disabled = rows.length === 0;
}

async function analyzeSelectedFile(file) {
  clearMessage();
  setBusy(true, "Analyzing...");
  try {
    await stageAssets();
    const inputKind = detectInputKind(file, nodes["input-kind"].value);
    const inputBuild = nodes["input-build"].value;
    const analysisBuild = nodes["analysis-build"].value;
    const supported = manifestBuilds(await fetchManifest());
    if (!supported.includes(analysisBuild)) {
      throw new Error(`No curated Parquet bundle is available for ${analysisBuild}. Rebuild assets or choose one of: ${supported.join(", ")}.`);
    }

    const context = inputKind === "23andme"
      ? await analyze23AndMe(file, analysisBuild)
      : await analyzeVcfBcf(file, inputBuild, analysisBuild, nodes["liftover-mode"].value);

    const { summary, rows } = await collectResults({ ...context, analysisBuild });
    renderResults(summary, rows);
    setStatus("Analysis complete. Results were generated locally in browser DuckDB.", "success");
  } catch (error) {
    console.error(error);
    showMessage(error.message ?? String(error), "danger");
    setStatus("Analysis failed. See message above.", "danger");
  } finally {
    setBusy(false);
  }
}

function downloadLastRows() {
  if (!state.lastRows.length) return;
  const columns = [
    "input_kind", "sample_id", "marker_id", "annotation_id", "source_id", "gene", "category", "name", "input_genotype", "genotype_norm",
    "risk_level", "significance", "score", "variant_key_hex", "build", "interpretation",
  ];
  const tsv = rowsToTsv(state.lastRows, columns);
  const blob = new Blob([tsv], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "duckgenesnap_results.tsv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetUi() {
  nodes.results.innerHTML = "";
  nodes.messages.innerHTML = "";
  nodes["file-input"].value = "";
  nodes["download-button"].disabled = true;
  state.lastRows = [];
  state.lastSummary = null;
  setStatus("Ready. Choose a 23andMe text file or VCF/BCF and analyze locally.", "secondary");
}

async function loadDemo() {
  const response = await fetch(DEMO_23ANDME, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not fetch ${DEMO_23ANDME}`);
  const blob = await response.blob();
  const file = new File([blob], "example_23andme.txt", { type: "text/plain" });
  nodes["input-kind"].value = "23andme";
  await analyzeSelectedFile(file);
}

function updateLiftoverVisibility() {
  const show = nodes["liftover-mode"].value !== "off";
  nodes["liftover-card"].hidden = !show;
}

function bindEvents() {
  nodes["analyze-button"].addEventListener("click", async () => {
    const file = nodes["file-input"].files?.[0];
    if (!file) {
      showMessage("Choose a local file first, or load the demo.", "warning");
      return;
    }
    await analyzeSelectedFile(file);
  });
  nodes["demo-button"].addEventListener("click", async () => {
    clearMessage();
    setBusy(true, "Loading demo...");
    try {
      await loadDemo();
    } catch (error) {
      showMessage(error.message ?? String(error), "danger");
    } finally {
      setBusy(false);
    }
  });
  nodes["reset-button"].addEventListener("click", resetUi);
  nodes["download-button"].addEventListener("click", downloadLastRows);
  nodes["liftover-mode"].addEventListener("change", updateLiftoverVisibility);
}

async function main() {
  initNodes();
  bindEvents();
  updateLiftoverVisibility();
  resetUi();
  try {
    await populateBuildSelectors();
  } catch (error) {
    showMessage(error.message ?? String(error), "danger");
  }
}

main();
