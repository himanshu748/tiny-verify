import assert from "node:assert/strict";
import test from "node:test";
import {
  compareRegistration,
  RegistryError,
  recordUrl,
  syntheticReceipt,
} from "../src/index.js";
import {
  AU,
  UK,
  UK_ID,
  T0,
  T1,
  record,
  verified,
  resolveFixture,
} from "./fixtures.js";
const error = (code: RegistryError["code"]) => (value: unknown) =>
  value instanceof RegistryError && value.code === code;

test("observed ABN cancellation emits a semantic status diff for the same exact ID", () => {
  const before = verified(record(AU));
  const later = resolveFixture(record(AU, "Cancelled from 09 Nov 2026"), T1);
  const diff = compareRegistration(before, later);
  assert.equal(diff.kind, "registration_status_changed");
  assert.deepEqual(
    diff.changes.map((change) => change.field),
    ["status", "status_effective_from"],
  );
  assert.equal(diff.baseline_retained, false);
});
test("receipt time and unrelated observation text do not create semantic changes", () => {
  const before = verified(),
    observation = record();
  observation.title = "SYNTHETIC different page decoration";
  const diff = compareRegistration(before, resolveFixture(observation, T1));
  assert.equal(diff.kind, "unchanged");
  assert.deepEqual(diff.changes, []);
});
test("name changes are metadata changes rather than registration status changes", () => {
  const observation = record();
  observation.fields[1]!.value = "Synthetic New Name Ltd";
  const diff = compareRegistration(verified(), resolveFixture(observation, T1));
  assert.equal(diff.kind, "metadata_changed");
  assert.equal(diff.changes[0]?.field, "legal_name");
});
test("unknown status preserves the previous baseline", () => {
  const diff = compareRegistration(
    verified(),
    resolveFixture(record(UK, "Source layout changed"), T1),
  );
  assert.equal(diff.kind, "status_unresolved");
  assert.equal(diff.baseline_retained, true);
  assert.deepEqual(diff.changes, []);
});
for (const observation of [
  {
    registry: UK,
    source_url: recordUrl(UK, UK_ID),
    kind: "blocked" as const,
    reason: "access_denied" as const,
  },
  {
    registry: UK,
    source_url: recordUrl(UK, UK_ID),
    kind: "not_found" as const,
    http_status: 404 as const,
  },
  {
    registry: UK,
    source_url: recordUrl(UK, UK_ID),
    kind: "provider_error" as const,
    reason: "timeout" as const,
  },
])
  test(`${observation.kind} creates a retrieval gap, never dissolution`, () => {
    const diff = compareRegistration(
      verified(),
      resolveFixture(observation, T1),
    );
    assert.equal(diff.kind, "observation_gap");
    assert.equal(diff.baseline_retained, true);
    assert.deepEqual(diff.changes, []);
  });
test("replayed timestamps and a different entity cannot advance history", () => {
  assert.throws(
    () => compareRegistration(verified(), resolveFixture(record(), T0)),
    error("EVIDENCE_MISMATCH"),
  );
  const different = record(UK, "Dissolved", "ZZ000002");
  const evidence = syntheticReceipt(different, T1);
  assert.throws(
    () =>
      compareRegistration(verified(), {
        kind: "blocked",
        registry: UK,
        source_url: different.source_url,
        evidence,
        reason: "captcha",
      }),
    error("EVIDENCE_MISMATCH"),
  );
});
test("a result cannot substitute a different receipt around a parsed record", () => {
  const later = resolveFixture(record(), T1);
  const wrong = {
    ...later,
    evidence: { ...later.evidence, observation_sha256: "a".repeat(64) },
  };
  assert.throws(
    () => compareRegistration(verified(), wrong),
    error("EVIDENCE_MISMATCH"),
  );
});
test("synthetic and provider histories cannot be joined", () => {
  const later = resolveFixture(record(), T1);
  const wrong = {
    ...later,
    evidence: {
      ...later.evidence,
      kind: "provider" as const,
      endpoint: "fetch" as const,
    },
  };
  assert.throws(
    () => compareRegistration(verified(), wrong),
    error("EVIDENCE_MISMATCH"),
  );
});
