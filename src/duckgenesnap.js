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
  currentSearch: "",
  timings: [],
  operation: {
    modal: null,
    active: null,
  },
};

const nodes = {};

const riskOrder = {
  high_risk: 0,
  increased_risk: 1,
  carrier: 2,
  drug_response: 3,
  annotation_match: 4,
  normal: 5,
};

const riskClasses = {
  high_risk: "danger",
  increased_risk: "warning",
  carrier: "info",
  drug_response: "primary",
  annotation_match: "secondary",
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
    "chain-url",
    "src-ref-file",
    "src-ref-url",
    "dst-ref-file",
    "dst-ref-url",
    "analyze-button",
    "demo-button",
    "reset-button",
    "results",
    "messages",
    "timing-card",
    "timing-list",
    "operation-modal",
    "operation-modal-title",
    "operation-modal-detail",
    "operation-modal-state",
    "operation-modal-elapsed",
    "operation-modal-spinner",
  ].forEach((id) => {
    nodes[id] = byId(id);
  });
  if (nodes["operation-modal"] && window.bootstrap?.Modal) {
    state.operation.modal = new window.bootstrap.Modal(
      nodes["operation-modal"],
    );
  }
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

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 2)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderTimingList(active = null) {
  if (!nodes["timing-list"]) return;
  const doneRows = state.timings.map((step) => `
<div class="d-flex justify-content-between gap-2 border-bottom py-1">
  <span>${escapeHtml(step.label)}</span>
  <span class="text-${step.success ? "success" : "danger"}">${escapeHtml(formatDuration(step.durationMs))}</span>
</div>`).join("");
  const activeRow = active ? `
<div class="d-flex justify-content-between gap-2 border-bottom py-1">
  <span><span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>${escapeHtml(active.label)}</span>
  <span>${escapeHtml(formatDuration(performance.now() - active.startedAt))}</span>
</div>` : "";
  nodes["timing-list"].innerHTML = (doneRows || activeRow)
    ? `${doneRows}${activeRow}`
    : "Step timings appear here after analysis starts.";
}

function resetTimings() {
  state.timings = [];
  if (nodes["timing-card"]) nodes["timing-card"].hidden = false;
  renderTimingList();
}

function recordTiming(label, detail, durationMs, success = true) {
  state.timings.push({ label, detail, durationMs, success });
  renderTimingList();
}

function refreshOperationElapsed() {
  const op = state.operation.active;
  if (!op) return;
  const elapsed = performance.now() - op.startedAt;
  if (nodes["operation-modal-elapsed"]) {
    nodes["operation-modal-elapsed"].textContent = formatDuration(elapsed);
  }
  renderTimingList(op);
}

function beginOperation({ label, detail }) {
  const current = state.operation.active;
  if (current?.timerId) clearInterval(current.timerId);
  const op = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    label,
    detail,
    startedAt: performance.now(),
    timerId: null,
  };
  state.operation.active = op;
  if (nodes["operation-modal-title"]) nodes["operation-modal-title"].textContent = label;
  if (nodes["operation-modal-detail"]) nodes["operation-modal-detail"].textContent = detail;
  if (nodes["operation-modal-state"]) {
    nodes["operation-modal-state"].textContent = "Running";
    nodes["operation-modal-state"].className = "";
  }
  if (nodes["operation-modal-spinner"]) {
    nodes["operation-modal-spinner"].className = "spinner-border text-dark me-3 mt-1";
  }
  if (nodes["operation-modal-elapsed"]) nodes["operation-modal-elapsed"].textContent = "0 ms";
  state.operation.modal?.show();
  op.timerId = setInterval(refreshOperationElapsed, 100);
  renderTimingList(op);
  return op.id;
}

function updateOperationDetail(detail, label = null) {
  const op = state.operation.active;
  if (!op) return;
  if (label) {
    op.label = label;
    if (nodes["operation-modal-title"]) nodes["operation-modal-title"].textContent = label;
  }
  op.detail = detail;
  if (nodes["operation-modal-detail"]) nodes["operation-modal-detail"].textContent = detail;
  refreshOperationElapsed();
}

