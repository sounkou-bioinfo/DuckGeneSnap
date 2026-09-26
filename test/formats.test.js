import test from "node:test";
import assert from "node:assert/strict";
import { openBrowser } from "./browser.js";

// rs6025 is a GRCh37 F5 seed locus (data/seed/curated_variants.tsv).
// GRCh38 1:943995 is present in the shipped ClinVar demo and asset bundle.
test("both builds and BCF/BGZF demo formats", { timeout: 120000 }, async (t) => {
  const session = await openBrowser(); t.after(session.close);
  const page = await session.newPage("/?duckhts=dev");
  await page.locator("#status").getByText(/Ready:/).waitFor();
  for (const [file, build, expected] of [
    ["example_grch37.bcf", "GRCh37", "F5"],
    ["example_deepvariant_grch37.vcf.gz", "GRCh37", "F5"],
    ["example_23andme_grch38.txt", "GRCh38", "943995"],
    ["example_grch38.vcf", "GRCh38", "943995"],
    ["example_grch38.bcf", "GRCh38", "943995"],
  ]) {
    await page.locator("#input-build").selectOption(build);
    await page.locator("#analysis-build").selectOption(build);
    await page.locator("#input-file").setInputFiles(`public/demo/${file}`);
    await page.locator("#analyze-button").click();
    await page.waitForFunction(() => /Analysis complete\.|Error:/.test(document.getElementById("status").textContent));
    const status = await page.locator("#status").innerText();
    assert.equal(status, "Analysis complete.", `${file}: ${status}`);
    assert.match(await page.locator("#summary").innerText(), /matches/);
    assert.ok((await page.locator("#results tbody tr").count()) > 0, file);
    assert.match(await page.locator("#results tbody").textContent(), new RegExp(expected));
  }
  assert.ok(session.requests.every((url) => new URL(url).origin === new URL(session.base).origin));
});
