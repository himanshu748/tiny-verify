// Injected HTTP and synthetic private fixtures only. No actual Florida or TinyFish operation runs.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TinyVerifyRuntimeTransport } from "../src/runtime-transport.js";
import { FLORIDA_DISCOVERY_SCHEMA } from "../src/florida-agent.js";
import {
  RuntimeLedger,
  validateRuntimePermit,
} from "../src/runtime-controls.js";
import { runRuntimeOperator } from "../src/operator.js";
import { verifyFiniteStatusWatch } from "../src/status-watch.js";
import { FLORIDA_DETAIL_SELECTORS, FLORIDA_HOME } from "../src/florida.js";
import { runtimeFixture, json, wallet, NOW } from "./runtime-fixtures.js";
import {
  FL_URL,
  flRequest,
  flHtml,
  flSelection,
  flRecord,
  flSearchAgent,
  flComplaintAgent,
} from "./florida-fixtures.js";
function http(options: { badHistory?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [],
    runs = new Map<string, unknown>();
  let agentCreates = 0;
  const request: typeof fetch = async (url, init) => {
    const u = String(url),
      method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (u.endsWith("/wallet")) return wallet();
    if (u.endsWith("run-async")) {
      agentCreates++;
      assert.deepEqual(body.agent_config, {
        mode: "strict",
        max_steps: 20,
        max_duration_seconds: 150,
      });
      assert.deepEqual(body.proxy_config, { enabled: false });
      assert.equal(body.capture_config.html, false);
      assert.equal(body.use_profile, false);
      assert.equal(body.use_vault, false);
      const id = randomUUID(),
        history = /selected Florida public complaint read/.test(body.goal);
      if (history) {
        assert.equal(body.url, FL_URL);
        assert.match(body.goal, /numeric hidden ID/);
        const result = flComplaintAgent();
        if (options.badHistory) result.detail.observed_form_id = "111";
        runs.set(id, result);
      } else {
        assert.deepEqual(body.output_schema, FLORIDA_DISCOVERY_SCHEMA);
        assert.match(body.goal, /SearchByName/);
        assert.match(body.goal, /Never generate opaque IDs/);
        runs.set(id, flSearchAgent);
      }
      return json({ run_id: id });
    }
    if (u.includes("/v1/runs/")) {
      const id = /\/runs\/([^?]+)/.exec(u)?.[1];
      return json({
        run_id: id,
        status: "COMPLETED",
        num_of_steps: 3,
        result: runs.get(id!),
      });
    }
    if (u.startsWith("https://api.fetch.tinyfish.ai/")) {
      assert.deepEqual(body.urls, [FL_URL]);
      assert.deepEqual(body.include_selectors, FLORIDA_DETAIL_SELECTORS);
      return json({
        results: [
          {
            url: FL_URL,
            final_url: FL_URL,
            format: "html",
            text:
              flHtml() +
              "<p>PRIVATE_ADDRESS_NOT_RETAINED</p><input name='__RequestVerificationToken' value='CSRF_NOT_RETAINED'>",
          },
        ],
        errors: [],
      });
    }
    throw Error("Unexpected injected request");
  };
  return {
    calls,
    request,
    get creates() {
      return agentCreates;
    },
  };
}
test("one Agent-reported navigated candidate preserves Results origin and incomplete raw coverage without dispatching detail work", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 1, agent: 1, monitor_check: 0 },
  });
  try {
    const run = randomUUID(),
      calls: string[] = [];
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request: async (url, init) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/wallet")) return wallet();
        if (u.endsWith("run-async")) {
          const body = JSON.parse(String(init?.body));
          assert.deepEqual(body.output_schema, FLORIDA_DISCOVERY_SCHEMA);
          assert.deepEqual(body.agent_config, {
            mode: "strict",
            max_steps: 20,
            max_duration_seconds: 150,
          });
          assert.match(body.goal, /read only the browser's ACTUAL CURRENT URL/);
          return json({ run_id: run });
        }
        assert.ok(u.includes(`/v1/runs/${run}?`));
        return json({
          run_id: run,
          status: "COMPLETED",
          num_of_steps: 12,
          result: {
            ...flSearchAgent,
            total_results: 2,
            complete: false,
            evidence_quote:
              "Synthetic Results row: Real Estate Corporation; CQ7654321; primary name. Current URL observed after native same-row GET navigation: " +
              FL_URL,
          },
        });
      },
    });
    const result = await t.discoverFlorida(flRequest);
    assert.equal(result.observation.source_url, FLORIDA_HOME);
    assert.equal(result.observation.candidates[0]!.detail_url, FL_URL);
    assert.equal(result.observation.total_results, 2);
    assert.equal(result.observation.complete, false);
    assert.equal(result.coverage, "incomplete_or_unknown");
    assert.equal(result.requires_explicit_selection, true);
    assert.equal(result.result_kind, "selection_required");
    assert.equal(
      result.transport_validation,
      "agent_reported_structured_output_not_independent_browser_capture",
    );
    assert.equal(calls.length, 3);
    assert.equal((await f.ledger.read()).reserved_microusd, 384000);
    assert.equal(t.captures.length, 0);
    // Injected structured output proves preservation, not actual Agent navigation.
  } finally {
    await f.cleanup();
  }
});
test("the runnable Florida operator performs two capped public-form Agent phases around explicit selection and one detail Fetch", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 1, agent: 2, monitor_check: 0 },
  });
  try {
    const h = http(),
      request = join(f.directory, "request.json");
    await writeFile(request, JSON.stringify(flRequest));
    const deps = {
      env: f.env,
      clock: f.clock,
      request: h.request,
      write: () => {},
    };
    const discovery = join(f.directory, "discovery"),
      detail = join(f.directory, "detail"),
      history = join(f.directory, "history");
    assert.equal(
      (await runRuntimeOperator(["fl-discover", request, discovery], deps))
        .exit_code,
      0,
    );
    assert.equal(
      (
        await runRuntimeOperator(
          [
            "fl-inspect",
            join(discovery, "result.json"),
            "CQ7654321",
            FL_URL,
            detail,
          ],
          deps,
        )
      ).exit_code,
      0,
    );
    assert.equal(
      (
        await runRuntimeOperator(
          ["fl-history", join(detail, "record.json"), history],
          deps,
        )
      ).exit_code,
      0,
    );
    const record = JSON.parse(
      await readFile(join(history, "record.json"), "utf8"),
    );
    assert.equal(record.expiry_date, "2028-03-31");
    assert.equal(record.status, "active");
    assert.equal(record.disciplinary_actions.length, 2);
    assert.equal(
      record.complaint_listing.transport_validation,
      "agent_reported_selected_text_not_independent_browser_capture",
    );
    let retained = "";
    for (const dir of [discovery, detail, history])
      for (const file of await readdir(dir))
        retained += await readFile(join(dir, file), "utf8");
    assert.doesNotMatch(
      retained,
      /PRIVATE_ADDRESS_NOT_RETAINED|CSRF_NOT_RETAINED|__RequestVerificationToken|selected_complaint_html/,
    );
    assert.equal(h.creates, 2);
    const state = await f.ledger.read();
    assert.equal(state.reserved_microusd, 769000);
    assert.equal(state.entries.length, 3);
    assert.equal(state.halted, false);
  } finally {
    await f.cleanup();
  }
});

