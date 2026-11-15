import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PoolLedger,
  PrivateApiKey,
  type AuthorizationGrant,
} from "../../shared/index.js";
import { parseRecordHtml, recordSelectors } from "../src/html.js";
import { FetchRegistryProvider } from "../src/live-provider.js";
import { resolveObservation } from "../src/parser.js";
import { recordUrl } from "../src/registries.js";
import type { Lookup } from "../src/contracts.js";

const uk = {
  by: "registration_id",
  registry: "uk_companies_house",
  registration_id: "ZZ000001",
} as const;
const au = {
  by: "registration_id",
  registry: "au_abn_lookup",
  registration_id: "10000000000",
} as const;
const ukHtml =
  '<h1>Synthetic Company</h1><p id="company-number">Company number <strong>ZZ000001</strong></p><dd id="company-status">Active</dd><span id="company-type-value">Fixture type</span>';
const auHtml =
  '<h1>Current details for ABN 10 000 000 000<span class="version">Version fixture</span></h1><table><caption>ABN details help</caption><tr><th>Entity name:</th><td>Fixture Entity</td></tr><tr><th>ABN status:</th><td>Active from 01&nbsp;Nov&nbsp;1999</td></tr><tr><th>Entity type:</th><td>Fixture type</td></tr></table><table><caption>Business name(s) help</caption><tr><th>Entity name:</th><td>Wrong alias</td></tr></table>';
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tinyverify-live-offline-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const material = "synthetic-live-adapter-test-key-only",
    now = Date.now();
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-registry",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    currency: "USD",
    max_reserved_microusd: 10000000,
    max_concurrent_operations: 1,
    state_directory: join(root, "pool"),
    key_sha256: createHash("sha256").update(material).digest("hex"),
    allowed_bounties: ["tiny-verify"],
    policies: [
      {
        id: "fetch-public",
        unit: "url",
        max_units_per_operation: 1,
        max_unit_price_microusd: 0,
        max_operations: 6,
        max_active_operations: 1,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/fetch-api/reference",
          description: "One explicit URL in an offline registry test request.",
        },
      },
    ],
  };
  const pool = new PoolLedger(grant);
  await pool.initialize();
  return { pool, key: new PrivateApiKey(material) };
}
const wallet = () =>
  new Response(
    JSON.stringify({
      available_balance: "10",
      currency: "USD",
      rates: {
        meters: [
          {
            label: "TinyFish Fetch",
            per: "url",
            unit_amount: "0",
            currency: "USD",
          },
        ],
      },
    }),
  );
