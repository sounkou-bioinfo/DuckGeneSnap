import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openBrowser } from "./browser.js";

test("indexed FASTA conversion produces VCF and QC locally", { timeout: 90000 }, async (t) => {
  const session = await openBrowser(); t.after(session.close);
  const page = await session.newPage("/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor();
  // Reference chr1 at 1-based position 2 is C; chip CT must become C>T 0/1.
  const upload = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  await page.locator("#input-file").setInputFiles(upload("chip.txt", "rsTest\t1\t2\tCT\n"));
  await page.locator("#chip-reference").setInputFiles(upload("ref.fa", ">chr1\nACGTACGT\n"));
  await page.locator("#chip-reference-index").setInputFiles(upload("ref.fa.fai", "chr1\t8\t6\t8\t9\n"));
  const downloads = [];
  page.on("download", (item) => downloads.push(item));
  await page.locator("details summary").click();
  await page.locator("#chip-convert").click();
  await page.locator("#status").getByText(/Converted 1 of 1/).waitFor();
  assert.equal(downloads.length, 2);
  assert.match(await readFile(await downloads[0].path(), "utf8"), /chr1\t2\trsTest\tC\tT\t\.\tPASS\t\.\tGT\t0\/1/);
  assert.match(await readFile(await downloads[1].path(), "utf8"), /called_alt/);
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin));
});
