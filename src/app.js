import { openDatabase, loadAssets, rows } from "./db.js";
import { readChip, readVariants, detectKind } from "./ingest.js";
import { matchLoci, pageMatches } from "./match.js";
import { exportMatches } from "./export.js";
import { convertChip } from "./convert.js";
import { stagePairedFiles } from "./local-files.js";
import { liftVariants } from "./liftover.js";
import { supportsLocalFiles } from "../vendor/duckhts-loader.js";

const el = (id) => document.getElementById(id);
const status = (text) => { el("status").textContent = text; };
let backend, ready, resultCount = 0, offset = 0, fileForDemo = null;
const dev = new URLSearchParams(location.search).get("duckhts") === "dev";
const filters = () => ({ search: el("search").value.trim(), gene: el("gene").value.trim(),
  category: el("category").value, risk_level: el("risk_level").value,
  source: el("source").value, significance: el("significance").value,
  minStars: el("min-stars").value });

async function boot() {
  status("Starting local DuckDB and DuckHTS…");
  backend = await openDatabase({ dev });
  ready = await supportsLocalFiles(backend.conn);
  await loadAssets(backend.db, backend.conn);
  const manifest = await (await fetch("/public/data/manifest.json")).json();
  status(`Ready: ${manifest.counts?.variant_annotations ?? "?"} annotations. ${ready ? "Local VCF reading available." : "Local VCF reading requires ?duckhts=dev and npm run stage:dev."}`);
  el("analyze-button").disabled = false;
  el("demo-button").disabled = false;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function liftoverFiles() {
  const inputs = { "map.chain": "chain-file", "source.fa": "source-fasta", "source.fa.fai": "source-fai",
    "destination.fa": "destination-fasta", "destination.fa.fai": "destination-fai" };
  return Object.fromEntries(Object.entries(inputs).map(([filename, id]) => [filename, el(id).files[0]]));
}

async function showPage() {
  const page = await pageMatches(backend.conn, filters(), 25, offset);
  const tbody = el("results").tBodies[0];
  tbody.replaceChildren();
  for (const row of page.rows) {
    const tr = document.createElement("tr");
    for (const key of ["gene", "name", "category", "risk_level", "input_genotype", "source", "interpretation"]) {
      const td = document.createElement("td"); td.textContent = String(row[key] ?? ""); tr.append(td);
    }
    const detail = document.createElement("td");
    const expand = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = "Annotation details";
    expand.append(summary);
    for (const key of ["annotation_id", "source_id", "build", "input_chrom", "input_pos", "variant_key_hex", "significance", "clinvar_stars", "score", "odds_ratio", "description", "publications", "external_ids"]) {
      const line = document.createElement("p"); line.textContent = `${key}: ${row[key] ?? ""}`; expand.append(line);
    }
    detail.append(expand); tr.append(detail); tbody.append(tr);
  }
  el("page-number").textContent = `${page.total ? offset + 1 : 0}–${Math.min(offset + 25, page.total)} of ${page.total}`;
  el("previous").disabled = offset === 0;
  el("next").disabled = offset + 25 >= page.total;
}

async function populateFilters() {
  for (const key of ["category", "risk_level", "source", "significance"]) {
    const options = rows(await backend.conn.query(`SELECT DISTINCT ${key} AS value FROM analysis_matches WHERE ${key} IS NOT NULL ORDER BY value`));
    el(key).replaceChildren(new Option(`All ${key.replace("_", " ")}`, ""), ...options.map(({ value }) => new Option(value, value)));
  }
}

async function analyze(file) {
  if (!backend) throw new Error("DuckDB is not ready.");
  const kind = detectKind(file), build = el("analysis-build").value, inputBuild = el("input-build").value;
  if (kind === "vcf" && !ready) throw new Error("Local VCF/BCF uploads require the pinned unsigned DuckHTS build: npm run stage:dev and add ?duckhts=dev.");
  status("Reading input and matching annotations locally…");
  let stats;
  if (kind === "chip") stats = await readChip(backend.db, backend.conn, file);
  else if (inputBuild === build) stats = await readVariants(backend.conn, file, { inputBuild, build, filter: el("record-filter").value });
  else {
    const staged = await stagePairedFiles(liftoverFiles());
    try {
      stats = await readVariants(backend.conn, file, { inputBuild, build, filter: el("record-filter").value,
        liftover: { chain: staged.url("map.chain"), source: staged.url("source.fa"), destination: staged.url("destination.fa") } });
    } finally { await staged.release(); }
  }
  resultCount = await matchLoci(backend.conn, { kind, build });
  offset = 0; await populateFilters(); await showPage();
  const counts = rows(await backend.conn.query(`SELECT count(*) FILTER (WHERE category = 'health_risk') AS health_risk,
    count(*) FILTER (WHERE category = 'pharmacogenomics') AS pharmacogenomics,
    count(*) FILTER (WHERE category = 'trait') AS trait,
    count(*) FILTER (WHERE risk_level = 'high_risk') AS high_risk FROM analysis_matches`))[0];
  el("summary").textContent = `${resultCount} matches; ${counts.health_risk} health risks, ${counts.pharmacogenomics} pharmacogenomics, ${counts.trait} traits, ${counts.high_risk} high risk. Input: ${JSON.stringify(stats)}. Locus matches are exploratory, not clinical diagnoses.`;
  status("Analysis complete.");
}

async function run(action) {
  try { await action(); } catch (error) { console.error(error); status(`Error: ${error.message || error}`); }
}

el("analysis-form").addEventListener("submit", (event) => {
  event.preventDefault(); run(async () => {
    const file = el("input-file").files[0] || fileForDemo;
    if (!file) throw new Error("Choose an input file.");
    await analyze(file);
  });
});
el("demo-button").addEventListener("click", () => run(async () => {
  const response = await fetch("/public/demo/example_23andme_grch37.txt");
  fileForDemo = new File([await response.blob()], "example_23andme_grch37.txt");
  el("input-build").value = "GRCh37"; el("analysis-build").value = "GRCh37";
  await analyze(fileForDemo);
}));
for (const id of ["search", "gene", "category", "risk_level", "source", "significance", "min-stars"]) el(id).addEventListener(["search", "gene"].includes(id) ? "input" : "change", () => run(async () => { offset = 0; if (resultCount) await showPage(); }));
el("previous").addEventListener("click", () => run(async () => { offset = Math.max(0, offset - 25); await showPage(); }));
el("next").addEventListener("click", () => run(async () => { offset += 25; await showPage(); }));
el("download-button").addEventListener("click", () => run(async () => {
  if (!resultCount) throw new Error("Analyze a file first.");
  const format = el("export-format").value;
  const blob = await exportMatches(backend.db, backend.conn, format, filters());
  download(blob, `duckgenesnap_matches.${format}`);
  status(`${format.toUpperCase()} export ready.`);
}));
el("lift-button").addEventListener("click", () => run(async () => {
  if (!ready) throw new Error("Local VCF/BCF readers require ?duckhts=dev.");
  const file = el("lift-file").files[0];
  if (!file || detectKind(file) !== "vcf") throw new Error("Choose a VCF/BCF file for liftover.");
  const staged = await stagePairedFiles(liftoverFiles());
  try {
    const format = el("lift-format").value;
    const result = await liftVariants(backend.db, backend.conn, file, staged, format);
    download(result.blob, `duckgenesnap_liftover.${format}`);
    status(`Lifted ${result.mapped} of ${result.total} records; downloaded ${format.toUpperCase()}.`);
  } finally { await staged.release(); }
}));
el("chip-convert").addEventListener("click", () => run(async () => {
  if (!ready) throw new Error("Local DuckHTS readers require ?duckhts=dev.");
  const file = el("input-file").files[0] || fileForDemo;
  if (!file || detectKind(file) !== "chip") throw new Error("Choose a 23andMe-style text file.");
  const fasta = el("chip-reference").files[0], fai = el("chip-reference-index").files[0];
  if (!fasta || !fai) throw new Error("Choose a reference FASTA and its .fai index.");
  const result = await convertChip(backend.db, backend.conn, file, fasta, fai,
    { sample: el("chip-sample").value, emitHomAlt: el("chip-hom-alt").checked });
  download(result.vcf, "duckgenesnap_chip.vcf");
  download(result.qc, "duckgenesnap_chip_qc.tsv");
  status(`Converted ${result.written} of ${result.staged} chip rows; downloaded VCF and QC TSV.`);
}));
el("analyze-button").disabled = true;
el("demo-button").disabled = true;
run(boot);