test("source-specific HTML binds UK heading/number/status and current ABN table without aliases", () => {
  const a = parseRecordHtml(
    uk,
    ukHtml,
    recordUrl(uk.registry, uk.registration_id),
  );
  const b = parseRecordHtml(
    au,
    auHtml,
    recordUrl(au.registry, au.registration_id),
  );
  assert.equal(a.kind, "record");
  assert.equal(b.kind, "record");
  if (a.kind === "record" && b.kind === "record") {
    assert.equal(
      a.fields.find((f) => f.label === "Company name")!.value,
      "Synthetic Company",
    );
    assert.equal(
      b.fields.find((f) => f.label === "Entity name")!.value,
      "Fixture Entity",
    );
    assert.equal(
      b.fields.find((f) => f.label === "ABN status")!.value,
      "Active from 01 Nov 1999",
    );
  }
  assert.equal(recordSelectors(uk.registry).length, 4);
  assert.equal(recordSelectors(au.registry).length, 2);
});
test("cross-identity, missing, duplicated and redirected HTML cannot become a registry record", () => {
  for (const html of [
    ukHtml.replace("ZZ000001", "ZZ000002"),
    ukHtml.replace('id="company-status"', 'id="missing"'),
    ukHtml + "<h1>Different heading</h1>",
  ])
    assert.throws(() =>
      parseRecordHtml(uk, html, recordUrl(uk.registry, uk.registration_id)),
    );
  assert.throws(() =>
    parseRecordHtml(
      au,
      auHtml.replace("10 000 000 000", "88 000 014 675"),
      recordUrl(au.registry, au.registration_id),
    ),
  );
  assert.throws(() =>
    parseRecordHtml(
      au,
      auHtml,
      recordUrl(au.registry, au.registration_id) + "?x=1",
    ),
  );
});
test("live adapter creates typed provider evidence with actual reservation and raw selected-HTML hash", async (t) => {
  const controls = await fixture(t);
  let jobs = 0,
    saved = 0;
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/wallet")) return wallet();
    jobs++;
    const body = JSON.parse(String(init?.body)) as { urls: string[] };
    return new Response(
      JSON.stringify({
        results: [
          {
            url: body.urls[0],
            final_url: body.urls[0],
            text: ukHtml,
            format: "html",
          },
        ],
        errors: [],
      }),
    );
  };
  const provider = new FetchRegistryProvider(controls, {
      request,
      onFetched: async () => {
        saved++;
      },
    }),
    output = await provider.observe(uk),
    result = resolveObservation(uk, output.observation, output.evidence);
  assert.equal(jobs, 1);
  assert.equal(saved, 1);
  assert.equal(result.kind, "verified");
  assert.equal(output.evidence.kind, "provider");
  assert.equal(output.evidence.endpoint, "fetch");
  assert.equal(output.evidence.provider_run_id, null);
  assert.match(output.transport.reservation_id, /^[a-f0-9-]{36}$/u);
  assert.equal(
    output.transport.source_html_sha256,
    createHash("sha256").update(ukHtml).digest("hex"),
  );
  assert.equal(output.evidence.checked_at, output.transport.observed_at);
  assert.equal((await controls.pool.status()).operations_used, 1);
});
test("known denial and scoped404 stay typed gaps with no invented final URL or registration status", async (t) => {
  const controls = await fixture(t);
  for (const [error, status, kind] of [
    ["bot_blocked", 403, "blocked"],
    ["page_not_found", 404, "not_found"],
  ] as const) {
    const request: typeof fetch = async (input) =>
      String(input).endsWith("/wallet")
        ? wallet()
        : new Response(
            JSON.stringify({
              results: [],
              errors: [
                {
                  url: recordUrl(uk.registry, uk.registration_id),
                  error,
                  status,
                },
              ],
            }),
          );
    const output = await new FetchRegistryProvider(controls, {
      request,
    }).observe(uk);
    assert.equal(output.observation.kind, kind);
    assert.equal(output.transport.final_url, null);
    assert.equal(output.transport.source_html_sha256, null);
    assert.equal(
      resolveObservation(uk, output.observation, output.evidence).kind,
      kind,
    );
  }
  assert.equal((await controls.pool.status()).halted, false);
});
test("cancelled name discovery or exact-ID work cannot dispatch a live request", async (t) => {
  const controls = await fixture(t);
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return wallet();
  };
  const provider = new FetchRegistryProvider(controls, { request });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.observe(
      {
        by: "name",
        registry: uk.registry,
        name: "Synthetic Company",
      },
      controller.signal,
    ),
  );
  await assert.rejects(provider.observe(uk, controller.signal));
  assert.equal(calls, 0);
});
test("live name adapter forwards a company-only query and returns bounded candidates without automatic detail work", async (t) => {
  const controls = await fixture(t);
  let jobs = 0,
    saved = 0;
  const input = {
    by: "name",
    registry: "uk_companies_house",
    name: "Synthetic Company",
  } as const;
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/wallet")) return wallet();
    jobs++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.urls[0], /\/search\/companies\?q=Synthetic\+Company$/);
    return new Response(
      JSON.stringify({
        results: [
          {
            url: body.urls[0],
            final_url: body.urls[0],
            format: "html",
            text: '<main id="page-container"><h1>Search results</h1><div id="search-meta">30 matches found <a id="next-page">Next page</a></div><ul id="results"><li><h3><a href="/company/ZZ000001">Synthetic Company</a></h3></li></ul></main>',
          },
        ],
        errors: [],
      }),
    );
  };
  const output = await new FetchRegistryProvider(controls, {
    request,
    onSearchFetched: async () => {
      saved++;
    },
  }).observe(input);
  assert.equal(
    resolveObservation(input, output.observation, output.evidence).kind,
    "incomplete",
  );
  assert.equal(jobs, 1);
  assert.equal(saved, 1);
  assert.equal(output.evidence.kind, "provider");
  assert.equal((await controls.pool.status()).operations_used, 1);
});
test("live adapter never turns changed or unknown source status text into an active claim", async (t) => {
  const controls = await fixture(t);
  const request: typeof fetch = async (input) =>
    String(input).endsWith("/wallet")
      ? wallet()
      : new Response(
          JSON.stringify({
            results: [
              {
                url: recordUrl(uk.registry, uk.registration_id),
                final_url: recordUrl(uk.registry, uk.registration_id),
                text: ukHtml.replace(">Active<", ">Unrecognized native label<"),
                format: "html",
              },
            ],
            errors: [],
          }),
        );
  const output = await new FetchRegistryProvider(controls, { request }).observe(
      uk as Lookup,
    ),
    result = resolveObservation(uk, output.observation, output.evidence);
  assert.equal(result.kind, "verified");
  if (result.kind === "verified") assert.equal(result.record.status, "unknown");
});
