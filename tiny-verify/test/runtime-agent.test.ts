// Every HTTP response is injected; these tests do not claim an actual Agent run.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AGENT_OUTPUT_SCHEMA,
  assertAgentOutputSchema,
  TinyVerifyRuntimeTransport,
} from "../src/runtime-transport.js";
import {
  runtimeFixture,
  lookup,
  agentResult,
  json,
  wallet,
  KEY,
} from "./runtime-fixtures.js";
import { resolveObservation } from "../src/parser.js";
test("the entire nullable Agent schema uses the current supported wire subset", () => {
  assertAgentOutputSchema(AGENT_OUTPUT_SCHEMA);
  assert.equal(AGENT_OUTPUT_SCHEMA.properties.total_results.nullable, true);
  assert.equal(AGENT_OUTPUT_SCHEMA.properties.stop_reason.nullable, true);
  assert.deepEqual(
    [...AGENT_OUTPUT_SCHEMA.required].sort(),
    Object.keys(AGENT_OUTPUT_SCHEMA.properties).sort(),
  );
  for (const schema of [
    { type: ["string"] },
    { type: ["string", "null"] },
    {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    },
    { type: "null" },
  ])
    assert.throws(() => assertAgentOutputSchema(schema));
});
test("one capped async Agent query retains exact source identity, reported steps and a validated-result receipt", async () => {
  const f = await runtimeFixture();
  try {
    const run = randomUUID(),
      calls: string[] = [];
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request: async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/wallet")) return wallet();
        if (String(url).endsWith("run-async")) {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.url, agentResult.source_url);
          assert.deepEqual(body.agent_config, {
            mode: "strict",
            max_steps: 20,
            max_duration_seconds: 150,
          });
          assert.deepEqual(body.proxy_config, { enabled: false });
          assert.equal(body.use_profile, false);
          assert.equal(body.use_vault, false);
          assert.deepEqual(body.output_schema, AGENT_OUTPUT_SCHEMA);
          return json({ run_id: run, error: null });
        }
        return json({
          run_id: run,
          status: "COMPLETED",
          num_of_steps: 21,
          result: JSON.stringify(agentResult),
        });
      },
    });
    const output = await t.observeAgent(lookup);
    assert.equal(
      resolveObservation(lookup, output.observation, output.evidence).kind,
      "candidate",
    );
    assert.equal(output.evidence.provider_run_id, run);
    assert.equal(
      t.agentExtractions[0]!.result.evidence_quote,
      agentResult.evidence_quote,
    );
    assert.equal(
      t.agentExtractions[0]!.result_sha256,
      output.transport.content_sha256,
    );
    assert.equal(calls.length, 3);
    const state = await f.ledger.read();
    assert.equal(state.reserved_microusd, 384000);
    assert.equal(state.entries[0]!.accounted_units, 21);
    assert.equal(state.halted, false);
  } finally {
    await f.cleanup();
  }
});
test("invalid completed identity, nullable output or over-reservation accounting halt without another dispatch", async () => {
  for (const [result, steps] of [
    [{ ...agentResult, source_url: agentResult.source_url + "&other=1" }, 10],
    [{ ...agentResult, total_results: null }, 10],
    [
      {
        ...agentResult,
        candidates: [
          {
            ...agentResult.candidates[0]!,
            source_url: agentResult.candidates[0]!.source_url.replace(
              "ZZ000001",
              "ZZ000002",
            ),
          },
        ],
      },
      10,
    ],
    [agentResult, 25],
  ] as const) {
    const f = await runtimeFixture();
    try {
      const run = randomUUID();
      let calls = 0;
      const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: async (url) => {
          calls++;
          return String(url).endsWith("/wallet")
            ? wallet()
            : String(url).endsWith("run-async")
              ? json({ run_id: run })
              : json({
                  run_id: run,
                  status: "COMPLETED",
                  num_of_steps: steps,
                  result,
                });
        },
      });
      await assert.rejects(t.observeAgent(lookup));
      const before = calls;
      assert.equal((await f.ledger.read()).halted, true);
      await assert.rejects(t.observeAgent(lookup));
      assert.equal(calls, before);
      assert.equal(t.captures.length, 0);
    } finally {
      await f.cleanup();
    }
  }
});
test("an explicit blocked Agent result retains a gap and halts rather than inventing no-match", async () => {
  const f = await runtimeFixture();
  try {
    const run = randomUUID(),
      t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: async (url) =>
          String(url).endsWith("/wallet")
            ? wallet()
            : String(url).endsWith("run-async")
              ? json({ run_id: run })
              : json({
                  run_id: run,
                  status: "COMPLETED",
                  num_of_steps: 3,
                  result: {
                    ...agentResult,
                    state: "blocked",
                    complete: false,
                    total_results: null,
                    candidates: [],
                    stop_reason: "captcha",
                    evidence_quote: "Fixture challenge",
                  },
                }),
      });
    const output = await t.observeAgent(lookup);
    assert.equal(output.observation.kind, "blocked");
    assert.equal((await f.ledger.read()).halted, true);
  } finally {
    await f.cleanup();
  }
});
test("unknown enqueue state retains its reservation, exposes no raw error and never retries", async () => {
  const f = await runtimeFixture();
  try {
    let calls = 0;
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request: async (url) => {
        calls++;
        if (String(url).endsWith("/wallet")) return wallet();
        throw Error("private request " + KEY);
      },
    });
    await assert.rejects(t.observeAgent(lookup), (error) => {
      assert.equal(String(error).includes(KEY), false);
      return true;
    });
    const state = await f.ledger.read();
    assert.equal(state.entries[0]!.state, "uncertain");
    assert.equal(state.entries[0]!.reference, null);
    await assert.rejects(t.observeAgent(lookup));
    assert.equal(calls, 2);
  } finally {
    await f.cleanup();
  }
});
test("caller cancellation cancels only its known run and independently reads back terminal state", async () => {
  const f = await runtimeFixture();
  try {
    const abort = new AbortController(),
      run = randomUUID();
    let cancelled = false,
      cancelCalls = 0;
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      pause: async () => {},
      request: async (url, init) => {
        if (String(url).endsWith("/wallet")) return wallet();
        if (String(url).endsWith("run-async")) return json({ run_id: run });
        if (String(url).endsWith("/cancel")) {
          assert.match(String(url), new RegExp(run));
          assert.equal(init?.method, "POST");
          cancelled = true;
          cancelCalls++;
          return json({ run_id: run, status: "CANCELLED" });
        }
        if (!cancelled) {
          abort.abort();
          return json({ run_id: run, status: "RUNNING", num_of_steps: 2 });
        }
        return json({ run_id: run, status: "CANCELLED", num_of_steps: 4 });
      },
    });
    await assert.rejects(t.observeAgent(lookup, abort.signal));
    assert.equal(cancelCalls, 1);
    assert.equal(t.diagnostics.caller_cancelled, true);
    assert.equal(t.diagnostics.client_deadline_expired, false);
    assert.equal(t.diagnostics.agent_terminal_confirmed, true);
    assert.equal((await f.ledger.read()).entries[0]!.state, "terminal");
  } finally {
    await f.cleanup();
  }
});
test(
  "an unresponsive injected transport respects the smaller client test deadline and receives bounded cleanup",
  { timeout: 5000 },
  async () => {
    const f = await runtimeFixture();
    // The fake unresolved request has no socket handle. Keep this test alive for
    // Node's unreferenced AbortSignal.timeout; the runtime deadline stays unchanged.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const run = randomUUID();
      let cancelled = false;
      const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        agentDeadlineMs: 50,
        request: async (url) => {
          if (String(url).endsWith("/wallet")) return wallet();
          if (String(url).endsWith("run-async")) return json({ run_id: run });
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return json({ run_id: run, status: "CANCELLED" });
          }
          if (cancelled)
            return json({ run_id: run, status: "CANCELLED", num_of_steps: 2 });
          return new Promise<Response>(() => {});
        },
      });
      await assert.rejects(t.observeAgent(lookup));
      assert.equal(t.diagnostics.client_deadline_expired, true);
      assert.equal(t.diagnostics.caller_cancelled, false);
      assert.equal(t.diagnostics.agent_terminal_confirmed, true);
      assert.equal((await f.ledger.read()).halted, true);
      assert.throws(
        () =>
          new TinyVerifyRuntimeTransport(f.ledger, f.key, {
            agentDeadlineMs: 175001,
          }),
      );
    } finally {
      clearInterval(keepAlive);
      await f.cleanup();
    }
  },
);
test("exact price or permit exhaustion blocks content and future wallet reads", async () => {
  const f = await runtimeFixture();
  try {
    let creates = 0,
      wallets = 0;
    const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
      clock: f.clock,
      request: async (url) => {
        if (String(url).endsWith("/wallet")) {
          wallets++;
          return wallet({ agent: "0.017" });
        }
        creates++;
        throw Error();
      },
    });
    await assert.rejects(t.observeAgent(lookup));
    await assert.rejects(t.observeAgent(lookup));
    assert.equal(wallets, 1);
    assert.equal(creates, 0);
    assert.equal((await f.ledger.read()).entries.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("owned cleanup reports actual terminal status and result presence without accepting late results or reopening the halted ledger", async () => {
  for (const status of ["COMPLETED", "CANCELLED", "FAILED"] as const) {
    const f = await runtimeFixture({
      limits: { fetch: 0, agent: 1, monitor_check: 0 },
    });
    try {
      const run = randomUUID(),
        entry = await f.ledger.reserve("agent"),
        calls: string[] = [];
      await f.ledger.started(entry.id, run);
      await f.ledger.uncertain(entry.id);
      const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: async (url, init) => {
          const u = String(url);
          calls.push(u);
          if (u.endsWith(`/runs/${run}/cancel`) && init?.method === "POST")
            return json({});
          assert.equal(
            u.endsWith(`/runs/${run}?screenshots=none&html=none`),
            true,
          );
          assert.equal(init?.method, "GET");
          return json({
            run_id: run,
            status,
            num_of_steps: 19,
            ...(status === "COMPLETED"
              ? {
                  result: { rejected_private_result: "NEVER_RETAIN_LATE_BODY" },
                }
              : { result: null }),
          });
        },
      });
      const cleanup = await t.cleanup();
      assert.equal(cleanup.agent_terminal_confirmed, true);
      assert.equal(cleanup.monitor_paused_confirmed, true);
      assert.deepEqual(cleanup.agent_terminal_readbacks, [
        {
          status,
          result_available: status === "COMPLETED",
          reported_steps: 19,
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(cleanup),
        new RegExp(`${run}|NEVER_RETAIN|rejected_private_result`),
      );
      const state = await f.ledger.read();
      assert.equal(state.halted, true);
      assert.equal(state.reserved_microusd, 384000);
      assert.equal(state.entries[0]!.state, "terminal");
      assert.equal(state.entries[0]!.outcome, "failure");
      assert.equal(state.entries[0]!.accounted_units, 19);
      assert.equal(t.agentExtractions.length, 0);
      assert.equal(t.receipts.length, 0);
      assert.equal(t.captures.length, 0);
      assert.equal(calls.length, 2);
      await assert.rejects(t.observeAgent(lookup));
      assert.equal(calls.length, 2);
      assert.deepEqual((await t.cleanup()).agent_terminal_readbacks, []);
      assert.equal(calls.length, 2);
    } finally {
      await f.cleanup();
    }
  }
});
test("cleanup with wrong owned identity, nonterminal status or over-cap steps retains uncertainty and exposes no result metadata", async () => {
  for (const patch of [
    { run_id: randomUUID() },
    { status: "RUNNING" },
    { num_of_steps: 25 },
  ]) {
    const f = await runtimeFixture({
      limits: { fetch: 0, agent: 1, monitor_check: 0 },
    });
    try {
      const run = randomUUID(),
        entry = await f.ledger.reserve("agent");
      await f.ledger.started(entry.id, run);
      await f.ledger.uncertain(entry.id);
      const t = new TinyVerifyRuntimeTransport(f.ledger, f.key, {
        clock: f.clock,
        request: async (url) =>
          String(url).endsWith("/cancel")
            ? json({})
            : json({
                run_id: run,
                status: "COMPLETED",
                num_of_steps: 19,
                result: "NEVER_RETAIN_LATE_BODY",
                ...patch,
              }),
      });
      const cleanup = await t.cleanup();
      assert.equal(cleanup.agent_terminal_confirmed, false);
      assert.deepEqual(cleanup.agent_terminal_readbacks, []);
      assert.doesNotMatch(JSON.stringify(cleanup), /NEVER_RETAIN/);
      const state = await f.ledger.read();
      assert.equal(state.halted, true);
      assert.equal(state.halt_reason, "cleanup_unconfirmed");
      assert.equal(state.entries[0]!.state, "uncertain");
      assert.equal(state.reserved_microusd, 384000);
    } finally {
      await f.cleanup();
    }
  }
});