async function finishOperation(operationId, { success, summary }) {
  const op = state.operation.active;
  if (!op || op.id !== operationId) return 0;
  if (op.timerId) clearInterval(op.timerId);
  const durationMs = performance.now() - op.startedAt;
  if (nodes["operation-modal-elapsed"]) {
    nodes["operation-modal-elapsed"].textContent = formatDuration(durationMs);
  }
  if (nodes["operation-modal-state"]) {
    nodes["operation-modal-state"].textContent = success ? "Completed" : "Failed";
    nodes["operation-modal-state"].className = success ? "text-success" : "text-danger";
  }
  if (nodes["operation-modal-detail"]) {
    nodes["operation-modal-detail"].textContent = `${summary} (${formatDuration(durationMs)})`;
  }
  if (nodes["operation-modal-spinner"]) {
    nodes["operation-modal-spinner"].className = success
      ? "bi bi-check-circle-fill text-success me-3 mt-1"
      : "bi bi-exclamation-triangle-fill text-danger me-3 mt-1";
  }
  recordTiming(op.label, summary, durationMs, success);
  await sleep(success ? 250 : 900);
  state.operation.modal?.hide();
  state.operation.active = null;
  renderTimingList();
  return durationMs;
}

async function runTimedStep({ label, detail, successSummary, failureSummary }, fn) {
  const operationId = beginOperation({ label, detail });
  try {
    const result = await fn(updateOperationDetail);
    await finishOperation(operationId, {
      success: true,
      summary: successSummary || detail,
    });
    return result;
  } catch (error) {
    await finishOperation(operationId, {
      success: false,
      summary: `${failureSummary || "Step failed"}: ${error.message ?? String(error)}`,
    });
    throw error;
  }
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
  const assetEntries = [
    "variant_annotations.parquet",
    "genotype_interpretations.parquet",
    "variant_keys.parquet",
  ];

  for (const filename of assetEntries) {
    const url = `${DATA_BASE}/${filename}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to fetch asset ${url}`);
    await state.backend.webR.FS.writeFile(
      `${VFS_DATA}/${filename}`,
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  await executeSql(`CREATE OR REPLACE VIEW variant_annotations AS SELECT * FROM read_parquet('${VFS_DATA}/variant_annotations.parquet')`);
  await executeSql(`CREATE OR REPLACE VIEW genotype_interpretations AS SELECT * FROM read_parquet('${VFS_DATA}/genotype_interpretations.parquet')`);
  await executeSql(`CREATE OR REPLACE VIEW variant_keys AS SELECT * FROM read_parquet('${VFS_DATA}/variant_keys.parquet')`);
  setAssetStatus(`Loaded Parquet annotations: ${manifest.counts?.variant_annotations ?? "?"} locus rows.`, "success");

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
    WHEN upper(CASE WHEN starts_with(lower(chrom::VARCHAR), 'chr') THEN substr(chrom::VARCHAR, 4) ELSE chrom::VARCHAR END) IN ('M', 'MT') THEN 'MT'
    ELSE upper(CASE WHEN starts_with(lower(chrom::VARCHAR), 'chr') THEN substr(chrom::VARCHAR, 4) ELSE chrom::VARCHAR END)
  END AS chrom_norm,
  pos::BIGINT AS pos,
  genotype::VARCHAR AS genotype,
  genotype_norm::VARCHAR AS genotype_norm
FROM read_csv_auto('${path}', delim='\t', header=true)
`);
  return parsed.stats;
}

function buildRiskOrderSql(alias = "risk_level") {
  return `CASE ${alias} WHEN 'high_risk' THEN 0 WHEN 'increased_risk' THEN 1 WHEN 'carrier' THEN 2 WHEN 'drug_response' THEN 3 WHEN 'annotation_match' THEN 4 WHEN 'normal' THEN 5 ELSE 9 END`;
}

function annotationRiskSql() {
  return `coalesce(gi.risk_level, CASE
    WHEN a.significance = 'pathogenic' THEN 'high_risk'
    WHEN a.significance = 'likely_pathogenic' THEN 'increased_risk'
    WHEN a.significance = 'drug_response' THEN 'drug_response'
    WHEN a.significance = 'risk_factor' THEN 'increased_risk'
    ELSE 'annotation_match'
  END)`;
}

function annotationInterpretationSql() {
  return `coalesce(gi.interpretation, CASE
    WHEN a.significance IN ('pathogenic', 'likely_pathogenic') THEN
      'Input genotype matched a ClinVar pathogenicity locus. This is not medical advice; confirm with clinical-grade testing.'
    WHEN a.significance = 'drug_response' THEN
      'Input genotype matched a ClinVar drug-response locus. Discuss medication relevance with a qualified clinician or pharmacist.'
    ELSE
      'Input genotype matched this annotation locus. No genotype-specific interpretation is available.'
  END)`;
}

async function analyze23AndMe(file, analysisBuild) {
  const stats = await runTimedStep({
    label: "Parse 23andMe text",
    detail: "Reading chip-style genotype rows and staging them in DuckDB.",
    successSummary: "23andMe-style rows were parsed",
    failureSummary: "Could not parse 23andMe file",
  }, () => stage23AndMe(file));
  await runTimedStep({
    label: "Join annotation assets",
    detail: "Joining upload loci against ClinVar/GWAS Parquet annotations.",
    successSummary: "Annotation join completed",
    failureSummary: "Could not join annotations",
  }, async () => {
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
  ${annotationRiskSql()} AS risk_level,
  ${annotationInterpretationSql()} AS interpretation
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
ORDER BY ${buildRiskOrderSql(annotationRiskSql())}, a.score DESC, a.gene, a.annotation_id
`);
  });
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
  const input = byId(id) || nodes[id];
  return input?.files?.[0] || null;
}