test("completed discovery with a blank second CQ and contaminated detail remains rejected, never repaired into the first candidate", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 1, agent: 1, monitor_check: 0 },
  });
  try {
    const run = randomUUID(),
      calls: string[] = [];
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request: async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/wallet")) return wallet();
        if (u.endsWith("run-async")) return json({ run_id: run });
        if (u.includes("/v1/runs/"))
          return json({
            run_id: run,
            status: "COMPLETED",
            num_of_steps: 19,
            result: {
              ...flSearchAgent,
              total_results: 2,
              candidates: [
                flSearchAgent.candidates[0],
                {
                  ...flSearchAgent.candidates[0],
                  licence_number: "",
                  detail_url: FL_URL.replace("A".repeat(32), "B".repeat(32)),
                },
              ],
              detail: { observed_form_id: "" },
            },
          });
        throw Error("No downstream content after invalid discovery");
      },
    });
    await assert.rejects(t.discoverFlorida(flRequest));
    const state = await f.ledger.read();
    assert.equal(state.halted, true);
    assert.equal(state.reserved_microusd, 384000);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]!.state, "terminal");
    assert.equal(state.entries[0]!.outcome, "failure");
    assert.equal(state.entries[0]!.accounted_units, 19);
    assert.equal(t.agentExtractions.length, 0);
    assert.equal(t.receipts.length, 0);
    assert.equal(t.captures.length, 0);
    assert.equal(t.diagnostics.agent_last_status, "COMPLETED");
    const before = calls.length;
    await assert.rejects(t.inspectFlorida(flSelection("provider")));
    assert.equal(calls.length, before);
  } finally {
    await f.cleanup();
  }
});
test("wrong fresh complaint form identity halts and prevents all later content or wallet reads", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 1, agent: 2, monitor_check: 0 },
  });
  try {
    const h = http({ badHistory: true }),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await t.discoverFlorida(flRequest);
    const result = await t.inspectFlorida(flSelection("provider"));
    await assert.rejects(t.floridaComplaints(result.record));
    const count = h.calls.length;
    await assert.rejects(t.discoverFlorida(flRequest));
    assert.equal(h.calls.length, count);
    assert.equal((await f.ledger.read()).halted, true);
    assert.equal((await f.ledger.read()).entries.at(-1)?.state, "terminal");
    assert.equal(t.captures.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("count-one permits remain valid; adding a second Agent needs a new binding and cannot reset an old ledger", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 0, agent: 1, monitor_check: 0 },
  });
  try {
    const h = http(),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: h.request,
      });
    await t.discoverFlorida(flRequest);
    const count = h.calls.length;
    await assert.rejects(t.discoverFlorida(flRequest));
    assert.equal(h.calls.length, count);
    assert.equal(validateRuntimePermit(f.permit, f.clock).limits.agent, 1);
    const changed = { ...f.permit, limits: { ...f.permit.limits, agent: 2 } };
    assert.equal(validateRuntimePermit(changed, f.clock).limits.agent, 2);
    await assert.rejects(new RuntimeLedger(changed, f.clock).read());
    await assert.rejects(new RuntimeLedger(changed, f.clock).initialize());
    assert.throws(() =>
      validateRuntimePermit(
        { ...changed, limits: { ...changed.limits, agent: 3 } },
        f.clock,
      ),
    );
    assert.equal((await f.ledger.read()).reserved_microusd, 384000);
  } finally {
    await f.cleanup();
  }
});
test("disabled and cancelled Florida commands perform no loader, input, wallet or provider work", async () => {
  let loaded = 0,
    calls = 0;
  for (const command of [
    "fl-discover",
    "fl-inspect",
    "fl-history",
    "fl-watch",
  ]) {
    const result = await runRuntimeOperator(
      [command, "/unread", "/unread-out"],
      {
        env: { TINYVERIFY_LIVE: "0" },
        load: async () => {
          loaded++;
          throw Error();
        },
        request: async () => {
          calls++;
          throw Error();
        },
        write: () => {},
      },
    );
    assert.equal(result.summary.status, "disabled");
  }
  assert.equal(loaded, 0);
  assert.equal(calls, 0);
  const f = await runtimeFixture({
    limits: { fetch: 0, agent: 2, monitor_check: 0 },
  });
  try {
    const a = new AbortController();
    a.abort();
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      request: async () => {
        calls++;
        throw Error();
      },
      clock: f.clock,
    });
    await assert.rejects(t.discoverFlorida(flRequest, a.signal));
    assert.equal(calls, 0);
    assert.equal((await f.ledger.read()).entries.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("Florida finite Monitor checks only its exact GET detail, pauses before manual check, and detects expiry without rechecking complaints", async () => {
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
      manual = 0;
    const configuration = () => ({
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
    const request: typeof fetch = async (url, init) => {
      const u = String(url),
        method = init?.method ?? "GET";
      if (u.endsWith("/wallet")) return wallet();
      if (u.endsWith("/v1/monitors") && method === "POST") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.config.url, FL_URL);
        assert.deepEqual(
          body.config.include_selectors,
          FLORIDA_DETAIL_SELECTORS,
        );
        name = body.name;
        return json({
          monitor: configuration(),
          run: {
            id: baseline,
            is_baseline: true,
            outcome: "baseline",
            results: [
              {
                url: FL_URL,
                final_url: FL_URL,
                text: flHtml(),
                format: "html",
              },
            ],
            errors: [],
          },
        });
      }
      if (u.endsWith(`/monitors/${id}`) && method === "PATCH") {
        paused = true;
        return json({ monitor: configuration() });
      }
      if (u.endsWith(`/monitors/${id}`) && method === "GET")
        return json({ monitor: configuration() });
      if (u.endsWith(`/monitors/${id}/runs`)) {
        assert.equal(paused, true);
        manual++;
        return json({
          run: {
            id: randomUUID(),
            is_baseline: false,
            outcome: "changed",
            results: [
              {
                url: FL_URL,
                final_url: FL_URL,
                text: flHtml({ expiry: "03/31/2029" }),
                format: "html",
              },
            ],
            errors: [],
          },
        });
      }
      throw Error("Unexpected injected control");
    };
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request,
    });
    const result = await verifyFiniteStatusWatch(
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
    assert.equal(result.diff.kind, "licence_fields_changed");
    assert.equal(
      "complaint_history_rechecked" in result.diff &&
        result.diff.complaint_history_rechecked,
      false,
    );
    assert.equal(result.paused_confirmed, true);
    assert.equal(manual, 1);
    assert.equal(t.captures.length, 0);
    assert.equal((await f.ledger.read()).reserved_microusd, 12000);
    assert.equal((await f.ledger.read()).claim?.paused_confirmed, true);
  } finally {
    await f.cleanup();
  }
});

