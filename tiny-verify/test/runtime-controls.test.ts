import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  readFile,
  writeFile,
  unlink,
  symlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadRuntimeControls,
  validateRuntimePermit,
  RuntimeLedger,
} from "../src/runtime-controls.js";
import { runtimeFixture, NOW, KEY } from "./runtime-fixtures.js";
test("default-disabled controls do not read an invalid permit/key or the halted shared pool", async () => {
  assert.equal(
    await loadRuntimeControls({
      TINYVERIFY_LIVE: "0",
      TINYVERIFY_PERMIT_FILE: "/missing",
      TINYFISH_KEY_FILE: "/missing",
      BOUNTY_POOL_LIVE: "1",
    }),
    undefined,
  );
});
test("the separate permit is exact, finite, private and independent of every earlier pool", async () => {
  const f = await runtimeFixture();
  try {
    assert.equal((await f.ledger.read()).entries.length, 0);
    assert.equal((await stat(f.permit.state_directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(f.permit.state_directory, "ledger.json"))).mode & 0o777,
      0o600,
    );
    for (const permit of [
      { ...f.permit, authorization_basis: "shared_pool" },
      { ...f.permit, agent_beta_enrollment_confirmed: false },
      { ...f.permit, max_reserved_microusd: 1000 },
      { ...f.permit, expires_at: new Date(NOW + 25 * 3600000).toISOString() },
      {
        ...f.permit,
        monitor_window: {
          ...f.permit.monitor_window!,
          expires_at: new Date(NOW + 31 * 60000).toISOString(),
        },
      },
    ])
      assert.throws(() => validateRuntimePermit(permit, () => NOW));
    assert.throws(() => {
      f.ledger.permit.limits.fetch = 0;
    });
  } finally {
    await f.cleanup();
  }
});
test("symlink, public files, mismatched keys and moved permit bindings fail before any transport", async () => {
  const f = await runtimeFixture();
  try {
    await chmod(f.keyFile, 0o644);
    await assert.rejects(loadRuntimeControls(f.env, f.clock));
    await chmod(f.keyFile, 0o600);
    await writeFile(f.keyFile, "TINYFISH_API_KEY=other-synthetic-material");
    await assert.rejects(loadRuntimeControls(f.env, f.clock));
    await writeFile(f.keyFile, "TINYFISH_API_KEY=" + KEY);
    const linked = join(f.directory, "key-link");
    await symlink(f.keyFile, linked);
    await assert.rejects(
      loadRuntimeControls({ ...f.env, TINYFISH_KEY_FILE: linked }, f.clock),
    );
    const moved = join(f.directory, "moved.json");
    await writeFile(moved, await readFile(f.permitFile), { mode: 0o600 });
    await assert.rejects(
      loadRuntimeControls({ ...f.env, TINYVERIFY_PERMIT_FILE: moved }, f.clock),
    );
  } finally {
    await f.cleanup();
  }
});
test("reserved cost and terminal failure survive restart and prevent a second operation", async () => {
  const f = await runtimeFixture();
  try {
    const e = await f.ledger.reserve("agent");
    await f.ledger.finish(e.id, "failure", 21);
    const reloaded = f.reload(),
      state = await reloaded.read();
    assert.equal(state.reserved_microusd, 384000);
    assert.equal(state.entries[0]!.accounted_units, 21);
    assert.equal(state.halted, true);
    await assert.rejects(reloaded.reserve("fetch"));
  } finally {
    await f.cleanup();
  }
});
test("missing state cannot reset an existing grant and corrupted accounting fails closed", async () => {
  const f = await runtimeFixture();
  try {
    const path = join(f.permit.state_directory, "ledger.json"),
      raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, reserved_microusd: 1 }), {
      mode: 0o600,
    });
    await assert.rejects(f.ledger.read());
    await unlink(path);
    await assert.rejects(f.ledger.initialize());
  } finally {
    await f.cleanup();
  }
});
test("concurrent reservations allow only one active operation and uncertainty halts the combined budget", async () => {
  const f = await runtimeFixture();
  try {
    const results = await Promise.allSettled([
      f.ledger.reserve("fetch"),
      f.ledger.reserve("fetch"),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const e = (await f.ledger.read()).entries[0]!;
    await f.ledger.uncertain(e.id);
    await assert.rejects(f.reload().reserve("agent"));
    assert.equal((await f.ledger.read()).reserved_microusd, 1000);
  } finally {
    await f.cleanup();
  }
});
test("expired content is blocked while explicit owned-cleanup loading still works", async () => {
  let now = NOW;
  const f = await runtimeFixture({ clock: () => now });
  try {
    now = NOW + 2 * 3600000;
    await assert.rejects(loadRuntimeControls(f.env, () => now));
    const cleanup = await loadRuntimeControls(f.env, () => now, {
      allowExpiredForCleanup: true,
    });
    assert.ok(cleanup);
    await assert.rejects(cleanup.ledger.eligible("fetch"));
    assert.equal((await cleanup.ledger.read()).entries.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("Monitor claim is one-use and an unpaused newly owned resource blocks later content", async () => {
  const f = await runtimeFixture();
  try {
    const w = f.permit.monitor_window!;
    await f.ledger.claimMonitor({
      ...w,
      name: "tinyverify-" + w.operation_id,
      url: f.permit.monitor_target_url!,
    });
    await assert.rejects(
      f.ledger.claimMonitor({
        ...w,
        name: "tinyverify-" + w.operation_id,
        url: f.permit.monitor_target_url!,
      }),
    );
    const e = await f.ledger.reserve("monitor_check");
    await f.ledger.updateClaim({
      creation_attempted: true,
      monitor_id: randomUUID(),
    });
    await f.ledger.finish(e.id, "success", 1);
    await assert.rejects(f.ledger.reserve("fetch"));
    await f.ledger.updateClaim({ paused_confirmed: true });
    const next = await f.ledger.reserve("fetch");
    assert.equal(next.reserved_microusd, 1000);
    await assert.rejects(f.ledger.updateClaim({ creation_attempted: false }));
  } finally {
    await f.cleanup();
  }
});
