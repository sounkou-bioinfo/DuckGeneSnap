import { WebR } from "https://webr.r-wasm.org/latest/webr.mjs";

const DATA_BASE = "public/data";
const DEMO_23ANDME = "public/demo/example_23andme.txt";
const LITVAR2_API_BASE = "https://www.ncbi.nlm.nih.gov/research/litvar2-api";
const LITVAR2_SITE_BASE = "https://www.ncbi.nlm.nih.gov/research/litvar2";
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
  resultFilters: {},
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
    "vcf-record-filter",
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

function forceHideOperation() {
  const op = state.operation.active;
  if (op?.timerId) clearInterval(op.timerId);
  state.operation.active = null;
  state.operation.modal?.hide();
  const modalNode = nodes["operation-modal"];
  if (modalNode) {
    modalNode.classList.remove("show");
    modalNode.style.display = "none";
    modalNode.setAttribute("aria-hidden", "true");
  }
  document.querySelectorAll(".modal-backdrop").forEach((node) => node.remove());
  document.body.classList.remove("modal-open");
  document.body.style.removeProperty("overflow");
  document.body.style.removeProperty("padding-right");
}

function resetTimings() {
  forceHideOperation();
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
  forceHideOperation();
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
  await sleep(success ? 150 : 900);
  forceHideOperation();
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
    WHEN a.significance = 'conflicting' THEN 'annotation_match'
    WHEN a.significance = 'pathogenic' THEN 'high_risk'
    WHEN a.significance = 'likely_pathogenic' THEN 'increased_risk'
    WHEN a.significance = 'drug_response' THEN 'drug_response'
    WHEN a.significance = 'risk_factor' THEN 'increased_risk'
    ELSE 'annotation_match'
  END)`;
}

function annotationInterpretationSql() {
  return `coalesce(gi.interpretation, CASE
    WHEN a.significance = 'conflicting' THEN
      'Input genotype matched a ClinVar locus with conflicting classifications. Do not treat this as pathogenic without clinical review.'
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

async function analyzeVcfBcf(file, inputBuild, analysisBuild, liftoverMode, recordFilter) {
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
  const calledAltOnly = recordFilter !== "all_concrete";
  const calledAltCondition = calledAltOnly
    ? "AND (NOT has_gt OR coalesce(regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'), false))"
    : "";
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
      throw new Error("Input build differs from the analysis build. Use Advanced local tools > VCF/BCF liftover to create a converted file, then upload that converted VCF/BCF for annotation.");
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
    ${calledAltCondition}
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
LEFT JOIN variant_keys vk_exact
  ON vk_exact.annotation_id = a.annotation_id
 AND vk_exact.build = a.build
 AND vk_exact.variant_key = k.variant_key
LEFT JOIN (
  SELECT DISTINCT annotation_id, build
  FROM variant_keys
) vk_any
  ON vk_any.annotation_id = a.annotation_id
 AND vk_any.build = a.build
LEFT JOIN genotype_interpretations gi
  ON gi.annotation_id = a.annotation_id
 AND gi.genotype_norm = k.genotype_norm
WHERE vk_any.annotation_id IS NULL
   OR vk_exact.annotation_id IS NOT NULL
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
      AND ${calledAltOnly ? "NOT coalesce(regexp_matches(gt, '(^|[/|])([1-9][0-9]*)([/|]|$)'), false)" : "FALSE"}
  )::BIGINT AS skipped_non_alt_gt,
  (SELECT count(*) FROM user_variant_keyed)::BIGINT AS keyed_records,
  (SELECT count(*) FROM analysis_matches)::BIGINT AS matched_records
`);
  return {
    stats: { ...(keyedStats[0] || {}), record_filter: recordFilter },
    inputKind: "VCF/BCF",
  };
}

function normalizeResultFilters(filters = {}) {
  return {
    search: String(filters.search || "").trim(),
    gene: String(filters.gene || "").trim(),
    source: String(filters.source || "").trim(),
    category: String(filters.category || "").trim(),
    significance: String(filters.significance || "").trim(),
    risk: String(filters.risk || "").trim(),
    minStars: String(filters.minStars || "").trim(),
    limit: Math.min(Math.max(Number(filters.limit || 250), 25), 1000),
    offset: Math.max(Number(filters.offset || 0), 0),
  };
}

function likeCondition(column, value) {
  const term = String(value || "").trim();
  if (!term) return null;
  return `lower(coalesce(${column}, '')) LIKE ${sqlString(`%${term.toLowerCase()}%`)}`;
}

function resultFiltersWhere(filters = {}) {
  const f = normalizeResultFilters(filters);
  const conditions = [];
  if (f.search) {
    const pattern = sqlString(`%${f.search.toLowerCase()}%`);
    conditions.push(`lower(
      coalesce(gene, '') || ' ' ||
      coalesce(source_id, '') || ' ' ||
      coalesce(annotation_id, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(significance, '') || ' ' ||
      coalesce(category, '') || ' ' ||
      coalesce(source, '') || ' ' ||
      coalesce(input_genotype, '') || ' ' ||
      coalesce(genotype_norm, '')
    ) LIKE ${pattern}`);
  }
  [
    likeCondition("gene", f.gene),
    likeCondition("source_id || ' ' || annotation_id", f.source),
  ].filter(Boolean).forEach((condition) => conditions.push(condition));
  if (f.category) conditions.push(`category = ${sqlString(f.category)}`);
  if (f.significance) conditions.push(`significance = ${sqlString(f.significance)}`);
  if (f.risk) conditions.push(`risk_level = ${sqlString(f.risk)}`);
  if (f.minStars) {
    const stars = Math.min(Math.max(Number(f.minStars), 0), 4);
    conditions.push(`source = 'clinvar' AND coalesce(clinvar_stars, 0) >= ${stars}`);
  }
  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

function resultSearchWhere(searchText = "") {
  return resultFiltersWhere({ ...state.resultFilters, search: searchText });
}

function resultOrderSql() {
  return `${buildRiskOrderSql()}, score DESC, category, gene, annotation_id`;
}

async function collectResults(context, filters = {}) {
  const f = normalizeResultFilters(filters);
  const whereSql = resultFiltersWhere(f);
  const summaryRows = await queryJson(`
SELECT
  count(*)::BIGINT AS total_variants_found,
  count(*) FILTER (WHERE category = 'health_risk')::BIGINT AS health_risk_count,
  count(*) FILTER (WHERE category = 'pharmacogenomics')::BIGINT AS pharmacogenomics_count,
  count(*) FILTER (WHERE category = 'trait')::BIGINT AS trait_count,
  count(*) FILTER (WHERE category = 'uncertain')::BIGINT AS uncertain_count,
  count(*) FILTER (WHERE risk_level = 'high_risk')::BIGINT AS high_risk_count
FROM analysis_matches
`);
  const filteredRows = await queryJson(`
SELECT count(*)::BIGINT AS filtered_count
FROM analysis_matches
${whereSql}
`);
  const rows = await queryJson(`
SELECT *
FROM analysis_matches
${whereSql}
ORDER BY ${resultOrderSql()}
LIMIT ${f.limit}
OFFSET ${f.offset}
`);
  const summary = summaryRows[0] || {};
  const filteredCount = Number(filteredRows[0]?.filtered_count || 0);
  if (f.offset >= filteredCount && filteredCount > 0) {
    f.offset = Math.max(filteredCount - f.limit, 0);
    return collectResults(context, f);
  }
  state.currentSearch = f.search;
  state.resultFilters = f;
  state.lastRows = rows;
  state.lastSummary = {
    ...summary,
    ...context,
    filters: f,
    searchText: f.search,
    filtered_count: filteredCount,
  };
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

function clinVarStarsHtml(row) {
  if (String(row.source || "").toLowerCase() !== "clinvar") return "";
  const value = Number(row.clinvar_stars ?? 0);
  const stars = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 4);
  const filled = "★".repeat(stars);
  const empty = "☆".repeat(4 - stars);
  return `<span class="text-muted small" title="ClinVar review-status stars">ClinVar review ${escapeHtml(filled + empty)} (${stars}/4)</span>`;
}

function clinVarStarsText(row) {
  if (String(row.source || "").toLowerCase() !== "clinvar") return "";
  const value = Number(row.clinvar_stars ?? 0);
  const stars = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 4);
  return `${"★".repeat(stars)}${"☆".repeat(4 - stars)} (${stars}/4)`;
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
  const filterLabel = stats.record_filter === "all_concrete"
    ? "all concrete REF/ALT records"
    : "called alternate variants only";
  return `${Number(stats.raw_records || 0).toLocaleString()} raw records; ${Number(stats.keyed_records || 0).toLocaleString()} ${filterLabel}; ${Number(stats.matched_records || 0).toLocaleString()} curated matches; ${Number(stats.skipped_non_alt_gt || 0).toLocaleString()} hom-ref/no-call records skipped.`;
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

function selectOptions(values, selected, labels = {}) {
  return values.map((value) => `
<option value="${escapeHtml(value)}" ${String(value) === String(selected || "") ? "selected" : ""}>${escapeHtml(labels[value] || value || "any")}</option>`).join("");
}

function renderResultsTable(rows) {
  if (!rows.length) {
    return `<p class="text-muted mb-0">No rows match the current filters.</p>`;
  }
  const body = rows.map((row, idx) => `
<tr>
  <td>${riskBadge(row.risk_level)}<br><span class="text-muted small">${escapeHtml(row.category)}</span></td>
  <td><strong>${escapeHtml(row.gene)}</strong><br><span class="text-muted small">${escapeHtml(row.source_id || row.annotation_id)}</span></td>
  <td>${escapeHtml(row.name)}</td>
  <td><code>${escapeHtml(row.input_genotype || row.genotype_norm)}</code><br><span class="text-muted small">norm ${escapeHtml(row.genotype_norm)}</span></td>
  <td>${escapeHtml(row.significance?.replaceAll("_", " "))}<br><span class="text-muted small">priority score ${escapeHtml(row.score)}</span><br>${clinVarStarsHtml(row)}</td>
  <td>
    <button class="btn btn-sm btn-outline-dark" type="button" data-bs-toggle="collapse" data-bs-target="#detail-all-${idx}">Details</button>
  </td>
</tr>
<tr class="collapse-row">
  <td colspan="6" class="p-0 border-0">
    <div class="collapse" id="detail-all-${idx}">
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
              <dt class="col-5">ClinVar review</dt><dd class="col-7">${escapeHtml(clinVarStarsText(row))}</dd>
              <dt class="col-5">PMIDs</dt><dd class="col-7">${escapeHtml(row.publications || "")}</dd>
            </dl>
            <div>${externalLinks(row)}</div>
            <hr />
            <h6>LitVar2 literature</h6>
            <p class="small text-muted mb-2">Open NCBI/NLM LitVar2 for this row, or try the API from the browser if CORS permits it.</p>
            <button class="btn btn-sm btn-outline-primary litvar2-row-button" type="button" data-litvar2-query="${escapeHtml(/^rs\d+$/i.test(row.source_id || "") ? row.source_id : row.gene || row.source_id || row.annotation_id)}" data-litvar2-target="litvar2-row-${idx}">Try LitVar2 API</button>
            <span class="small ms-2">${litVar2Links(/^rs\d+$/i.test(row.source_id || "") ? row.source_id : row.gene || row.source_id || row.annotation_id)}</span>
            <div class="small mt-2" id="litvar2-row-${idx}"></div>
          </div>
        </div>
      </div>
    </div>
  </td>
</tr>`).join("");
  return `
<div class="table-responsive results-scroll border">
  <table class="table table-hover align-middle mb-0">
    <thead>
      <tr>
        <th>Risk / category</th><th>Gene / source</th><th>Variant</th><th>Your genotype</th><th>Evidence</th><th></th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
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
  const filteredCount = Number(summary.filtered_count ?? total);
  const filters = normalizeResultFilters(summary.filters || state.resultFilters);
  const pageStart = filteredCount ? filters.offset + 1 : 0;
  const pageEnd = Math.min(filters.offset + rows.length, filteredCount);

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
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Curated matches</div><div class="display-6">${total.toLocaleString()}</div><div class="small text-muted">Filtered rows ${pageStart.toLocaleString()}-${pageEnd.toLocaleString()} of ${filteredCount.toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">High risk</div><div class="display-6 text-danger">${Number(summary.high_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Health</div><div class="display-6">${Number(summary.health_risk_count || 0).toLocaleString()}</div></div></div></div>
    <div class="col-md-3"><div class="card h-100"><div class="card-body"><div class="text-muted small">Pharma + traits</div><div class="display-6">${(Number(summary.pharmacogenomics_count || 0) + Number(summary.trait_count || 0)).toLocaleString()}</div><div class="small text-muted">Uncertain ${Number(summary.uncertain_count || 0).toLocaleString()}</div></div></div></div>
  </div>

  <div class="card border-0 shadow-sm mb-4">
    <div class="card-body">
      <div class="d-flex flex-wrap gap-2 mb-3">
        <button type="button" class="btn btn-sm ${filters.category ? "btn-outline-secondary" : "btn-primary"}" data-result-category="">All ${total.toLocaleString()}</button>
        <button type="button" class="btn btn-sm ${filters.category === "health_risk" ? "btn-primary" : "btn-outline-secondary"}" data-result-category="health_risk">Health ${Number(summary.health_risk_count || 0).toLocaleString()}</button>
        <button type="button" class="btn btn-sm ${filters.category === "pharmacogenomics" ? "btn-primary" : "btn-outline-secondary"}" data-result-category="pharmacogenomics">Pharma ${Number(summary.pharmacogenomics_count || 0).toLocaleString()}</button>
        <button type="button" class="btn btn-sm ${filters.category === "trait" ? "btn-primary" : "btn-outline-secondary"}" data-result-category="trait">GWAS/traits ${Number(summary.trait_count || 0).toLocaleString()}</button>
        <button type="button" class="btn btn-sm ${filters.category === "uncertain" ? "btn-primary" : "btn-outline-secondary"}" data-result-category="uncertain">Uncertain ${Number(summary.uncertain_count || 0).toLocaleString()}</button>
      </div>
      <div class="row g-2 align-items-end">
        <div class="col-lg-4">
          <label class="form-label" for="result-search">Global search</label>
          <input id="result-search" class="form-control" type="search" value="${escapeHtml(filters.search)}" placeholder="gene, rsID, ClinVar term, genotype..." />
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-gene">Gene</label>
          <input id="filter-gene" class="form-control" value="${escapeHtml(filters.gene)}" placeholder="F5" />
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-source">rsID / source</label>
          <input id="filter-source" class="form-control" value="${escapeHtml(filters.source)}" placeholder="rs6025" />
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-category">Category</label>
          <select id="filter-category" class="form-select">
            ${selectOptions(["", "health_risk", "pharmacogenomics", "trait", "uncertain"], filters.category, { "": "any" })}
          </select>
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-risk">Risk</label>
          <select id="filter-risk" class="form-select">
            ${selectOptions(["", "high_risk", "increased_risk", "drug_response", "annotation_match", "normal"], filters.risk, { "": "any" })}
          </select>
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-significance">Significance</label>
          <select id="filter-significance" class="form-select">
            ${selectOptions(["", "pathogenic", "likely_pathogenic", "drug_response", "risk_factor", "association", "conflicting"], filters.significance, { "": "any" })}
          </select>
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="filter-clinvar-stars">ClinVar stars</label>
          <select id="filter-clinvar-stars" class="form-select">
            ${selectOptions(["", "1", "2", "3", "4"], filters.minStars, { "": "any", "1": "≥1★", "2": "≥2★", "3": "≥3★", "4": "4★" })}
          </select>
        </div>
        <div class="col-lg-2">
          <label class="form-label" for="result-page-size">Rows/page</label>
          <select id="result-page-size" class="form-select">
            ${selectOptions([100, 250, 500, 1000], filters.limit)}
          </select>
        </div>
        <div class="col-lg-4 d-flex flex-wrap gap-2">
          <button id="result-search-button" type="button" class="btn btn-outline-primary">Apply filters</button>
          <button id="result-clear-search" type="button" class="btn btn-outline-secondary">Clear</button>
          <button id="result-prev-page" type="button" class="btn btn-outline-secondary" ${filters.offset <= 0 ? "disabled" : ""}>Previous</button>
          <button id="result-next-page" type="button" class="btn btn-outline-secondary" ${pageEnd >= filteredCount ? "disabled" : ""}>Next</button>
        </div>
        <div class="col-lg-4 d-flex gap-2 justify-content-lg-end">
          <select id="export-format" class="form-select w-auto" aria-label="Export format">
            <option value="tsv">TSV</option>
            <option value="csv">CSV for Excel</option>
            <option value="xlsx">Excel .xlsx</option>
            <option value="parquet">Parquet</option>
          </select>
          <button id="download-button" type="button" class="btn btn-outline-success" ${total ? "" : "disabled"}>Export filtered</button>
        </div>
      </div>
      <div class="form-text mt-2">Summary cards are global for this analysis run. Filters, paging, and export query the browser DuckDB <code>analysis_matches</code> table; the table below shows only the current page, not the full match set.</div>
    </div>
  </div>

  ${renderResultsTable(rows)}
  ${renderTimings()}
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
      : await analyzeVcfBcf(
        file,
        inputBuild,
        analysisBuild,
        "off",
        nodes["vcf-record-filter"].value,
      );

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

function stripMarkup(value) {
  return String(value || "").replace(/<[^>]*>/g, "");
}

function litVar2ApiUrl(path) {
  return `${LITVAR2_API_BASE}/${path}`;
}

function litVar2SiteSearchUrl(query) {
  return `${LITVAR2_SITE_BASE}/?query=${encodeURIComponent(query)}`;
}

function litVar2DocsumUrl(variantId, query) {
  return `${LITVAR2_SITE_BASE}/docsum?variant=${encodeURIComponent(variantId)}&query=${encodeURIComponent(query)}`;
}

function parseLitVar2Payload(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const id = line.match(/'_id': '([^']+)'/);
      const rsid = line.match(/'rsid': '([^']+)'/);
      const pmids = line.match(/'pmids_count': ([0-9]+)/);
      if (id || rsid) {
        rows.push({
          _id: id?.[1] || null,
          rsid: rsid?.[1] || null,
          pmids_count: pmids ? Number(pmids[1]) : null,
        });
      }
    }
    if (rows.length) return rows;
    throw new Error("LitVar2 returned a response this browser could not parse.");
  }
}