// Reproduces only the publicly disclosed structural failure pattern with invented
// fixture values. It does not replay or infer the failed live run's raw data.
test("completed discovery with non-CQ rows and same-origin unreviewed paths halts before every downstream endpoint", async () => {
  const f = await runtimeFixture({
    limits: { fetch: 1, agent: 1, monitor_check: 2 },
    monitorTarget: FL_URL,
  });
  try {
    const run = randomUUID(),
      calls: Array<string> = [];
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ...flSearchAgent.candidates[0]!,
      licence_number: index === 7 ? "CQ123456" : "ZZ1234567",
      detail_url: FL_URL.replace("/LicenseDetail?", "/UnreviewedResult?"),
    }));
    const request: typeof fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/wallet")) return wallet();
      if (u.endsWith("run-async")) return json({ run_id: run });
      if (u.includes("/v1/runs/"))
        return json({
          run_id: run,
          status: "COMPLETED",
          num_of_steps: 16,
          result: { ...flSearchAgent, candidates },
        });
      throw Error(
        "No downstream endpoint is permitted after invalid discovery",
      );
    };
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request,
    });
    await assert.rejects(t.discoverFlorida(flRequest));
    const state = await f.ledger.read();
    assert.equal(state.halted, true);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]!.state, "terminal");
    assert.equal(state.entries[0]!.accounted_units, 16);
    assert.equal(state.reserved_microusd, 384000);
    assert.equal(t.diagnostics.stage, "agent_validate");
    assert.equal(t.agentExtractions.length, 0);
    assert.equal(t.receipts.length, 0);
    const count = calls.length;
    await assert.rejects(t.inspectFlorida(flSelection("provider")));
    await assert.rejects(t.floridaComplaints(flRecord("provider")));
    await assert.rejects(
      verifyFiniteStatusWatch(
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
      ),
    );
    assert.equal(calls.length, count);
    assert.equal(
      calls.some(
        (u) => u.startsWith("https://api.fetch.") || u.includes("/v1/monitors"),
      ),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