async function stageLiftoverAsset(inputId, urlId, targetName) {
  const file = selectedOptionalFile(inputId);
  if (file) {
    const path = `${VFS_UPLOAD}/${targetName}_${sanitizeFilename(file.name)}`;
    await writeBrowserFile(file, path);
    return path;
  }

  const url = (byId(urlId) || nodes[urlId])?.value?.trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`Invalid liftover URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Liftover URL must use http(s): ${url}`);
  }
  const filename = sanitizeFilename(parsed.pathname.split("/").pop(), `${targetName}.dat`);
  const path = `${VFS_UPLOAD}/${targetName}_${filename}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  await state.backend.webR.FS.writeFile(
    path,
    new Uint8Array(await response.arrayBuffer()),
  );
  return path;
}

function findSchemaColumn(schema, candidates) {
  const wanted = candidates.map((value) => String(value).toLowerCase());
  return schema.find((row) => wanted.includes(String(row.column_name).toLowerCase())) || null;
}

function columnExpression(schema, candidates, castType, fallback = null) {
  const column = findSchemaColumn(schema, candidates);
  if (!column) return fallback || `NULL::${castType}`;
  return `${sqlIdentifier(column.column_name)}::${castType}`;
}

function vcfColumnExpressions(schema) {
  const missingRequired = ["CHROM", "POS", "REF", "ALT"].filter(
    (name) => !findSchemaColumn(schema, [name]),
  );
  if (missingRequired.length) {
    throw new Error(
      `Rduckhts did not expose required VCF columns: ${missingRequired.join(", ")}.`,
    );
  }
  const altColumn = findSchemaColumn(schema, ["ALT"]);
  const altIdent = sqlIdentifier(altColumn.column_name);
  const gtColumn = findSchemaColumn(schema, ["FORMAT_GT", "GT", "GENOTYPE"]);
  const altType = String(altColumn.column_type || "").toUpperCase();
  const altIsList = altType.includes("[]") || altType.startsWith("LIST");
  return {
    sampleSql: columnExpression(schema, ["SAMPLE_ID", "SAMPLE", "sample_id"], "VARCHAR", "''::VARCHAR"),
    gtSql: gtColumn ? `${sqlIdentifier(gtColumn.column_name)}::VARCHAR` : "''::VARCHAR",
    hasGtSql: gtColumn ? "TRUE" : "FALSE",
    chromSql: columnExpression(schema, ["CHROM", "#CHROM"], "VARCHAR"),
    posSql: columnExpression(schema, ["POS"], "BIGINT"),
    refSql: columnExpression(schema, ["REF"], "VARCHAR"),
    altSql: altIsList ? `${altIdent}[1]::VARCHAR` : `${altIdent}::VARCHAR`,
    altCountSql: altIsList
      ? `coalesce(array_length(${altIdent}), 0)`
      : `CASE WHEN contains(${altIdent}::VARCHAR, ',') THEN 2 ELSE 1 END`,
  };
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
  await runTimedStep({
    label: "Read VCF/BCF",
    detail: "Staging the upload and parsing records with Rduckhts.",
    successSummary: "VCF/BCF records are available in DuckDB",
    failureSummary: "Could not read VCF/BCF",
  }, async () => {
    await writeBrowserFile(file, filePath);
    await runR(`Rduckhts::rduckhts_bcf(con, 'user_variants_raw', ${rString(filePath)}, tidy_format = TRUE, overwrite = TRUE)`);
  });

  const rawSchema = await queryJson(`DESCRIBE ${sqlIdentifier("user_variants_raw")}`);
  const raw = vcfColumnExpressions(rawSchema);
  const needsLiftover = inputBuild !== analysisBuild;
  let sourceSql = `
