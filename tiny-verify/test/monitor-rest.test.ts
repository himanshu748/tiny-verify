// Injected responses and synthetic permits only. No genuine provider operations.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { TinyVerifyRuntimeTransport } from "../src/runtime-transport.js";
import { verifyFiniteStatusWatch } from "../src/status-watch.js";
import { FLORIDA_DETAIL_SELECTORS } from "../src/florida.js";
import { runtimeFixture, json, wallet, NOW } from "./runtime-fixtures.js";
import { FL_URL, flRecord, flHtml } from "./florida-fixtures.js";
async function exercise(
  options: {
    metadata?: "absent" | "literal" | "contradictory" | "malformed";
    bad?: "redirect" | "duplicate" | "errors" | "pause" | "empty";
  } = {},
) {
  let now = NOW;
  const f = await runtimeFixture({
    limits: { fetch: 0, agent: 0, monitor_check: 2 },
    monitorTarget: FL_URL,
    clock: () => (now += 20),
  });
  try {
    const id = randomUUID(),
      baseline = randomUUID();
    let name = "",
      paused = false,
      content = 0,
      patches = 0;
    const monitor = () => ({
      id,
      name,
      type: "fetch",
      config: {
        url: FL_URL,
        format: "html",
        links: false,
        image_links: false,
        ttl: 0,
        include_selectors: [...FLORIDA_DETAIL_SELECTORS],
      },
      schedule_cron: "0 0 1 1 *",
      status: paused ? "paused" : "active",
      webhook_url: null,
    });
    const run = (first: boolean) => ({
      id: first || options.bad === "duplicate" ? baseline : randomUUID(),
      ...(options.metadata === "absent"
        ? {}
        : {
            is_baseline:
              options.metadata === "malformed"
                ? "false"
                : options.metadata === "contradictory"
                  ? !first
                  : first,
            outcome:
              options.metadata === "contradictory"
                ? "baseline"
                : first
                  ? "baseline"
                  : "unchanged",
            diff: "EXCLUDED_PARTY_TEXT",
            diff_truncated: false,
          }),
      results:
        !first && options.bad === "errors"
          ? []
          : [
              {
                url: FL_URL,
                final_url:
                  !first && options.bad === "redirect"
                    ? "https://private.invalid/"
                    : FL_URL,
                text: !first && options.bad === "empty" ? " " : flHtml(),
                format: "html",
              },
            ],
      errors:
        !first && options.bad === "errors"
          ? [{ url: FL_URL, error: "fetch_failed" }]
          : [],
    });
    const request: typeof fetch = async (url, init) => {
      const u = String(url),
        method = init?.method ?? "GET";
      if (u.endsWith("/wallet")) return wallet();
      if (u.endsWith("/v1/monitors") && method === "POST") {
        name = JSON.parse(String(init?.body)).name;
        content++;
        return json({ monitor: monitor(), run: run(true) });
      }
      if (u.endsWith("/monitors/" + id) && method === "PATCH") {
        patches++;
        paused = !(options.bad === "pause" && patches >= 2);
        return json({ monitor: monitor() });
      }
      if (u.endsWith("/monitors/" + id) && method === "GET")
        return json({ monitor: monitor() });
      if (u.endsWith("/monitors/" + id + "/runs") && method === "POST") {
        assert.equal(paused, true);
        content++;
        return json({ run: run(false) });
      }
      throw Error("UNEXPECTED_INJECTED_ENDPOINT");
    };
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request,
    });
    let result: Awaited<ReturnType<typeof verifyFiniteStatusWatch>> | null =
        null,
      error: unknown = null;
    try {
      result = await verifyFiniteStatusWatch(
        flRecord("provider"),
        {
          ...f.permit.monitor_window!,
          target_url: FL_URL,
          max_checks: 2,
          no_scheduled_runs: true,
          pause_on_completion: true,
        },
        await t.monitorTransport(),
        undefined,
        f.clock,
      );
    } catch (e) {
      error = e;
    }
    return {
      result,
      error,
      state: await f.ledger.read(),
      receipts: t.receipts,
      content,
      paused,
    };
  } finally {
    await f.cleanup();
  }
}
test("REST baseline/manual without optional metadata succeed with unknowns and a separately labelled client diff", async () => {
  const r = await exercise({ metadata: "absent" });
  assert.equal(r.error, null);
  assert.equal(r.content, 2);
  assert.equal(r.state.halted, false);
  assert.equal(r.paused, true);
  assert.equal(r.result?.comparison_origin, "client_structured_comparison");
  assert.deepEqual(
    r.receipts.map((x) => x.monitor_metadata?.checkpoint_role),
    ["baseline", "followup"],
  );
  for (const x of r.receipts) {
    assert.equal(x.provider_outcome, "unknown");
    assert.equal(x.monitor_metadata?.provider_is_baseline, null);
    assert.equal(x.monitor_metadata?.provider_diff_sha256, null);
    assert.equal(x.monitor_metadata?.provider_diff_truncated, null);
  }
});
test("literal provider flags/outcome remain distinct even when they disagree with request role", async () => {
  const r = await exercise({ metadata: "contradictory" });
  assert.equal(r.error, null);
  assert.equal(
    r.result?.provider_metadata.baseline?.provider_is_baseline,
    false,
  );
  assert.equal(
    r.result?.provider_metadata.followup?.provider_is_baseline,
    true,
  );
  assert.equal(
    r.result?.provider_metadata.followup?.provider_outcome,
    "baseline",
  );
  assert.equal(
    r.result?.provider_metadata.followup?.checkpoint_role,
    "followup",
  );
  assert.equal(r.result?.diff.kind, "unchanged");
});
test("reported diff metadata keeps its digest and literal truncation flag without retaining excluded party text", async () => {
  const r = await exercise({ metadata: "literal" });
  assert.equal(r.error, null);
  assert.match(
    r.receipts[1]?.monitor_metadata?.provider_diff_sha256 ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.equal(r.receipts[1]?.monitor_metadata?.provider_diff_truncated, false);
  assert.doesNotMatch(JSON.stringify(r), /EXCLUDED_PARTY_TEXT/);
});
test("malformed present metadata stops after one attempt and confirms owned cleanup", async () => {
  const r = await exercise({ metadata: "malformed" });
  assert.ok(r.error);
  assert.equal(r.result, null);
  assert.equal(r.content, 1);
  assert.equal(r.state.halted, true);
  assert.equal(r.paused, true);
});
for (const bad of ["redirect", "duplicate", "errors", "empty"] as const)
  test(
    "optional metadata does not admit " + bad + " source results",
    async () => {
      const r = await exercise({ metadata: "absent", bad });
      assert.ok(r.error);
      assert.equal(r.result, null);
      assert.equal(r.content, 2);
      assert.equal(r.state.halted, true);
      assert.equal(r.paused, true);
      assert.equal(r.state.reserved_microusd, 12000);
    },
  );
test("final pause failure remains uncertain despite valid content and absent metadata", async () => {
  const r = await exercise({ metadata: "absent", bad: "pause" });
  assert.ok(r.error);
  assert.equal(r.result, null);
  assert.equal(r.state.halted, true);
  assert.equal(r.content, 2);
  assert.equal(r.paused, false);
});
