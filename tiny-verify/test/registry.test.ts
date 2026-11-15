import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSource,
  registrationId,
  parseLookup,
  recordUrl,
  searchUrl,
  resolveObservation,
  syntheticReceipt,
  Evidence,
  RegistryError,
} from "../src/index.js";
import {
  UK,
  AU,
  UK_ID,
  AU_ID,
  T0,
  record,
  search,
  candidate,
  resolveFixture,
  verified,
} from "./fixtures.js";

const error = (code: RegistryError["code"]) => (value: unknown) =>
  value instanceof RegistryError && value.code === code;

test("exact IDs preserve UK leading zeros and validate the official ABN check digits", () => {
  assert.equal(registrationId(UK, " zz000001 "), UK_ID);
  assert.equal(registrationId(AU, "10 000 000 000"), AU_ID);
  // Published ABR checksum example; this validates arithmetic only, not registry membership.
  assert.equal(registrationId(AU, "51 824 753 556"), "51824753556");
  assert.throws(
    () => registrationId(AU, "51824753557"),
    error("INVALID_INPUT"),
  );
  assert.throws(() => registrationId(UK, "1234"), error("INVALID_INPUT"));
});
test("lookup is bounded and URLs or action strings cannot become arbitrary fetch targets", () => {
  assert.throws(
    () =>
      parseLookup({ registry: UK, by: "name", name: "https://example.com" }),
    error("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      parseLookup({
        registry: UK,
        by: "name",
        name: "Good Ltd",
        url: "https://example.com",
      }),
    error("INVALID_INPUT"),
  );
  assert.equal(
    searchUrl(UK, "Synthetic A & B Ltd"),
    "https://find-and-update.company-information.service.gov.uk/search/companies?q=Synthetic+A+%26+B+Ltd",
  );
  assert.equal(
    canonicalSource(UK, searchUrl(UK, "Synthetic A & B Ltd")),
    searchUrl(UK, "Synthetic A & B Ltd"),
  );
});
test("source URL rejects lookalike hosts, redirects, credentials and extra query scope", () => {
  for (const source of [
    "https://find-and-update.company-information.service.gov.uk.evil.example/company/ZZ000001",
    "https://user:pass@find-and-update.company-information.service.gov.uk/company/ZZ000001",
    "https://find-and-update.company-information.service.gov.uk/company/%5A%5A000001",
    recordUrl(UK, UK_ID) + "?redirect=https://example.com",
    searchUrl(UK, "Synthetic Ltd") + "&q=Other",
  ])
    assert.throws(() => canonicalSource(UK, source), error("SITE_CHANGED"));
});
test("both registry observations produce typed registration records with provenance", () => {
  const uk = verified();
  const au = verified(record(AU));
  assert.equal(uk.status, "active");
  assert.equal(au.status_effective_from, "1999-11-01");
  assert.equal(au.registration_basis, "australian_abn_register");
  assert.equal(au.evidence.kind, "synthetic");
  assert.equal(au.evidence.provider_run_id, null);
  assert.match(au.warnings[0]!, /not professional/);
});
test("unknown status and invalid effective dates remain unresolved", () => {
  assert.equal(
    verified(record(UK, "Active — proposal to strike off")).status,
    "unknown",
  );
  assert.equal(
    verified(record(AU, "Cancelled from 31 Feb 2026")).status,
    "unknown",
  );
  assert.equal(
    verified(record(AU, "Cancelled from 29 Feb 2024")).status_effective_from,
    "2024-02-29",
  );
  assert.equal(verified(record(UK, "Liquidation")).status, "insolvency");
});
test("effective dates require a recognized complete month token", () => {
  assert.equal(
    verified(record(AU, "Active from 01 Novemberish 2026")).status,
    "unknown",
  );
  assert.equal(
    verified(record(AU, "Active from 01 November 2026")).status_effective_from,
    "2026-11-01",
  );
});
test("missing, conflicting and cross-identity source fields fail loudly", () => {
  const missing = record();
  missing.fields = missing.fields.filter(
    (field) => field.label !== "Company status",
  );
  assert.throws(() => resolveFixture(missing), error("SITE_CHANGED"));
  const duplicate = record();
  duplicate.fields.push({ label: "Company status:", value: "Dissolved" });
  assert.throws(() => resolveFixture(duplicate), error("SITE_CHANGED"));
  const other = record();
  other.fields[0]!.value = "ZZ000002";
  assert.throws(() => resolveFixture(other), error("SITE_CHANGED"));
});
test("changed fields, source URLs or requested identities cannot reuse a receipt", () => {
  const observation = record(),
    receipt = syntheticReceipt(observation, T0);
  observation.fields[2]!.value = "Dissolved";
  assert.throws(
    () => resolveFixture(observation, T0, receipt),
    error("EVIDENCE_MISMATCH"),
  );
  const fresh = record();
  assert.throws(
    () =>
      resolveObservation(
        { registry: UK, by: "registration_id", registration_id: "ZZ000002" },
        fresh,
        syntheticReceipt(fresh, T0),
      ),
    error("SITE_CHANGED"),
  );
  const wrongSource = {
    ...syntheticReceipt(fresh, T0),
    source_url: recordUrl(UK, "ZZ000002"),
  };
  assert.throws(
    () => resolveFixture(fresh, T0, wrongSource),
    error("EVIDENCE_MISMATCH"),
  );
});
test("synthetic receipts cannot claim provider runs or endpoints", () => {
  const receipt = syntheticReceipt(record(), T0);
  assert.equal(
    Evidence.safeParse({ ...receipt, endpoint: "agent" }).success,
    false,
  );
  assert.equal(
    Evidence.safeParse({ ...receipt, provider_run_id: "made-up-run" }).success,
    false,
  );
  assert.equal(
    Evidence.safeParse({ ...receipt, kind: "provider", endpoint: "agent" })
      .success,
    false,
  );
});
test("a unique current exact name is a candidate requiring a separate detail lookup", () => {
  const result = resolveFixture(search());
  assert.equal(result.kind, "candidate");
  if (result.kind === "candidate")
    assert.equal(result.requires_detail_check, true);
});
test("distinct IDs sharing a name remain ambiguous", () => {
  const result = resolveFixture(search([candidate(), candidate("ZZ000002")]));
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.equal(result.candidates.length, 2);
});
test("aliases for one ID collapse without treating historic names as current legal names", () => {
  const alias = candidate(
    UK_ID,
    "Synthetic Lantern Labs Ltd",
    UK,
    "historic_name",
  );
  assert.equal(resolveFixture(search([alias])).kind, "ambiguous");
  const result = resolveFixture(search([alias, candidate()]));
  assert.equal(result.kind, "candidate");
  if (result.kind === "candidate")
    assert.equal(result.candidate.match_kind, "entity_name");
  const conflicting = search([
    candidate(),
    candidate(UK_ID, "Synthetic Other Ltd"),
  ]);
  assert.throws(() => resolveFixture(conflicting), error("SITE_CHANGED"));
});
test("legal suffixes and fuzzy matches are not silently normalized into exact identity", () => {
  assert.equal(
    resolveFixture(search([candidate(UK_ID, "Synthetic Lantern Labs Limited")]))
      .kind,
    "ambiguous",
  );
});
test("filtered, truncated and uncorroborated empty pages cannot establish absence", () => {
  const truncated = search([]);
  truncated.complete = false;
  truncated.total_results = 200;
  assert.equal(resolveFixture(truncated).kind, "incomplete");
  const activeOnly = search([], AU, "Synthetic Lantern Labs Pty Ltd");
  activeOnly.scope = "active_only";
  activeOnly.source_url = activeOnly.source_url.replace(
    "/ResultsAll",
    "/ResultsActive",
  );
  assert.equal(resolveFixture(activeOnly).kind, "incomplete");
  const empty = search([]);
  empty.empty_message_present = false;
  assert.throws(() => resolveFixture(empty), error("SITE_CHANGED"));
  const completeEmpty = resolveFixture(search([]));
  assert.equal(completeEmpty.kind, "not_found");
  if (completeEmpty.kind === "not_found")
    assert.match(completeEmpty.meaning, /not a negative licensing verdict/);
});
test("coverage contradictions and a different echoed query fail rather than drop rows", () => {
  const observation = search();
  observation.total_results = 4;
  assert.throws(() => resolveFixture(observation), error("SITE_CHANGED"));
  const query = search();
  query.query = "Synthetic Other Ltd";
  assert.throws(() => resolveFixture(query), error("SITE_CHANGED"));
});
test("blocked, not-found and provider-error remain distinct outcomes", () => {
  const base = { registry: UK, source_url: recordUrl(UK, UK_ID) };
  assert.equal(
    resolveFixture({ ...base, kind: "blocked", reason: "captcha" }).kind,
    "blocked",
  );
  assert.equal(
    resolveFixture({ ...base, kind: "not_found", http_status: 404 }).kind,
    "not_found",
  );
  assert.equal(
    resolveFixture({ ...base, kind: "provider_error", reason: "timeout" }).kind,
    "provider_error",
  );
});