SELECT
  ${raw.sampleSql} AS sample_id,
  ${raw.gtSql} AS gt,
  ${raw.hasGtSql} AS has_gt,
  ${raw.chromSql} AS input_chrom,
  ${raw.posSql} AS input_pos,
  ${raw.refSql} AS input_ref,
  ${raw.altSql} AS input_alt,
  ${raw.chromSql} AS chrom,
  ${raw.posSql} AS pos,
  ${raw.refSql} AS ref,
  ${raw.altSql} AS alt,
  ${raw.altCountSql} AS alt_count,
  TRUE AS mapped,
  NULL::VARCHAR AS reject_reason
FROM user_variants_raw
`;

  if (needsLiftover) {
    if (liftoverMode === "off") {
      throw new Error("Input build differs from the analysis build. Enable liftover or choose the matching analysis build.");
    }
    const chainPath = await stageLiftoverAsset("chain-file", "chain-url", "chain");
    const srcRefPath = await stageLiftoverAsset("src-ref-file", "src-ref-url", "src_ref");
    const dstRefPath = await stageLiftoverAsset("dst-ref-file", "dst-ref-url", "dst_ref");
    if (!chainPath || !srcRefPath || !dstRefPath) {
      throw new Error("Liftover requires chain, source FASTA, and destination FASTA files. These remain local in the browser VFS.");
    }
    sourceSql = `
