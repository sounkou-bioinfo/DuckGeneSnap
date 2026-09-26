import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openBrowser } from "./browser.js";

// GitHub Pages places this site at /DuckGeneSnap/, not at the origin root.
test("subpath deployment serves annotations and indexed liftover without root URLs", { timeout: 90000 }, async (t) => {
  const parent = new URL("../..", import.meta.url).pathname;
  const session = await openBrowser(parent); t.after(session.close);
  const page = await session.newPage("/DuckGeneSnap/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor();
  await page.locator("#demo-button").click();
  await page.locator("#status").getByText("Analysis complete.").waitFor();
  assert.match(await page.locator("#results tbody").innerText(), /F5/);
  await page.getByText("Advanced tools").click();
  const upload = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  await page.locator("#lift-file").setInputFiles(upload("input.vcf", "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr1\t2\t.\tC\tT\t.\tPASS\t.\n"));
  await page.locator("#chain-file").setInputFiles(upload("map.chain", "chain 1 chr1 8 + 0 8 chr1 8 + 0 8 1\n8\n"));
  for (const id of ["source-fasta", "destination-fasta"]) await page.locator(`#${id}`).setInputFiles(upload("ref.fa", ">chr1\nACGTACGT\n"));
  for (const id of ["source-fai", "destination-fai"]) await page.locator(`#${id}`).setInputFiles(upload("ref.fa.fai", "chr1\t8\t6\t8\t9\n"));
  const download = page.waitForEvent("download");
  await page.locator("#lift-button").click();
  await page.locator("#status").getByText(/Lifted 1 of 1/).waitFor();
  assert.match(await readFile(await (await download).path(), "utf8"), /chr1\t2\t\.\tC\tT/);
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin &&
    (url.startsWith("blob:") || new URL(url).pathname.startsWith("/DuckGeneSnap/"))), session.requests.join("\n"));
});
