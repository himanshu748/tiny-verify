// Injected lifecycle only. No Monitor adapter, schedule or genuine status change is established.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  verifyFiniteStatusWatch,
  type StatusWatchTransport,
} from "../src/status-watch.js";
import { syntheticReceipt } from "../src/parser.js";
import { record, verified } from "./fixtures.js";
const NOW = Date.parse("2026-11-13T00:10:00Z");
function fixture(
  options: {
    status?: string;
    failCreate?: boolean;
    ownedMatches?: number;
    paused?: boolean;
    abort?: AbortController;
    replay?: boolean;
  } = {},
) {
  const baseline = verified(),
    id = randomUUID(),
    operation = randomUUID(),
    run = randomUUID();
  const permit = {
    operation_id: operation,
    authorized_at: new Date(NOW - 60000).toISOString(),
    expires_at: new Date(NOW + 60000).toISOString(),
    target_url: baseline.source_url,
    max_checks: 2,
    no_scheduled_runs: true,
    pause_on_completion: true,
  };
  const owned = {
    id,
    name: "tinyverify-" + operation,
    url: baseline.source_url,
    status: "paused" as const,
  };
  const calls: string[] = [];
  let claimed = false,
    aborted = false;
  const check = (status: string, time: number, runId: string) => {
    const observation = record(undefined, status);
    return {
      monitor_id: id,
      run_id: runId,
      observation,
      evidence: syntheticReceipt(observation, new Date(time).toISOString()),
    };
  };
  const transport: StatusWatchTransport = {
    mode: "synthetic_offline",
    claim: async () => {
      calls.push("claim");
      if (claimed) throw Error("Already claimed");
      claimed = true;
    },
    create: async (body) => {
      calls.push("create");
      assert.equal(body.schedule_cron, "0 0 1 1 *");
      if (options.failCreate) throw Error("Injected uncertain creation");
      return { monitor: owned, baseline: check("Active", NOW - 2000, run) };
    },
    findOwned: async () => {
      calls.push("find");
      return Array(options.ownedMatches ?? 1).fill(owned);
    },
    pause: async (_, signal) => {
      calls.push("pause");
      assert.equal(signal.aborted, false);
      if (options.abort && !aborted) {
        aborted = true;
        options.abort.abort();
      }
    },
    get: async () => {
      calls.push("get");
      return {
        ...owned,
        status: options.paused === false ? "active" : "paused",
      };
    },
    runPaused: async () => {
      calls.push("manual");
      return check(
        options.status ?? "Active",
        NOW - 1000,
        options.replay ? run : randomUUID(),
      );
    },
    halt: async (reason) => {
      calls.push("halt:" + reason);
    },
  };
  return { baseline, permit, transport, calls };
}
test("finite status evaluation claims once, pauses before one manual check and confirms final paused readback", async () => {
  const f = fixture();
  const output = await verifyFiniteStatusWatch(
    f.baseline,
    f.permit,
    f.transport,
    undefined,
    () => NOW,
  );
  assert.equal(output.mode, "synthetic_offline");
  assert.equal(output.diff.kind, "unchanged");
  assert.equal(output.paused_confirmed, true);
  assert.deepEqual(f.calls, [
    "claim",
    "create",
    "pause",
    "get",
    "manual",
    "pause",
    "get",
  ]);
  await assert.rejects(
    verifyFiniteStatusWatch(
      f.baseline,
      f.permit,
      f.transport,
      undefined,
      () => NOW,
    ),
  );
  assert.equal(f.calls.filter((x) => x === "create").length, 1);
});
test("synthetic status change flags the same identifier while an unknown status stays unresolved", async () => {
  for (const [status, kind] of [
    ["Dissolved", "registration_status_changed"],
    ["New unknown status", "status_unresolved"],
  ] as const) {
    const f = fixture({ status });
    const output = await verifyFiniteStatusWatch(
      f.baseline,
      f.permit,
      f.transport,
      undefined,
      () => NOW,
    );
    assert.equal(output.diff.kind, kind);
  }
});
test("default-disabled, expired, wrong-target and mixed-mode verification do not claim or create", async () => {
  const f = fixture();
  await assert.rejects(verifyFiniteStatusWatch(f.baseline, f.permit));
  for (const permit of [
    { ...f.permit, expires_at: new Date(NOW - 1).toISOString() },
    { ...f.permit, target_url: f.permit.target_url + "?other=1" },
    { ...f.permit, max_checks: 3 },
  ])
    await assert.rejects(
      verifyFiniteStatusWatch(
        f.baseline,
        permit,
        f.transport,
        undefined,
        () => NOW,
      ),
    );
  await assert.rejects(
    verifyFiniteStatusWatch(
      f.baseline,
      f.permit,
      { ...f.transport, mode: "provider" },
      undefined,
      () => NOW,
    ),
  );
  assert.equal(f.calls.length, 0);
});
test("a replayed baseline is rejected and every owned failure still pauses with readback", async () => {
  const f = fixture({ replay: true });
  await assert.rejects(
    verifyFiniteStatusWatch(
      f.baseline,
      f.permit,
      f.transport,
      undefined,
      () => NOW,
    ),
  );
  assert.equal(f.calls.filter((x) => x === "manual").length, 1);
  assert.ok(f.calls.includes("halt:verification_failed"));
  assert.deepEqual(f.calls.slice(-3), [
    "pause",
    "get",
    "halt:verification_failed",
  ]);
});
test("uncertain creation is reconciled only by one exact owned match and never starts a manual check", async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(
    verifyFiniteStatusWatch(
      f.baseline,
      f.permit,
      f.transport,
      undefined,
      () => NOW,
    ),
  );
  assert.deepEqual(f.calls, [
    "claim",
    "create",
    "find",
    "pause",
    "get",
    "halt:verification_failed",
  ]);
  for (const ownedMatches of [0, 2]) {
    const other = fixture({ failCreate: true, ownedMatches });
    await assert.rejects(
      verifyFiniteStatusWatch(
        other.baseline,
        other.permit,
        other.transport,
        undefined,
        () => NOW,
      ),
      { code: "REMOTE_STATE_UNCERTAIN" },
    );
    assert.equal(other.calls.includes("pause"), false);
    assert.ok(other.calls.includes("halt:cleanup_unconfirmed"));
  }
});
test("failed pause/readback blocks manual work; caller cancellation gets a fresh cleanup signal", async () => {
  const blocked = fixture({ paused: false });
  await assert.rejects(
    verifyFiniteStatusWatch(
      blocked.baseline,
      blocked.permit,
      blocked.transport,
      undefined,
      () => NOW,
    ),
    { code: "REMOTE_STATE_UNCERTAIN" },
  );
  assert.equal(blocked.calls.includes("manual"), false);
  const abort = new AbortController(),
    cancelled = fixture({ abort });
  await assert.rejects(
    verifyFiniteStatusWatch(
      cancelled.baseline,
      cancelled.permit,
      cancelled.transport,
      abort.signal,
      () => NOW,
    ),
  );
  assert.equal(cancelled.calls.includes("manual"), false);
  assert.deepEqual(cancelled.calls.slice(-3), [
    "pause",
    "get",
    "halt:verification_failed",
  ]);
});
test("unreviewed modes and raw transport or halt errors never escape as private detail", async () => {
  const unknown = fixture();
  await assert.rejects(
    verifyFiniteStatusWatch(
      unknown.baseline,
      unknown.permit,
      {
        ...unknown.transport,
        mode: "unreviewed",
      } as unknown as StatusWatchTransport,
      undefined,
      () => NOW,
    ),
    { code: "MONITOR_INVALID" },
  );
  assert.equal(unknown.calls.length, 0);
  for (const haltFails of [false, true]) {
    const f = fixture({ failCreate: true });
    const transport = {
      ...f.transport,
      create: async () => {
        throw Error("private-credential-and-http-trace");
      },
      ...(haltFails
        ? {
            halt: async () => {
              throw Error("private-state-path-and-credential");
            },
          }
        : {}),
    };
    await assert.rejects(
      verifyFiniteStatusWatch(
        f.baseline,
        f.permit,
        transport,
        undefined,
        () => NOW,
      ),
      (error) => {
        assert.doesNotMatch(String(error), /private-|credential|trace/);
        return true;
      },
    );
  }
});