WITH raw_single_alt AS (
  SELECT
    ${raw.sampleSql} AS sample_id,
    ${raw.gtSql} AS gt,
    ${raw.hasGtSql} AS has_gt,
    ${raw.chromSql} AS input_chrom,
    ${raw.posSql} AS input_pos,
    ${raw.refSql} AS input_ref,
    ${raw.altSql} AS input_alt,
    ${raw.chromSql} AS chrom,
    ${raw.posSql} AS pos,
    ${raw.refSql} AS ref,
    ${raw.altSql} AS alt
  FROM user_variants_raw
  WHERE ${raw.altCountSql} = 1
    AND regexp_matches(upper(${raw.refSql}), '^[ACGT]+$')
    AND regexp_matches(upper(${raw.altSql}), '^[ACGT]+$')
), lifted AS (
  SELECT
    sample_id,
    gt,
    has_gt,
    input_chrom,
    input_pos,
    input_ref,
    input_alt,
    bcftools_liftover(
      chrom, pos, ref, alt,
      ${sqlString(chainPath)}, ${sqlString(dstRefPath)}, ${sqlString(srcRefPath)},
      1, 250, false, NULL::BIGINT, false
    ) AS lo
  FROM raw_single_alt
)
SELECT
  sample_id,
  gt,
  has_gt,
  input_chrom,
  input_pos,
  input_ref,
  input_alt,
  lo.dest_chrom::VARCHAR AS chrom,
  lo.dest_pos::BIGINT AS pos,
  lo.dest_ref::VARCHAR AS ref,
  lo.dest_alt::VARCHAR AS alt,
  1::BIGINT AS alt_count,
  lo.mapped AS mapped,
  lo.reject_reason::VARCHAR AS reject_reason
FROM lifted
`;
  }

  await runTimedStep({
    label: needsLiftover ? "Liftover and key variants" : "Normalize and key variants",
    detail: needsLiftover
      ? "Lifting single-ALT VCF records, normalizing chromosomes, and computing VariantKeys."
      : "Normalizing chromosomes, filtering single-ALT records, and computing VariantKeys.",
    successSummary: "Upload variants were normalized for locus joins",
    failureSummary: "Could not normalize variants",
  }, async () => {
    await executeSql(`
CREATE OR REPLACE TABLE user_variant_source AS
${sourceSql}
`);
    await executeSql(`