async function fetchLitVar2(path) {
  const response = await fetch(litVar2ApiUrl(path), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`LitVar2 HTTP ${response.status}`);
  }
  return parseLitVar2Payload(await response.text());
}

function normalizeLitVar2Rows(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function litVar2Links(query, firstVariantId = null) {
  const encoded = encodeURIComponent(query);
  const links = [
    `<a href="${escapeHtml(litVar2SiteSearchUrl(query))}" target="_blank" rel="noopener">LitVar2 site search</a>`,
    `<a href="${escapeHtml(litVar2ApiUrl(`variant/autocomplete/?query=${encoded}&limit=10`))}" target="_blank" rel="noopener">autocomplete API</a>`,
  ];
  if (/^rs\d+$/i.test(query)) {
    links.push(`<a href="${escapeHtml(litVar2ApiUrl(`sensor/${encoded}`))}" target="_blank" rel="noopener">sensor API</a>`);
  }
  if (/^[A-Za-z][A-Za-z0-9.-]{1,19}$/.test(query) && !/^rs\d+$/i.test(query)) {
    links.push(`<a href="${escapeHtml(litVar2ApiUrl(`variant/search/gene/${encoded}`))}" target="_blank" rel="noopener">gene API</a>`);
  }
  if (firstVariantId) {
    links.push(`<a href="${escapeHtml(litVar2DocsumUrl(firstVariantId, query))}" target="_blank" rel="noopener">variant page</a>`);
    links.push(`<a href="${escapeHtml(litVar2ApiUrl(`variant/get/${encodeURIComponent(firstVariantId)}/publications`))}" target="_blank" rel="noopener">publications API</a>`);
  }
  return links.join(" · ");
}

function renderLitVar2Hits(rows, query) {
  const hits = normalizeLitVar2Rows(rows).slice(0, 10);
  if (!hits.length) return `<p class="text-muted small mb-0">No variant hits returned.</p>`;
  return `
<div class="table-responsive">
  <table class="table table-sm align-middle mb-0">
    <thead><tr><th>Variant</th><th>Gene</th><th>PMIDs</th><th>Clinical tags</th><th></th></tr></thead>
    <tbody>${hits.map((hit) => {
      const id = hit._id || "";
      const rsid = hit.rsid || hit.name || id;
      const genes = Array.isArray(hit.gene) ? hit.gene.join(", ") : (hit.gene || "");
      const tags = Array.isArray(hit.data_clinical_significance)
        ? hit.data_clinical_significance.join(", ")
        : "";
      return `
<tr>
  <td><strong>${escapeHtml(rsid)}</strong><br><span class="text-muted small">${escapeHtml(stripMarkup(hit.match || hit.hgvs || hit.name || ""))}</span></td>
  <td>${escapeHtml(genes)}</td>
  <td>${escapeHtml(hit.pmids_count ?? "")}</td>
  <td>${escapeHtml(tags)}</td>
  <td>${id ? `<a href="${escapeHtml(litVar2DocsumUrl(id, query))}" target="_blank" rel="noopener">Open</a>` : ""}</td>
</tr>`;
    }).join("")}</tbody>
  </table>
</div>`;
}

function renderLitVar2Publications(publications) {
  const pmids = normalizeLitVar2Rows(publications?.pmids).slice(0, 12);
  if (!pmids.length) return "";
  return `<p class="small mb-0"><strong>Top PMID links:</strong> ${pmids.map((pmid) => `<a href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(pmid)}/" target="_blank" rel="noopener">${escapeHtml(pmid)}</a>`).join(" · ")}</p>`;
}

