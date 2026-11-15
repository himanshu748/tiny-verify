// All permit/key files and HTTP responses here are synthetic test-only material.
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadRuntimeControls,
  digest,
  RuntimeLedger,
  type RuntimePermitData,
} from "../src/runtime-controls.js";
import { recordUrl, searchUrl } from "../src/registries.js";
import { record, UK, UK_ID } from "./fixtures.js";
import { observationDigest, resolveObservation } from "../src/parser.js";
export const NOW = Date.parse("2026-11-13T08:30:00Z"),
  KEY = "synthetic-tinyverify-runtime-test-material";
export const lookup = {
  by: "name",
  registry: UK,
  name: "Synthetic Company",
} as const;
export const detail = {
  by: "registration_id",
  registry: UK,
  registration_id: UK_ID,
} as const;
export const html =
  '<h1>Synthetic Company</h1><p id="company-number">Company number <strong>ZZ000001</strong></p><dd id="company-status">Active</dd><span id="company-type-value">Private limited company</span>';
export const searchHtml =
  '<main id="page-container"><h1>Search results</h1><div id="search-meta">1 matches found</div><ul id="results"><li><h3><a href="/company/ZZ000001">Synthetic Company</a></h3></li></ul></main>';
export const agentResult = {
  state: "search",
  source_url: searchUrl(UK, lookup.name),
  observed_query: lookup.name,
  complete: true,
  total_results: 1,
  empty_message_present: false,
  candidates: [
    {
      registration_id: UK_ID,
      name: "Synthetic Company",
      source_url: recordUrl(UK, UK_ID),
      match_kind: "entity_name",
    },
  ],
  evidence_quote: "Synthetic fixture: one matching public company row.",
  stop_reason: null,
};
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
export const wallet = (
  options: { agent?: string; monitor?: string; fetch?: string } = {},
) =>
  json({
    available_balance: "10",
    currency: "USD",
    rates: {
      meters: [
        {
          label: "TinyFish Agent",
          per: "step",
          unit_amount: options.agent ?? "0.016",
          currency: "USD",
        },
        {
          label: "TinyFish Fetch (Builder)",
          per: "url",
          unit_amount: options.fetch ?? "0.001",
          currency: "USD",
        },
        {
          label: "TinyFish Monitor",
          per: "run",
          unit_amount: options.monitor ?? "0.005",
          currency: "USD",
        },
      ],
    },
  });
export async function runtimeFixture(
  options: {
    limits?: RuntimePermitData["limits"];
    clock?: () => number;
    initialize?: boolean;
    monitorTarget?: string;
  } = {},
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "tinyverify-runtime-offline-")),
  );
  await mkdir(join(base, "private"), { mode: 0o700 });
  const directory = join(base, "private"),
    permitFile = join(directory, "permit.json"),
    keyFile = join(directory, "key.env"),
    clock = options.clock ?? (() => NOW);
  const limits = options.limits ?? { fetch: 8, agent: 1, monitor_check: 2 };
  const permit: RuntimePermitData = {
    version: 1,
    project: "tiny-verify",
    permit_id: randomUUID(),
    permit_file: permitFile,
    state_directory: join(directory, "state"),
    authorization_basis: "separate_owner_supplement_not_shared_pool",
    previous_pools_remain_halted: true,
    authorized_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 3600000).toISOString(),
    key_sha256: digest(KEY),
    fetch_tier: "builder",
    max_reserved_microusd: 1000000,
    limits,
    agent_beta_enrollment_confirmed: limits.agent > 0,
    monitor_control_model:
      "annual_outside_window_immediate_pause_client_cleanup_not_provider_cap",
    monitor_target_url: limits.monitor_check
      ? (options.monitorTarget ?? recordUrl(UK, UK_ID))
      : null,
    monitor_window: limits.monitor_check
      ? {
          operation_id: randomUUID(),
          authorized_at: new Date(NOW - 500).toISOString(),
          expires_at: new Date(NOW + 20 * 60000).toISOString(),
        }
      : null,
    allow_owned_cleanup_after_expiry: true,
  };
  await writeFile(permitFile, JSON.stringify(permit), { mode: 0o600 });
  await writeFile(keyFile, "TINYFISH_API_KEY=" + KEY + "\n", { mode: 0o600 });
  const env = {
    TINYVERIFY_LIVE: "1",
    TINYVERIFY_PERMIT_FILE: permitFile,
    TINYFISH_KEY_FILE: keyFile,
    BOUNTY_POOL_LIVE: "1",
    BOUNTY_POOL_GRANT_FILE: join(base, "old-halted-pool-not-opened.json"),
  };
  const controls = await loadRuntimeControls(env, clock);
  if (!controls) throw Error("Synthetic fixture disabled");
  if (options.initialize !== false) await controls.ledger.initialize();
  return {
    base,
    directory,
    permitFile,
    keyFile,
    permit,
    env,
    clock,
    ...controls,
    reload: () => new RuntimeLedger(permit, clock),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
export function providerRecord() {
  const observation = record();
  const result = resolveObservation(detail, observation, {
    kind: "provider",
    endpoint: "fetch",
    source_url: observation.source_url,
    checked_at: new Date(NOW - 10000).toISOString(),
    observation_sha256: observationDigest(observation),
    provider_run_id: null,
  });
  if (result.kind !== "verified") throw Error("Fixture");
  return result.record;
}
