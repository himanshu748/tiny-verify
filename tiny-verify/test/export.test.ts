import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRegistration } from "../src/report.js";
import { runCli } from "../src/cli.js";
import { verified } from "./fixtures.js";
test("reusable JSON/CSV/HTML retain explicit unknown fields, source and evidence boundary", () => {
  const output = exportRegistration(verified());
  assert.match(output.html, /Synthetic fixture/);
  assert.match(output.html, /Official registration record/);
  assert.match(output.csv, /expiry_date/);
  assert.match(output.csv, /Unknown — not checked/);
  assert.equal(JSON.parse(output.json).disciplinary_actions, null);
});
test("record text cannot inject HTML or executable spreadsheet formulas", () => {
  const output = exportRegistration({
    ...verified(),
    legal_name: '=HYPERLINK("https://evil.invalid")<script>alert(1)</script>',
  });
  assert.doesNotMatch(output.html, /<script>/);
  assert.match(output.html, /&lt;script&gt;/);
  assert.match(output.csv, /"'=HYPERLINK/);
});
test("the actual keyless CLI plans and replays historical public proof without fresh provider claims or overwrite", async () => {
  const base = await mkdtemp(join(tmpdir(), "tinyverify-cli-"));
  try {
    const request = join(base, "request.json");
    await writeFile(
      request,
      JSON.stringify({
        name: "Example Company",
        jurisdiction: "GB",
        record_type: "company_registration",
      }),
    );
    const printed: string[] = [];
    assert.equal(
      await runCli(["plan", request], (value) => printed.push(value)),
      0,
    );
    assert.equal(JSON.parse(printed[0]!).provider_requests, 0);
    const output = join(base, "replay");
    assert.equal(
      await runCli(
        [
          "replay",
          new URL("../evidence/live-fetch-proof.json", import.meta.url)
            .pathname,
          output,
        ],
        (value) => printed.push(value),
      ),
      0,
    );
    const summary = JSON.parse(
      await readFile(join(output, "replay.json"), "utf8"),
    );
    assert.equal(summary.mode, "historical_saved_proof_replay");
    assert.equal(summary.provider_requests, 0);
    assert.equal(summary.independently_verified_transport, false);
    assert.equal(summary.attempts.length, 2);
    assert.match(
      await readFile(join(output, "record-1.html"), "utf8"),
      /no fresh provider call/,
    );
    await assert.rejects(
      runCli([
        "replay",
        new URL("../evidence/live-fetch-proof.json", import.meta.url).pathname,
        output,
      ]),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
