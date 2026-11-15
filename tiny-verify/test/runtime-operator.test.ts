// Operator fixtures use synthetic private files and injected HTTP only.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runRuntimeOperator } from "../src/operator.js";
import {
  runtimeFixture,
  searchHtml,
  html,
  agentResult,
  json,
  wallet,
  KEY,
  NOW,
  providerRecord,
} from "./runtime-fixtures.js";
const requestInput = {
  name: "Synthetic Company",
  jurisdiction: "GB",
  record_type: "company_registration",
};
test("disabled operator ignores input paths, initialization and supplied credentials before any loader or request", async () => {
  let loads = 0,
    requests = 0;
  for (const argv of [
    ["initialize"],
    ["discover", "/missing", "/missing"],
    ["cleanup", "/missing"],
  ]) {
    const result = await runRuntimeOperator(argv, {
      env: { TINYVERIFY_LIVE: "0", TINYFISH_KEY_FILE: "/missing" },
      write: () => {},
      load: async () => {
        loads++;
        throw Error();
      },
      request: async () => {
        requests++;
        throw Error();
      },
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.summary.status, "disabled");
  }
  assert.equal(loads, 0);
  assert.equal(requests, 0);
});
test("explicit initialization is local-only and cannot reset the bound allowance", async () => {
  const f = await runtimeFixture({ initialize: false });
  try {
    let requests = 0;
    const deps = {
      env: f.env,
      clock: f.clock,
      write: () => {},
      request: async () => {
        requests++;
        throw Error();
      },
    };
    assert.equal((await runRuntimeOperator(["initialize"], deps)).exit_code, 0);
    assert.equal((await runRuntimeOperator(["initialize"], deps)).exit_code, 1);
    assert.equal(
      (await runRuntimeOperator(["status"], deps)).summary.status,
      "local_status",
    );
    assert.equal(requests, 0);
    assert.equal((await f.ledger.read()).entries.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("an existing output or symlink parent stops before key loading and source dispatch", async () => {
  const f = await runtimeFixture();
  try {
    const input = join(f.directory, "request.json"),
      out = join(f.directory, "existing"),
      linked = join(f.directory, "linked");
    await writeFile(input, JSON.stringify(requestInput));
    await mkdir(out, { mode: 0o700 });
    await symlink(out, linked);
    let loads = 0;
    for (const target of [out, join(linked, "child")]) {
      const result = await runRuntimeOperator(["discover", input, target], {
        env: f.env,
        clock: f.clock,
        write: () => {},
        load: async () => {
          loads++;
          throw Error();
        },
      });
      assert.equal(result.exit_code, 1);
    }
    assert.equal(loads, 0);
  } finally {
    await f.cleanup();
  }
});
test("the actual operator discovers, explicitly selects and privately exports one record through its controlled HTTP flow", async () => {
  const f = await runtimeFixture();
  try {
    const input = join(f.directory, "request.json"),
      discovery = join(f.directory, "discovery"),
      detail = join(f.directory, "detail");
    await writeFile(input, JSON.stringify(requestInput));
    let jobs = 0;
    const printed: string[] = [];
    const deps = {
      env: f.env,
      clock: f.clock,
      write: (text: string) => printed.push(text),
      request: (async (url, init) => {
        if (String(url).endsWith("/wallet")) return wallet();
        jobs++;
        const body = JSON.parse(String(init?.body)),
          source = body.urls[0];
        return json({
          results: [
            {
              url: source,
              final_url: source,
              format: "html",
              text: source.includes("/search/") ? searchHtml : html,
            },
          ],
          errors: [],
        });
      }) as typeof fetch,
    };
    assert.equal(
      (await runRuntimeOperator(["discover", input, discovery], deps))
        .exit_code,
      0,
    );
    const found = JSON.parse(
      await readFile(join(discovery, "result.json"), "utf8"),
    );
    assert.equal(found.result.kind, "candidate");
    assert.equal(jobs, 1);
    assert.equal(
      (
        await runRuntimeOperator(
          ["inspect", join(discovery, "result.json"), "ZZ000001", detail],
          deps,
        )
      ).exit_code,
      0,
    );
    assert.equal(jobs, 2);
    const saved = JSON.parse(
      await readFile(join(detail, "record.json"), "utf8"),
    );
    assert.equal(saved.status, "active");
    assert.equal(saved.expiry_date, null);
    assert.equal(saved.disciplinary_actions, null);
    assert.equal(
      (await lstat(join(detail, "record.json"))).mode & 0o777,
      0o600,
    );
    const pricing = JSON.parse(
      await readFile(join(detail, "pricing.json"), "utf8"),
    );
    assert.equal(pricing.length, 1);
    assert.equal(JSON.stringify(pricing).includes("available_balance"), false);
    assert.equal(printed.join("").includes(KEY), false);
    assert.equal((await f.ledger.read()).reserved_microusd, 2000);
  } finally {
    await f.cleanup();
  }
});
test("the operator privately retains the actual validated Agent extraction and caps without a synthetic success substitute", async () => {
  const f = await runtimeFixture();
  try {
    const run = randomUUID(),
      input = join(f.directory, "request.json"),
      out = join(f.directory, "agent");
    await writeFile(input, JSON.stringify(requestInput));
    const result = await runRuntimeOperator(
      ["discover", input, out, "--agent"],
      {
        env: f.env,
        clock: f.clock,
        write: () => {},
        request: async (url) =>
          String(url).endsWith("/wallet")
            ? wallet()
            : String(url).endsWith("run-async")
              ? json({ run_id: run })
              : json({
                  run_id: run,
                  status: "COMPLETED",
                  num_of_steps: 3,
                  result: agentResult,
                }),
      },
    );
    assert.equal(result.exit_code, 0);
    const saved = JSON.parse(
      await readFile(join(out, "agent-extractions.json"), "utf8"),
    );
    assert.equal(saved[0].run_id, run);
    assert.equal(saved[0].result.evidence_quote, agentResult.evidence_quote);
    const observed = JSON.parse(
      await readFile(join(out, "result.json"), "utf8"),
    );
    assert.equal(observed.evidence.kind, "provider");
    assert.equal(observed.evidence.endpoint, "agent");
  } finally {
    await f.cleanup();
  }
});
test("provider failures save controlled diagnosis/reservation evidence and never serialize credentials or raw traces", async () => {
  const f = await runtimeFixture();
  try {
    const input = join(f.directory, "request.json"),
      out = join(f.directory, "failed"),
      printed: string[] = [];
    await writeFile(input, JSON.stringify(requestInput));
    const result = await runRuntimeOperator(["discover", input, out], {
      env: f.env,
      clock: f.clock,
      write: (text) => printed.push(text),
      request: async (url) =>
        String(url).endsWith("/wallet")
          ? wallet()
          : Promise.reject(
              Error(
                "private-body " + KEY + " wss://user:secret@private.invalid/",
              ),
            ),
    });
    assert.equal(result.exit_code, 1);
    const failure = await readFile(join(out, "failure.json"), "utf8"),
      budget = JSON.parse(await readFile(join(out, "budget.json"), "utf8"));
    assert.doesNotMatch(
      failure + printed.join(""),
      /private-body|wss:|user:secret|headers/,
    );
    assert.equal((failure + printed.join("")).includes(KEY), false);
    assert.equal(budget.reserved_microusd, 1000);
    assert.equal(budget.active_or_uncertain, 1);
    assert.equal((await f.ledger.read()).halted, true);
  } finally {
    await f.cleanup();
  }
});
test("expired cleanup makes only exact control requests and reports unresolved ownership as a failed handoff", async () => {
  let now = NOW;
  const f = await runtimeFixture({ clock: () => now });
  try {
    const w = f.permit.monitor_window!;
    await f.ledger.claimMonitor({
      ...w,
      name: "tinyverify-" + w.operation_id,
      url: f.permit.monitor_target_url!,
    });
    const entry = await f.ledger.reserve("monitor_check");
    await f.ledger.updateClaim({ creation_attempted: true });
    await f.ledger.uncertain(entry.id);
    now = NOW + 2 * 3600000;
    const calls: string[] = [];
    const result = await runRuntimeOperator(
      ["cleanup", join(f.directory, "cleanup")],
      {
        env: f.env,
        clock: () => now,
        write: () => {},
        request: async (url) => {
          calls.push(String(url));
          return json({ monitors: [] });
        },
      },
    );
    assert.equal(result.exit_code, 1);
    assert.equal(result.summary.status, "cleanup_required");
    assert.deepEqual(calls, ["https://agent.tinyfish.ai/v1/monitors"]);
    assert.equal((await f.ledger.read()).reserved_microusd, 6000);
    assert.equal((await f.ledger.read()).halted, true);
  } finally {
    await f.cleanup();
  }
});
test("the runnable watch operator uses its exact private Monitor window and retains real-adapter-shaped paused evidence", async () => {
  let now = NOW;
  const f = await runtimeFixture({ clock: () => now++ });
  try {
    const input = join(f.directory, "record.json"),
      output = join(f.directory, "watch"),
      id = randomUUID(),
      target = f.permit.monitor_target_url!;
    await writeFile(input, JSON.stringify(providerRecord()));
    let monitor:
        | {
            id: string;
            name: string;
            type: string;
            config: unknown;
            schedule_cron: string;
            status: string;
            webhook_url: null;
          }
        | undefined,
      manual = 0;
    const result = await runRuntimeOperator(["watch", input, output], {
      env: f.env,
      clock: f.clock,
      write: () => {},
      request: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/wallet")) return wallet();
        if (value.endsWith("/v1/monitors") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          monitor = {
            id,
            name: body.name,
            type: body.type,
            config: body.config,
            schedule_cron: body.schedule_cron,
            status: "active",
            webhook_url: null,
          };
          return json(
            {
              monitor,
              run: {
                id: randomUUID(),
                is_baseline: true,
                outcome: "baseline",
                results: [
                  {
                    url: target,
                    final_url: target,
                    format: "html",
                    text: html,
                  },
                ],
                errors: [],
              },
            },
            201,
          );
        }
        assert.ok(monitor);
        if (init?.method === "PATCH") {
          assert.deepEqual(JSON.parse(String(init.body)), { status: "paused" });
          monitor.status = "paused";
          return json({ monitor });
        }
        if (value.endsWith("/runs")) {
          assert.equal(monitor.status, "paused");
          manual++;
          return json(
            {
              run: {
                id: randomUUID(),
                is_baseline: false,
                outcome: "unchanged",
                results: [
                  {
                    url: target,
                    final_url: target,
                    format: "html",
                    text: html,
                  },
                ],
                errors: [],
              },
            },
            201,
          );
        }
        return json({ monitor });
      },
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.summary.status, "paused_verification_recorded");
    assert.equal(manual, 1);
    const saved = JSON.parse(
      await readFile(join(output, "result.json"), "utf8"),
    );
    assert.equal(saved.paused_confirmed, true);
    assert.equal(saved.diff.kind, "unchanged");
    assert.equal(saved.latest.evidence.endpoint, "monitor");
    assert.equal(
      JSON.parse(await readFile(join(output, "captures.json"), "utf8")).length,
      2,
    );
    assert.equal((await f.ledger.read()).reserved_microusd, 12000);
  } finally {
    await f.cleanup();
  }
});
