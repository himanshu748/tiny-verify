// Real HTTP adapter contracts with injected responses only. No resource or genuine registry event exists.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TinyVerifyRuntimeTransport } from "../src/runtime-transport.js";
import { verifyFiniteStatusWatch } from "../src/status-watch.js";
import {
  runtimeFixture,
  providerRecord,
  html,
  lookup,
  detail,
  agentResult,
  json,
  wallet,
  NOW,
} from "./runtime-fixtures.js";
import { recordSelectors } from "../src/html.js";
function monitorHttp(
  target: string,
  options: {
    changed?: boolean;
    badRun?: boolean;
    badIdentity?: boolean;
    badConfig?: boolean;
    unknownCreate?: boolean;
    abort?: AbortController;
    badManual?: boolean;
    noOwnedMatch?: boolean;
  } = {},
) {
  const id = randomUUID(),
    baselineId = randomUUID(),
    foreign = randomUUID(),
    calls: Array<{ url: string; method: string }> = [];
  let name = "",
    paused = false,
    manual = 0;
  const monitor = () => ({
    id,
    name,
    type: "fetch",
    config: {
      url: target,
      format: "html",
      links: false,
      image_links: false,
      ttl: 0,
      include_selectors: options.badConfig
        ? ["body"]
        : [...recordSelectors("uk_companies_house")],
    },
    schedule_cron: "0 0 1 1 *",
    status: paused ? "paused" : "active",
    webhook_url: null,
  });
  const request: typeof fetch = async (url, init) => {
    const value = String(url),
      method = init?.method ?? "GET";
    calls.push({ url: value, method });
    if (value.endsWith("/wallet")) return wallet();
    if (value.endsWith("/run-async")) return json({ run_id: foreign });
    if (value.includes("/v1/runs/"))
      return json({
        run_id: foreign,
        status: "COMPLETED",
        num_of_steps: 3,
        result: agentResult,
      });
    if (value.startsWith("https://api.fetch.")) {
      const body = JSON.parse(String(init?.body));
      return json({
        results: [
          {
            url: body.urls[0],
            final_url: body.urls[0],
            format: "html",
            text: html,
          },
        ],
        errors: [],
      });
    }
    if (value.endsWith("/v1/monitors") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      name = body.name;
      assert.equal(body.schedule_cron, "0 0 1 1 *");
      assert.equal(body.type, "fetch");
      assert.equal(body.config.url, target);
      assert.deepEqual(
        body.config.include_selectors,
        recordSelectors("uk_companies_house"),
      );
      assert.equal(body.webhook_url, undefined);
      assert.equal(body.max_runs, undefined);
      const result = {
        monitor: options.badIdentity
          ? { ...monitor(), id: foreign, name: "another-monitor" }
          : monitor(),
        run: options.badRun
          ? { id: baselineId }
          : {
              id: baselineId,
              is_baseline: true,
              outcome: "baseline",
              results: [
                { url: target, final_url: target, text: html, format: "html" },
              ],
              errors: [],
            },
      };
      if (options.abort) options.abort.abort();
      if (options.unknownCreate) throw Error("Injected lost response");
      return json(result, 201);
    }
    if (value.endsWith("/v1/monitors") && method === "GET")
      return json({
        monitors: options.noOwnedMatch
          ? []
          : [
              monitor(),
              {
                ...monitor(),
                id: foreign,
                name: "unrelated-private-name",
                config: {
                  ...monitor().config,
                  url: "https://private.invalid/",
                },
              },
            ],
      });
    if (value.endsWith(`/v1/monitors/${id}`) && method === "PATCH") {
      assert.deepEqual(JSON.parse(String(init?.body)), { status: "paused" });
      assert.equal(init?.signal?.aborted, false);
      paused = true;
      return json({ monitor: monitor() });
    }
    if (value.endsWith(`/v1/monitors/${id}`) && method === "GET")
      return json({ monitor: monitor() });
    if (value.endsWith(`/v1/monitors/${id}/runs`)) {
      assert.equal(paused, true);
      manual++;
      return json(
        {
          run: {
            id: options.badManual ? baselineId : randomUUID(),
            is_baseline: false,
            outcome: options.changed ? "changed" : "unchanged",
            results: [
              {
                url: target,
                final_url: target,
                text: options.changed
                  ? html.replace(">Active<", ">Dissolved<")
                  : html,
                format: "html",
              },
            ],
            errors: [],
          },
        },
        201,
      );
    }
    throw Error("Unexpected injected route");
  };
  return {
    request,
    calls,
    id,
    foreign,
    get paused() {
      return paused;
    },
    get manual() {
      return manual;
    },
  };
}
const watchPermit = (f: Awaited<ReturnType<typeof runtimeFixture>>) => ({
  ...f.permit.monitor_window!,
  target_url: f.permit.monitor_target_url!,
  max_checks: 2 as const,
  no_scheduled_runs: true as const,
  pause_on_completion: true as const,
});
test("real Monitor routes perform baseline, immediate paused readback, one manual check and final pause with combined accounting", async () => {
  let tick = NOW;
  const f = await runtimeFixture({ clock: () => tick++ });
  try {
    const h = monitorHttp(f.permit.monitor_target_url!),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    const result = await verifyFiniteStatusWatch(
      providerRecord(),
      watchPermit(f),
      await t.monitorTransport(),
      undefined,
      f.clock,
    );
    assert.equal(result.mode, "provider");
    assert.equal(result.diff.kind, "unchanged");
    assert.equal(result.paused_confirmed, true);
    assert.equal(h.manual, 1);
    assert.equal(h.paused, true);
    const state = await f.ledger.read();
    assert.equal(state.reserved_microusd, 12000);
    assert.equal(state.entries.length, 2);
    assert.ok(state.entries.every((e) => e.state === "terminal"));
    assert.equal(state.claim?.paused_confirmed, true);
    assert.equal(t.receipts.length, 2);
    assert.equal(t.receipts[0]!.provider_outcome, "baseline");
    assert.equal(t.receipts[1]!.provider_outcome, "unchanged");
    assert.equal(t.captures.length, 2);
    assert.equal(t.pricing.length, 2);
    assert.deepEqual(
      t.pricing[0]!.meters.map((m) => m.per),
      ["run", "url"],
    );
    assert.equal(
      JSON.stringify(t.pricing).includes("available_balance"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("Agent, Fetch and both Monitor charges share one durable supplemental ceiling", async () => {
  let tick = NOW;
  const f = await runtimeFixture({ clock: () => tick++ });
  try {
    const h = monitorHttp(f.permit.monitor_target_url!),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await t.observe(detail);
    await t.observeAgent(lookup);
    await verifyFiniteStatusWatch(
      providerRecord(),
      watchPermit(f),
      await t.monitorTransport(),
      undefined,
      f.clock,
    );
    const state = await f.ledger.read();
    assert.equal(state.reserved_microusd, 397000);
    assert.deepEqual(
      state.entries.map((e) => e.kind),
      ["fetch", "agent", "monitor_check", "monitor_check"],
    );
  } finally {
    await f.cleanup();
  }
});
test("a supplied fixture change produces a semantic alert while remaining explicitly injected test evidence", async () => {
  let tick = NOW;
  const f = await runtimeFixture({ clock: () => tick++ });
  try {
    const h = monitorHttp(f.permit.monitor_target_url!, { changed: true }),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    const output = await verifyFiniteStatusWatch(
      providerRecord(),
      watchPermit(f),
      await t.monitorTransport(),
      undefined,
      f.clock,
    );
    assert.equal(output.diff.kind, "registration_status_changed");
    assert.equal(output.latest.evidence.endpoint, "monitor");
    assert.equal(
      output.latest.evidence.provider_run_id,
      t.receipts[1]!.provider_reference,
    );
  } finally {
    await f.cleanup();
  }
});
test("a known owned ID survives malformed baseline content and is cleaned without account-wide listing or manual work", async () => {
  const f = await runtimeFixture();
  try {
    const h = monitorHttp(f.permit.monitor_target_url!, { badRun: true }),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await assert.rejects(
      verifyFiniteStatusWatch(
        providerRecord(),
        watchPermit(f),
        await t.monitorTransport(),
        undefined,
        f.clock,
      ),
    );
    assert.equal(h.manual, 0);
    assert.equal(h.paused, true);
    assert.equal((await f.ledger.read()).claim?.monitor_id, h.id);
    assert.equal(
      h.calls.some((c) => c.method === "GET" && c.url.endsWith("/v1/monitors")),
      false,
    );
    assert.equal((await f.ledger.read()).halted, true);
  } finally {
    await f.cleanup();
  }
});
test("lost creation is reconciled by its exact claim, while foreign or absent matches are never paused", async () => {
  for (const noOwnedMatch of [false, true]) {
    const f = await runtimeFixture();
    try {
      const h = monitorHttp(f.permit.monitor_target_url!, {
          unknownCreate: true,
          noOwnedMatch,
        }),
        t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
          clock: f.clock,
          request: h.request,
        });
      await assert.rejects(
        verifyFiniteStatusWatch(
          providerRecord(),
          watchPermit(f),
          await t.monitorTransport(),
          undefined,
          f.clock,
        ),
      );
      assert.equal(h.manual, 0);
      assert.equal(h.paused, !noOwnedMatch);
      assert.equal(
        h.calls.some((c) => c.method === "PATCH" && c.url.includes(h.foreign)),
        false,
      );
      assert.equal((await f.ledger.read()).entries[0]!.state, "uncertain");
    } finally {
      await f.cleanup();
    }
  }
});
test("configuration drift, foreign identity and replayed run IDs cannot produce a verified watch", async () => {
  for (const option of [
    { badConfig: true },
    { badIdentity: true, noOwnedMatch: true },
    { badManual: true },
  ]) {
    let tick = NOW;
    const f = await runtimeFixture({ clock: () => tick++ });
    try {
      const h = monitorHttp(f.permit.monitor_target_url!, option),
        t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
          clock: f.clock,
          request: h.request,
        });
      await assert.rejects(
        verifyFiniteStatusWatch(
          providerRecord(),
          watchPermit(f),
          await t.monitorTransport(),
          undefined,
          f.clock,
        ),
      );
      assert.equal((await f.ledger.read()).halted, true);
      if (!("badManual" in option)) assert.equal(h.manual, 0);
      assert.equal(
        h.calls.some((c) => c.method === "PATCH" && c.url.includes(h.foreign)),
        false,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("cancellation during creation uses a fresh bounded cleanup signal and starts no manual check", async () => {
  const f = await runtimeFixture();
  try {
    const abort = new AbortController(),
      h = monitorHttp(f.permit.monitor_target_url!, { abort }),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await assert.rejects(
      verifyFiniteStatusWatch(
        providerRecord(),
        watchPermit(f),
        await t.monitorTransport(),
        abort.signal,
        f.clock,
      ),
    );
    assert.equal(h.manual, 0);
    assert.equal(h.paused, true);
    assert.equal((await f.ledger.read()).halted, true);
  } finally {
    await f.cleanup();
  }
});
test("a pricing failure has no dispatched Monitor to reconcile and performs no content or account-list request", async () => {
  const f = await runtimeFixture();
  try {
    const calls: string[] = [],
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: async (url) => {
          calls.push(String(url));
          return wallet({ monitor: "0.006" });
        },
      });
    await assert.rejects(
      verifyFiniteStatusWatch(
        providerRecord(),
        watchPermit(f),
        await t.monitorTransport(),
        undefined,
        f.clock,
      ),
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.endsWith("/wallet"));
    assert.equal((await f.ledger.read()).claim?.creation_attempted, false);
    assert.equal((await f.ledger.read()).entries.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("owned cleanup remains available after expiry without pricing, new content or an unhalt", async () => {
  let tick = NOW;
  const f = await runtimeFixture({ clock: () => tick++ });
  try {
    const h = monitorHttp(f.permit.monitor_target_url!),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await verifyFiniteStatusWatch(
      providerRecord(),
      watchPermit(f),
      await t.monitorTransport(),
      undefined,
      f.clock,
    );
    const before = h.calls.length;
    tick = NOW + 2 * 3600000;
    const cleanup = await t.cleanup();
    assert.equal(cleanup.monitor_paused_confirmed, true);
    assert.ok(
      h.calls
        .slice(before)
        .every(
          (c) =>
            c.method === "PATCH" ||
            (c.method === "GET" && !c.url.endsWith("/wallet")),
        ),
    );
    const state = await f.ledger.read();
    assert.equal(state.reserved_microusd, 12000);
    assert.equal(state.halted, true);
  } finally {
    await f.cleanup();
  }
});
