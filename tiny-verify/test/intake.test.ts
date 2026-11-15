import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverBusiness,
  inspectBusinessSelection,
  prepareBusinessRequest,
} from "../src/intake.js";
import { syntheticReceipt } from "../src/parser.js";
import { recordUrl } from "../src/registries.js";
import { parseSearchHtml } from "../src/search-html.js";
import type { RegistryProvider } from "../src/provider.js";
import { searchUrl } from "../src/registries.js";
const request = {
  name: "Synthetic Company",
  jurisdiction: "GB",
  record_type: "company_registration",
} as const;
const search = () =>
  parseSearchHtml(
    { by: "name", registry: "uk_companies_house", name: request.name },
    '<h1>Search results</h1><div id="search-meta">1 matches found</div><ul id="results"><li><h3><a href="/company/ZZ000001">Synthetic Company</a></h3></li></ul>',
    searchUrl("uk_companies_house", request.name),
  );
test("name, supported record type and jurisdiction form a zero-call scoped plan", () => {
  const plan = prepareBusinessRequest(request);
  assert.equal(plan.provider_requests, 0);
  assert.equal(plan.lookup.registry, "uk_companies_house");
  assert.equal(
    prepareBusinessRequest({
      ...request,
      jurisdiction: "AU",
      record_type: "abn_registration",
    }).lookup.registry,
    "au_abn_lookup",
  );
  for (const value of [
    { ...request, jurisdiction: "US" },
    { ...request, record_type: "medical_licence" },
    { ...request, name: "https://evil.invalid" },
    { ...request, url: "https://evil.invalid" },
  ])
    assert.throws(() => prepareBusinessRequest(value));
});
test("default discovery is disabled and imports or plans do not obtain credentials", async () => {
  await assert.rejects(discoverBusiness(request), { code: "LIVE_DISABLED" });
});
test("one discovery and explicit selected detail lookup preserve the request and exact registration identity", async () => {
  const calls: string[] = [];
  const provider: RegistryProvider = {
    observe: async (lookup) => {
      calls.push(lookup.by);
      const observation =
        lookup.by === "name"
          ? search()
          : {
              kind: "record" as const,
              registry: lookup.registry,
              source_url: recordUrl(lookup.registry, lookup.registration_id),
              title: "Synthetic Company",
              fields: [
                { label: "Company number", value: lookup.registration_id },
                { label: "Company name", value: "Synthetic Company" },
                { label: "Company status", value: "Active" },
              ],
            };
      return {
        observation,
        evidence: syntheticReceipt(observation, "2026-11-13T00:00:00Z"),
      };
    },
  };
  const discovered = await discoverBusiness(request, provider);
  assert.equal(discovered.result.kind, "candidate");
  assert.deepEqual(calls, ["name"]);
  const inspected = await inspectBusinessSelection(
    request,
    discovered,
    "ZZ000001",
    provider,
  );
  assert.deepEqual(calls, ["name", "registration_id"]);
  assert.equal(inspected.result.kind, "verified");
  assert.deepEqual(inspected.request, request);
  if (inspected.result.kind === "verified") {
    assert.equal(inspected.result.record.expiry_date, null);
    assert.equal(inspected.result.record.disciplinary_actions, null);
    assert.equal(
      inspected.result.record.field_coverage.disciplinary_actions,
      "not_checked_by_business_registration_adapter",
    );
  }
});
test("a different selected identifier, changed query, altered receipt or cancellation dispatches no detail work", async () => {
  const observation = search(),
    discovery = {
      observation,
      evidence: syntheticReceipt(observation, "2026-11-13T00:00:00Z"),
    };
  let calls = 0;
  const provider: RegistryProvider = {
    observe: async () => {
      calls++;
      throw Error("Must not dispatch");
    },
  };
  await assert.rejects(
    inspectBusinessSelection(request, discovery, "ZZ000002", provider),
  );
  await assert.rejects(
    inspectBusinessSelection(
      { ...request, name: "Different Company" },
      discovery,
      "ZZ000001",
      provider,
    ),
  );
  await assert.rejects(
    inspectBusinessSelection(
      request,
      {
        ...discovery,
        evidence: { ...discovery.evidence, observation_sha256: "0".repeat(64) },
      },
      "ZZ000001",
      provider,
    ),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    inspectBusinessSelection(
      request,
      discovery,
      "ZZ000001",
      provider,
      abort.signal,
    ),
  );
  assert.equal(calls, 0);
});
