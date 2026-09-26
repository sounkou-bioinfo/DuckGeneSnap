import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openBrowser } from "./browser.js";

test("temporary same-origin paired FASTA and chain support DuckHTS liftover", { timeout: 90000 }, async (t) => {
  const session = await openBrowser(); t.after(session.close);
  const page = await session.newPage("/?duckhts=dev");
  const result = await page.evaluate(async () => {
    const { stagePairedFiles } = await import("/src/local-files.js");
    const { openDatabase, quote } = await import("/src/db.js");
    const text = (value) => new Blob([value]);
    const staged = await stagePairedFiles({ "src.fa": text(">chr1\nACGTACGT\n"), "src.fa.fai": text("chr1\t8\t6\t8\t9\n"),
      "dst.fa": text(">chr1\nACGTACGT\n"), "dst.fa.fai": text("chr1\t8\t6\t8\t9\n"),
      "map.chain": text("chain 1 chr1 8 + 0 8 chr1 8 + 0 8 1\n8\n") });
    const { db, conn } = await openDatabase({ dev: true });
    try {
      return (await conn.query(`SELECT bcftools_liftover('chr1', 2, 'C', 'T', ${quote(staged.url('map.chain'))},
        ${quote(staged.url('dst.fa'))}, ${quote(staged.url('src.fa'))}, 1, 250, false, NULL::BIGINT, false) AS lo`)).toArray().map((row) => row.toJSON());
    } finally { await conn.close(); await db.terminate(); await staged.release(); }
  });
  assert.equal(result[0].lo.mapped, true);
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin), session.requests.join("\n"));
});

test("VCF liftover and build-crossing analysis use uploaded indexed references", { timeout: 90000 }, async (t) => {
  const session = await openBrowser(); t.after(session.close);
  const page = await session.newPage("/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor();
  await page.getByText("Advanced tools").click();
  const upload = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  const vcf = upload("input.vcf", "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr1\t2\t.\tC\tT\t.\tPASS\t.\n");
  await page.locator("#lift-file").setInputFiles(vcf);
  await page.locator("#chain-file").setInputFiles(upload("map.chain", "chain 1 chr1 8 + 0 8 chr1 8 + 0 8 1\n8\n"));
  for (const id of ["source-fasta", "destination-fasta"]) await page.locator(`#${id}`).setInputFiles(upload("ref.fa", ">chr1\nACGTACGT\n"));
  for (const id of ["source-fai", "destination-fai"]) await page.locator(`#${id}`).setInputFiles(upload("ref.fa.fai", "chr1\t8\t6\t8\t9\n"));
  const download = page.waitForEvent("download");
  await page.locator("#lift-button").click();
  await page.locator("#status").getByText(/Lifted 1 of 1/).waitFor();
  assert.match(await readFile(await (await download).path(), "utf8"), /chr1\t2\t\.\tC\tT/);
  for (const format of ["tsv", "parquet"]) {
    await page.locator("#lift-format").selectOption(format);
    const next = page.waitForEvent("download");
    await page.locator("#lift-button").click();
    const bytes = await readFile(await (await next).path());
    assert.ok(format === "tsv" ? bytes.toString().includes("input_chrom") : bytes.subarray(0, 4).toString() === "PAR1");
  }
  await page.locator("#input-file").setInputFiles(vcf);
  await page.locator("#analysis-build").selectOption("GRCh38");
  await page.locator("#analyze-button").click();
  await page.locator("#status").getByText("Analysis complete.").waitFor();
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin), session.requests.join("\n"));
});