function renderLitVar2Summary(summary) {
  if (!summary || !summary._id) return "";
  const tags = Array.isArray(summary.data_clinical_significance)
    ? summary.data_clinical_significance.join(", ")
    : "";
  const positions = Array.isArray(summary.data_chromosome_base_position)
    ? summary.data_chromosome_base_position.join(", ")
    : "";
  return `
<div class="alert alert-light border small mb-3">
  <div><strong>${escapeHtml(summary.rsid || summary.name || summary._id)}</strong> ${escapeHtml(summary.hgvs || "")}</div>
  <div>Gene: ${escapeHtml(Array.isArray(summary.gene) ? summary.gene.join(", ") : summary.gene || "")}</div>
  <div>Position(s): ${escapeHtml(positions)}</div>
  <div>Clinical tags: ${escapeHtml(tags)}</div>
</div>`;
}

function renderLitVar2Results({ query, autocomplete, sensor, geneRows, summary, publications, errors }) {
  const firstId = normalizeLitVar2Rows(autocomplete)[0]?._id || normalizeLitVar2Rows(geneRows)[0]?._id || summary?._id;
  const errorText = errors.length
    ? `<div class="alert alert-warning small">Some LitVar2 calls failed, often because browser CORS is not enabled for this origin: ${escapeHtml(errors.map((error) => error.message || String(error)).join("; "))}</div>`
    : "";
  const sensorHtml = sensor?.link
    ? `<p class="small"><strong>Sensor:</strong> ${escapeHtml(sensor.pmids_count)} publications · <a href="${escapeHtml(sensor.link)}" target="_blank" rel="noopener">Open LitVar2 docsum</a></p>`
    : "";
  const geneHtml = normalizeLitVar2Rows(geneRows).length
    ? `<details class="small mt-3"><summary>Gene API returned ${normalizeLitVar2Rows(geneRows).length.toLocaleString()} variants; first 10 shown in direct API output.</summary>${renderLitVar2Hits(geneRows, query)}</details>`
    : "";
  return `
${errorText}
${renderLitVar2Summary(summary)}
${sensorHtml}
<h4 class="h6">Variant search hits</h4>
${renderLitVar2Hits(autocomplete, query)}
${renderLitVar2Publications(publications)}
${geneHtml}
<p class="small text-muted mt-3 mb-0">${litVar2Links(query, firstId)}</p>`;
}

