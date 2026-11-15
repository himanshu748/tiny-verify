import assert from "node:assert/strict";
import test from "node:test";
import {
  DisabledRegistryProvider,
  fetchIntent,
  statusMonitorIntent,
  createStatusMonitor,
  lookupRegistration,
  RegistryError,
  syntheticReceipt,
  type RegistryProvider,
} from "../src/index.js";
import { offlineDemo } from "../src/demo.js";
import { UK, UK_ID, T0, record, verified } from "./fixtures.js";
const input = {
  registry: UK,
  by: "registration_id" as const,
  registration_id: UK_ID,
};
const error = (code: RegistryError["code"]) => (value: unknown) =>
  value instanceof RegistryError && value.code === code;

test("default provider refuses all live work without reading credentials or making requests", async () => {
  await assert.rejects(lookupRegistration(input), error("LIVE_DISABLED"));
  await assert.rejects(
    new DisabledRegistryProvider().observe(input),
    error("LIVE_DISABLED"),
  );
});
test("Fetch request preparation allows one official URL and has a finite per-URL timeout", () => {
  const intent = fetchIntent(input);
  assert.equal(intent.kind, "undispatched_fetch_intent");
  assert.equal(intent.endpoint, "https://api.fetch.tinyfish.ai");
  assert.equal(intent.body.urls.length, 1);
  assert.equal(intent.body.per_url_timeout_ms, 45000);
  assert.equal(intent.body.ttl, 0);
});
test("recurring Monitor creation is disabled regardless of prepared descriptor", async () => {
  assert.equal(statusMonitorIntent(verified()).dispatch_allowed, false);
  await assert.rejects(
    createStatusMonitor(verified()),
    error("MONITOR_UNBOUNDED"),
  );
});
test("cancellation before work never calls a provider", async () => {
  let calls = 0;
  const provider: RegistryProvider = {
    async observe() {
      calls++;
      throw new Error("must not be reached");
    },
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    lookupRegistration(input, provider, controller.signal),
    error("CANCELLED"),
  );
  assert.equal(calls, 0);
});
test("cancellation during retrieval discards an observation", async () => {
  const controller = new AbortController();
  const provider: RegistryProvider = {
    async observe() {
      const observation = record();
      controller.abort();
      return { observation, evidence: syntheticReceipt(observation, T0) };
    },
  };
  await assert.rejects(
    lookupRegistration(input, provider, controller.signal),
    error("CANCELLED"),
  );
});
test("the actual offline demo entry produces both registries and labels every receipt synthetic", () => {
  const demo = offlineDemo();
  assert.equal(demo.mode, "synthetic_offline");
  assert.equal(demo.provider_requests, 0);
  assert.equal(demo.registries.length, 2);
  assert.ok(
    demo.registries.every((result) => result.evidence.kind === "synthetic"),
  );
  assert.equal(demo.synthetic_diff.kind, "registration_status_changed");
});