CREATE OR REPLACE TABLE user_variant_keyed AS
WITH filtered AS (
  SELECT *
  FROM user_variant_source
  WHERE mapped
    AND chrom IS NOT NULL
    AND pos IS NOT NULL
    AND ref IS NOT NULL
    AND alt IS NOT NULL
    AND alt_count = 1
    AND NOT contains(alt, ',')
    AND regexp_matches(upper(ref), '^[ACGT]+$')
    AND regexp_matches(upper(alt), '^[ACGT]+$')
    AND (
      NOT has_gt
      OR coalesce(regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'), false)
    )
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
  });

  await runTimedStep({
    label: "Join annotation assets",
    detail: "Joining upload loci against ClinVar/GWAS Parquet annotations.",
    successSummary: "Annotation join completed",
    failureSummary: "Could not join annotations",
  }, async () => {
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
  ${annotationRiskSql()} AS risk_level,
  ${annotationInterpretationSql()} AS interpretation
FROM user_variant_keyed k
JOIN variant_annotations a
  ON a.build = ${sqlString(analysisBuild)}
 AND a.chrom_norm = k.chrom_norm
 AND a.pos = k.pos
LEFT JOIN genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = k.genotype_norm
ORDER BY ${buildRiskOrderSql(annotationRiskSql())}, a.score DESC, a.gene, a.annotation_id
`);
  });

  const keyedStats = await queryJson(`
SELECT
  (SELECT count(*) FROM user_variants_raw)::BIGINT AS raw_records,
  (SELECT count(*) FROM user_variant_source)::BIGINT AS source_records,
  (
    SELECT count(*) FROM user_variant_source
    WHERE mapped
      AND chrom IS NOT NULL
      AND pos IS NOT NULL
      AND ref IS NOT NULL
      AND alt IS NOT NULL
      AND alt_count = 1
      AND NOT contains(alt, ',')
      AND regexp_matches(upper(ref), '^[ACGT]+$')
      AND regexp_matches(upper(alt), '^[ACGT]+$')
  )::BIGINT AS allele_usable_records,
  (
    SELECT count(*) FROM user_variant_source
    WHERE has_gt
      AND mapped
      AND chrom IS NOT NULL
      AND pos IS NOT NULL
      AND ref IS NOT NULL
      AND alt IS NOT NULL
      AND alt_count = 1
      AND NOT contains(alt, ',')
      AND regexp_matches(upper(ref), '^[ACGT]+$')
      AND regexp_matches(upper(alt), '^[ACGT]+$')
      AND NOT coalesce(regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'), false)
  )::BIGINT AS skipped_non_alt_gt,
  (SELECT count(*) FROM user_variant_keyed)::BIGINT AS keyed_records,
  (SELECT count(*) FROM analysis_matches)::BIGINT AS matched_records
`);
  return { stats: keyedStats[0] || {}, inputKind: "VCF/BCF" };
}

function resultSearchWhere(searchText = "") {
  const term = String(searchText || "").trim();
  if (!term) return "";
  const pattern = sqlString(`%${term.toLowerCase()}%`);
  return `WHERE lower(
    coalesce(gene, '') || ' ' ||
    coalesce(source_id, '') || ' ' ||
    coalesce(annotation_id, '') || ' ' ||
    coalesce(name, '') || ' ' ||
    coalesce(significance, '') || ' ' ||
    coalesce(category, '') || ' ' ||
    coalesce(source, '') || ' ' ||
    coalesce(input_genotype, '') || ' ' ||
    coalesce(genotype_norm, '')
  ) LIKE ${pattern}`;
}

function resultOrderSql() {
  return `${buildRiskOrderSql()}, score DESC, category, gene, annotation_id`;
}

async function collectResults(context, searchText = "") {
  const whereSql = resultSearchWhere(searchText);
  const summaryRows = await queryJson(`
SELECT
  count(*)::BIGINT AS total_variants_found,
  count(*) FILTER (WHERE category = 'health_risk')::BIGINT AS health_risk_count,
  count(*) FILTER (WHERE category = 'pharmacogenomics')::BIGINT AS pharmacogenomics_count,
  count(*) FILTER (WHERE category = 'trait')::BIGINT AS trait_count,
  count(*) FILTER (WHERE risk_level = 'high_risk')::BIGINT AS high_risk_count
FROM analysis_matches
${whereSql}
`);
  const rows = await queryJson(`
SELECT *
FROM analysis_matches
${whereSql}
ORDER BY ${resultOrderSql()}
LIMIT 1000
`);
  const summary = summaryRows[0] || {};
  state.currentSearch = String(searchText || "").trim();
  state.lastRows = rows;
  state.lastSummary = { ...summary, ...context, searchText: state.currentSearch };
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
  return `${Number(stats.raw_records || 0).toLocaleString()} raw records; ${Number(stats.keyed_records || 0).toLocaleString()} called alternate VariantKey rows; ${Number(stats.matched_records || 0).toLocaleString()} curated matches; ${Number(stats.skipped_non_alt_gt || 0).toLocaleString()} hom-ref/no-call records skipped.`;
}

function renderTimings() {
  if (!state.timings.length) return "";
  const rows = state.timings.map((step) => `
<tr>
  <td>${escapeHtml(step.label)}</td>
  <td>${escapeHtml(step.detail)}</td>
  <td class="text-end ${step.success ? "text-success" : "text-danger"}">${escapeHtml(formatDuration(step.durationMs))}</td>
</tr>`).join("");
  const totalMs = state.timings.reduce((sum, step) => sum + Number(step.durationMs || 0), 0);
  return `
<div class="card border-0 shadow-sm mb-4">
  <div class="card-body">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h3 class="h5 mb-0">Step timings</h3>
      <span class="badge text-bg-light">Total ${escapeHtml(formatDuration(totalMs))}</span>
    </div>
    <div class="table-responsive">
      <table class="table table-sm mb-0 align-middle">
        <thead><tr><th>Step</th><th>Details</th><th class="text-end">Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</div>`;
}

function renderTable(rows, category) {
  const filtered = rows.filter((row) => row.category === category);
  if (!filtered.length) {
    return `<p class="text-muted mb-0">No ${escapeHtml(categoryLabel(category).toLowerCase())} matches in the current annotation snapshot.</p>`;
  }
  const body = filtered.map((row, idx) => `
<tr>
  <td>${riskBadge(row.risk_level)}</td>
  <td><strong>${escapeHtml(row.gene)}</strong><br><span class="text-muted small">${escapeHtml(row.source_id || row.annotation_id)}</span></td>
  <td>${escapeHtml(row.name)}</td>
  <td><code>${escapeHtml(row.input_genotype || row.genotype_norm)}</code><br><span class="text-muted small">norm ${escapeHtml(row.genotype_norm)}</span></td>
  <td>${escapeHtml(row.significance?.replaceAll("_", " "))}<br><span class="text-muted small">priority score ${escapeHtml(row.score)}</span></td>
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
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Curated matches${summary.searchText ? " shown" : ""}</div><div class="display-6">${total.toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">High risk</div><div class="display-6 text-danger">${Number(summary.high_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Health</div><div class="display-6">${Number(summary.health_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Pharma + traits</div><div class="display-6">${(Number(summary.pharmacogenomics_count || 0) + Number(summary.trait_count || 0)).toLocaleString()}</div></div></div></div>
  </div>

  <div class="card border-0 shadow-sm mb-4">
    <div class="card-body">
      <div class="row g-2 align-items-end">
        <div class="col-lg-6">
          <label class="form-label" for="result-search">Search results with DuckDB</label>
          <input id="result-search" class="form-control" type="search" value="${escapeHtml(summary.searchText || "")}" placeholder="gene, rsID, ClinVar term, category, genotype..." />
        </div>
        <div class="col-lg-3 d-flex gap-2">
          <button id="result-search-button" type="button" class="btn btn-outline-primary">Search</button>
          <button id="result-clear-search" type="button" class="btn btn-outline-secondary">Clear</button>
        </div>
        <div class="col-lg-3 d-flex gap-2 justify-content-lg-end">
          <select id="export-format" class="form-select w-auto" aria-label="Export format">
            <option value="tsv">TSV</option>
            <option value="csv">CSV for Excel</option>
            <option value="xlsx">Excel .xlsx</option>
            <option value="parquet">Parquet</option>
          </select>
          <button id="download-button" type="button" class="btn btn-outline-success" ${total ? "" : "disabled"}>Export</button>
        </div>
      </div>
      <div class="form-text mt-2">Search and export run against the browser DuckDB <code>analysis_matches</code> table. Exports include the current search filter.</div>
    </div>
  </div>

  ${renderTimings()}
  <ul class="nav nav-tabs" role="tablist">${categoryTabs}</ul>
  <div class="tab-content border border-top-0 p-3 bg-white">${panes}</div>
</section>`;
  bindResultControls();
}

async function analyzeSelectedFile(file) {
  clearMessage();
  resetTimings();
  setBusy(true, "Analyzing...");
  try {
    if (!state.backend.ready) {
      await runTimedStep({
        label: "Start webR runtime",
        detail: "Loading webR, DuckDB, jsonlite, and Rduckhts in the browser.",
        successSummary: "Browser DuckDB + Rduckhts runtime is ready",
        failureSummary: "Runtime startup failed",
      }, () => warmBackend());
    } else {
      recordTiming("Start webR runtime", "Runtime was already ready", 0, true);
    }
    if (!state.backend.assetsReady) {
      await runTimedStep({
        label: "Load Parquet annotations",
        detail: "Fetching static Parquet assets and registering DuckDB views.",
        successSummary: "ClinVar/GWAS Parquet assets are ready",
        failureSummary: "Could not load Parquet assets",
      }, () => stageAssets());
    } else {
      recordTiming("Load Parquet annotations", "Annotation assets were already loaded", 0, true);
    }
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

    const { summary, rows } = await runTimedStep({
      label: "Summarize results",
      detail: "Collecting summary counts and table rows for display.",
      successSummary: "Result tables are ready",
      failureSummary: "Could not summarize results",
    }, () => collectResults({
      ...context,
      analysisBuild,
      timings: state.timings.slice(),
    }));
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function applyResultSearch(searchText) {
  if (!state.lastSummary) return;
  const context = {
    inputKind: state.lastSummary.inputKind,
    analysisBuild: state.lastSummary.analysisBuild,
    stats: state.lastSummary.stats,
  };
  const { summary, rows } = await runTimedStep({
    label: "Search results",
    detail: "Filtering the browser DuckDB analysis_matches table.",
    successSummary: "Search results are ready",
    failureSummary: "Could not search results",
  }, () => collectResults(context, searchText));
  renderResults(summary, rows);
}

async function exportResults() {
  if (!state.lastSummary) return;
  const format = byId("export-format")?.value || "tsv";
  const whereSql = resultSearchWhere(state.currentSearch);
  const ext = format === "parquet" ? "parquet" : format === "xlsx" ? "xlsx" : format === "csv" ? "csv" : "tsv";
  const outputPath = `${VFS_ROOT}/duckgenesnap_results_${Date.now()}.${ext}`;
  const selectSql = `SELECT * FROM analysis_matches ${whereSql} ORDER BY ${resultOrderSql()}`;
  await runTimedStep({
    label: "Export results",
    detail: `Writing ${format.toUpperCase()} from browser DuckDB.`,
    successSummary: `${format.toUpperCase()} export is ready`,
    failureSummary: "Could not export results",
  }, async () => {
    if (format === "xlsx") {
      if (!window.XLSX) {
        throw new Error("The SheetJS XLSX helper did not load; use CSV or Parquet instead.");
      }
      const rows = await queryJson(selectSql);
      const workbook = window.XLSX.utils.book_new();
      const worksheet = window.XLSX.utils.json_to_sheet(rows);
      window.XLSX.utils.book_append_sheet(workbook, worksheet, "analysis_matches");
      const bytes = window.XLSX.write(workbook, { bookType: "xlsx", type: "array" });
      downloadBlob(
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "duckgenesnap_results.xlsx",
      );
      return;
    }

    let mime = "text/tab-separated-values;charset=utf-8";
    let copyOptions = "HEADER, DELIMITER '\t'";
    if (format === "csv") {
      mime = "text/csv;charset=utf-8";
      copyOptions = "HEADER, DELIMITER ','";
    } else if (format === "parquet") {
      mime = "application/vnd.apache.parquet";
      copyOptions = "FORMAT PARQUET, COMPRESSION ZSTD";
    }
    await executeSql(`COPY (${selectSql}) TO ${sqlString(outputPath)} (${copyOptions})`);
    const bytes = await state.backend.webR.FS.readFile(outputPath);
    downloadBlob(new Blob([bytes], { type: mime }), `duckgenesnap_results.${ext}`);
  });
}

function bindResultControls() {
  const searchInput = byId("result-search");
  byId("result-search-button")?.addEventListener("click", () => {
    applyResultSearch(searchInput?.value || "");
  });
  byId("result-clear-search")?.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    applyResultSearch("");
  });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyResultSearch(searchInput.value || "");
    }
  });
  byId("download-button")?.addEventListener("click", exportResults);
}

function resetUi() {
  nodes.results.innerHTML = "";
  nodes.messages.innerHTML = "";
  nodes["file-input"].value = "";
  state.lastRows = [];
  state.lastSummary = null;
  state.currentSearch = "";
  state.timings = [];
  if (nodes["timing-card"]) nodes["timing-card"].hidden = true;
  renderTimingList();
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
  const tools = byId("advanced-tools");
  if (!tools) return;
  if (nodes["liftover-mode"].value !== "off") {
    tools.classList.add("border-primary");
  } else {
    tools.classList.remove("border-primary");
  }
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