async function runLitVar2Query(query, output, openLink = null) {
  if (!output) return;
  if (!query) {
    output.innerHTML = `<div class="alert alert-warning small mb-0">Enter an rsID, variant name, or gene.</div>`;
    return;
  }
  if (openLink) openLink.href = litVar2SiteSearchUrl(query);
  output.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Searching LitVar2...</div>`;

  const encoded = encodeURIComponent(query);
  const jobs = [
    ["autocomplete", `variant/autocomplete/?query=${encoded}&limit=10`],
  ];
  if (/^rs\d+$/i.test(query)) jobs.push(["sensor", `sensor/${encoded}`]);
  if (/^[A-Za-z][A-Za-z0-9.-]{1,19}$/.test(query) && !/^rs\d+$/i.test(query)) {
    jobs.push(["geneRows", `variant/search/gene/${encoded}`]);
  }

  const results = {};
  const errors = [];
  await Promise.all(jobs.map(async ([name, path]) => {
    try {
      results[name] = await fetchLitVar2(path);
    } catch (error) {
      errors.push(error);
    }
  }));

  const firstId = normalizeLitVar2Rows(results.autocomplete)[0]?._id || normalizeLitVar2Rows(results.geneRows)[0]?._id;
  if (firstId) {
    try {
      results.summary = await fetchLitVar2(`variant/get/${encodeURIComponent(firstId)}`);
    } catch (error) {
      errors.push(error);
    }
    try {
      results.publications = await fetchLitVar2(`variant/get/${encodeURIComponent(firstId)}/publications`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (!results.autocomplete && !results.geneRows && !results.sensor && errors.length) {
    output.innerHTML = `
<div class="alert alert-warning small">
  Browser calls to the LitVar2 API failed. This is commonly a CORS restriction from NCBI for the current site origin.
  Use the direct links below.
</div>
<p class="small mb-0">${litVar2Links(query)}</p>`;
    return;
  }

  output.innerHTML = renderLitVar2Results({ query, errors, ...results });
}

async function runLitVar2Search() {
  const input = byId("litvar2-query");
  await runLitVar2Query(
    input?.value?.trim() || "",
    byId("litvar2-results"),
    byId("litvar2-open-link"),
  );
}

async function runLiftoverTool() {
  const status = byId("liftover-tool-status");
  const input = byId("liftover-input-file")?.files?.[0];
  if (!status) return;
  if (!input) {
    status.innerHTML = `<div class="alert alert-warning small mb-0">Choose an input VCF/BCF first.</div>`;
    return;
  }
  status.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Preparing liftover...</div>`;
  try {
    if (!state.backend.ready) await warmBackend();
    const inputPath = `${VFS_UPLOAD}/liftover_${sanitizeFilename(input.name, "input.vcf")}`;
    await writeBrowserFile(input, inputPath);
    const chainPath = await stageLiftoverAsset("chain-file", "chain-url", "chain");
    const srcRefPath = await stageLiftoverAsset("src-ref-file", "src-ref-url", "src_ref");
    const dstRefPath = await stageLiftoverAsset("dst-ref-file", "dst-ref-url", "dst_ref");
    if (!chainPath || !srcRefPath || !dstRefPath) {
      throw new Error("Liftover requires chain, source FASTA, and destination FASTA files or URLs.");
    }

    await runTimedStep({
      label: "Read liftover VCF/BCF",
      detail: "Reading the input VCF/BCF with Rduckhts.",
      successSummary: "Input variants are loaded",
      failureSummary: "Could not read liftover input",
    }, async () => {
      await runR(`Rduckhts::rduckhts_bcf(con, 'liftover_input_raw', ${rString(inputPath)}, tidy_format = TRUE, overwrite = TRUE)`);
    });
    const schema = await queryJson(`DESCRIBE ${sqlIdentifier("liftover_input_raw")}`);
    const raw = vcfColumnExpressions(schema);

    await runTimedStep({
      label: "Run VCF/BCF liftover",
      detail: "Applying bcftools_liftover to concrete single-ALT records.",
      successSummary: "Liftover table is ready",
      failureSummary: "Could not run liftover",
    }, async () => {
      await executeSql(`
CREATE OR REPLACE TABLE liftover_results AS
WITH input_rows AS (
  SELECT
    ${raw.sampleSql} AS sample_id,
    ${raw.gtSql} AS gt,
    ${raw.chromSql} AS input_chrom,
    ${raw.posSql} AS input_pos,
    ${raw.refSql} AS input_ref,
    ${raw.altSql} AS input_alt,
    ${raw.altCountSql} AS alt_count
  FROM liftover_input_raw
), filtered AS (
  SELECT *
  FROM input_rows
  WHERE input_chrom IS NOT NULL
    AND input_pos IS NOT NULL
    AND input_ref IS NOT NULL
    AND input_alt IS NOT NULL
    AND alt_count = 1
    AND NOT contains(input_alt, ',')
    AND regexp_matches(upper(input_ref), '^[ACGT]+$')
    AND regexp_matches(upper(input_alt), '^[ACGT]+$')
), lifted AS (
  SELECT
    *,
    bcftools_liftover(
      input_chrom,
      input_pos,
      input_ref,
      input_alt,
      ${sqlString(chainPath)},
      ${sqlString(dstRefPath)},
      ${sqlString(srcRefPath)},
      1,
      250,
      false,
      NULL::BIGINT,
      false
    ) AS lo
  FROM filtered
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
  lo.reverse_complemented AS reverse_complemented,
  lo.swap AS swapped,
  lo.reject_reason::VARCHAR AS reject_reason,
  lo.note::VARCHAR AS note
FROM lifted
`);
    });

    const counts = await queryJson(`
SELECT
  (SELECT count(*) FROM liftover_input_raw)::BIGINT AS raw_records,
  (SELECT count(*) FROM liftover_results)::BIGINT AS lifted_records,
  count(*) FILTER (WHERE mapped)::BIGINT AS mapped_records,
  count(*) FILTER (WHERE NOT mapped)::BIGINT AS rejected_records
FROM liftover_results
`);
    const format = byId("liftover-output-format")?.value || "tsv";
    const ext = format === "parquet" ? "parquet" : "tsv";
    const outputPath = `${VFS_ROOT}/duckgenesnap_liftover_${Date.now()}.${ext}`;
    const copyOptions = format === "parquet"
      ? "FORMAT PARQUET, COMPRESSION ZSTD"
      : "HEADER, DELIMITER '\t'";
    await executeSql(`COPY (SELECT * FROM liftover_results ORDER BY input_chrom, input_pos) TO ${sqlString(outputPath)} (${copyOptions})`);
    const bytes = await state.backend.webR.FS.readFile(outputPath);
    downloadBlob(
      new Blob([bytes], {
        type: format === "parquet" ? "application/vnd.apache.parquet" : "text/tab-separated-values;charset=utf-8",
      }),
      `duckgenesnap_liftover.${ext}`,
    );
    const c = counts[0] || {};
    status.innerHTML = `<div class="alert alert-success small mb-0">Downloaded lifted ${escapeHtml(ext.toUpperCase())}: ${Number(c.raw_records || 0).toLocaleString()} raw records, ${Number(c.lifted_records || 0).toLocaleString()} concrete records, ${Number(c.mapped_records || 0).toLocaleString()} mapped, ${Number(c.rejected_records || 0).toLocaleString()} rejected.</div>`;
  } catch (error) {
    console.error(error);
    status.innerHTML = `<div class="alert alert-danger small mb-0">${escapeHtml(error.message || String(error))}</div>`;
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

function readResultFilters(offsetOverride = null) {
  const current = normalizeResultFilters(state.resultFilters);
  return normalizeResultFilters({
    search: byId("result-search")?.value || "",
    gene: byId("filter-gene")?.value || "",
    source: byId("filter-source")?.value || "",
    category: byId("filter-category")?.value || "",
    significance: byId("filter-significance")?.value || "",
    risk: byId("filter-risk")?.value || "",
    minStars: byId("filter-clinvar-stars")?.value || "",
    limit: byId("result-page-size")?.value || current.limit,
    offset: offsetOverride ?? 0,
  });
}

async function applyResultFilters(filters = null) {
  if (!state.lastSummary) return;
  const context = {
    inputKind: state.lastSummary.inputKind,
    analysisBuild: state.lastSummary.analysisBuild,
    stats: state.lastSummary.stats,
  };
  const nextFilters = normalizeResultFilters(filters || readResultFilters());
  const { summary, rows } = await runTimedStep({
    label: "Filter results",
    detail: "Filtering and paging the browser DuckDB analysis_matches table.",
    successSummary: "Filtered result page is ready",
    failureSummary: "Could not filter results",
  }, () => collectResults(context, nextFilters));
  renderResults(summary, rows);
}

async function exportResults() {
  if (!state.lastSummary) return;
  const format = byId("export-format")?.value || "tsv";
  const whereSql = resultFiltersWhere(state.resultFilters);
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
    applyResultFilters(readResultFilters(0));
  });
  byId("result-clear-search")?.addEventListener("click", () => {
    ["result-search", "filter-gene", "filter-source"].forEach((id) => {
      const node = byId(id);
      if (node) node.value = "";
    });
    ["filter-category", "filter-risk", "filter-significance", "filter-clinvar-stars"].forEach((id) => {
      const node = byId(id);
      if (node) node.value = "";
    });
    applyResultFilters({ limit: byId("result-page-size")?.value || 250, offset: 0 });
  });
  document.querySelectorAll("[data-result-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const f = readResultFilters(0);
      f.category = button.dataset.resultCategory || "";
      applyResultFilters(f);
    });
  });
  byId("result-prev-page")?.addEventListener("click", () => {
    const f = normalizeResultFilters(state.resultFilters);
    applyResultFilters({ ...f, offset: Math.max(f.offset - f.limit, 0) });
  });
  byId("result-next-page")?.addEventListener("click", () => {
    const f = normalizeResultFilters(state.resultFilters);
    applyResultFilters({ ...f, offset: f.offset + f.limit });
  });
  [
    searchInput,
    byId("filter-gene"),
    byId("filter-source"),
  ].forEach((node) => node?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyResultFilters(readResultFilters(0));
    }
  }));
  [
    byId("filter-category"),
    byId("filter-risk"),
    byId("filter-significance"),
    byId("filter-clinvar-stars"),
    byId("result-page-size"),
  ].forEach((node) => node?.addEventListener("change", () => {
    applyResultFilters(readResultFilters(0));
  }));
  document.querySelectorAll(".litvar2-row-button").forEach((button) => {
    button.addEventListener("click", () => {
      runLitVar2Query(
        button.dataset.litvar2Query || "",
        byId(button.dataset.litvar2Target || ""),
      );
    });
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
  state.resultFilters = {};
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

function bindAdvancedTools() {
  const liftoverButton = byId("liftover-run-button");
  if (liftoverButton && !liftoverButton.dataset.bound) {
    liftoverButton.dataset.bound = "true";
    liftoverButton.addEventListener("click", runLiftoverTool);
  }
  const button = byId("litvar2-search-button");
  const input = byId("litvar2-query");
  if (button && !button.dataset.bound) {
    button.dataset.bound = "true";
    button.addEventListener("click", runLitVar2Search);
  }
  if (input && !input.dataset.bound) {
    input.dataset.bound = "true";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runLitVar2Search();
      }
    });
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
  document.body.addEventListener("htmx:afterSwap", bindAdvancedTools);
  document.body.addEventListener("shown.bs.collapse", bindAdvancedTools);
}

async function main() {
  initNodes();
  bindEvents();
  resetUi();
  try {
    await populateBuildSelectors();
  } catch (error) {
    showMessage(error.message ?? String(error), "danger");
  }
}

main();
