import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openBrowser } from "./browser.js";

const setup = async (t) => {
  const session = await openBrowser(); t.after(session.close);
  return session;
};
const localOnly = (session) => {
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin), session.requests.join("\n"));
  assert.deepEqual(session.uploads, []);
};

test("chip demo matches curated genotype and stays local", { timeout: 120000 }, async (t) => {
  const session = await setup(t);
  const page = await session.newPage("/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor({ timeout: 90000 });
  await page.locator("#demo-button").click();
  await page.locator("#status").getByText("Analysis complete.").waitFor({ timeout: 90000 });
  // The GRCh37 demo lists rs6025 at 1:169519049 with AG; the curated
  // seed TSV assigns F5/Factor V Leiden and the interpretation TSV assigns
  // AG increased_risk. These expectations come from fixtures, not SQL output.
  await page.locator("#search").fill("Factor V Leiden");
  assert.match(await page.locator("#results tbody").innerText(), /F5/);
  assert.match(await page.locator("#results tbody").innerText(), /increased_risk/);
  localOnly(session);
});

test("signed extension accepts chip files and explains unsupported blob uploads", { timeout: 90000 }, async (t) => {
  const session = await setup(t);
  const page = await session.newPage("/");
  await page.locator("#status").getByText(/Ready:/).waitFor({ timeout: 60000 });
  await page.locator("#input-file").setInputFiles("public/demo/example_grch37.vcf");
  await page.locator("#analyze-button").click();
  await page.locator("#status").getByText(/Error:/).waitFor({ timeout: 10000 });
  assert.match(await page.locator("#status").innerText(), /require the pinned unsigned DuckHTS/);
  await page.locator("#demo-button").click();
  await page.locator("#status").getByText("Analysis complete.").waitFor();
  localOnly(session);
});

test("VCF upload, export, malformed input, and origin isolation", { timeout: 120000 }, async (t) => {
  const session = await setup(t);
  const page = await session.newPage("/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor({ timeout: 90000 });
  await page.locator("#input-file").setInputFiles("public/demo/example_grch37.vcf");
  await page.locator("#analyze-button").click();
  await page.locator("#status").getByText("Analysis complete.").waitFor({ timeout: 90000 });
  assert.match(await page.locator("#results tbody").innerText(), /F5/);
  const download = page.waitForEvent("download");
  await page.locator("#download-button").click();
  const item = await download;
  assert.equal(item.suggestedFilename(), "duckgenesnap_matches.tsv");
  assert.match(await readFile(await item.path(), "utf8"), /Factor V Leiden/);
  for (const format of ["csv", "parquet"]) {
    await page.locator("#export-format").selectOption(format);
    const next = page.waitForEvent("download");
    await page.locator("#download-button").click();
    const bytes = await readFile(await (await next).path());
    assert.ok(format === "csv" ? bytes.toString().includes("Factor V Leiden") : bytes.subarray(0, 4).toString() === "PAR1");
  }
  await page.locator("#input-file").setInputFiles({ name: "broken.txt", mimeType: "text/plain", buffer: Buffer.from("not enough fields\n") });
  await page.locator("#analyze-button").click();
  await page.locator("#status").getByText(/Error: No analyzable/).waitFor();
  localOnly(session);
});
