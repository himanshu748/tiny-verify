import type {
  EvidenceReceipt,
  Lookup,
  RegistryObservation,
  RegistrationRecord,
} from "./contracts.js";
import { RegistryError } from "./contracts.js";
import { parseLookup, recordUrl, searchUrl } from "./registries.js";

export interface RegistryProvider {
  observe(
    lookup: Lookup,
    signal?: AbortSignal,
  ): Promise<{ observation: RegistryObservation; evidence: EvidenceReceipt }>;
}

/** Typed request preparation only. No credentials are read and nothing is dispatched here. */
export function fetchIntent(input: unknown) {
  const lookup = parseLookup(input);
  const url =
    lookup.by === "registration_id"
      ? recordUrl(lookup.registry, lookup.registration_id)
      : searchUrl(lookup.registry, lookup.name);
  return {
    kind: "undispatched_fetch_intent" as const,
    endpoint: "https://api.fetch.tinyfish.ai",
    method: "POST" as const,
    body: {
      urls: [url],
      format: "html" as const,
      links: false,
      ttl: 0,
      per_url_timeout_ms: 45000,
    },
    requirements: [
      "An applicable finite owner allocation; halted or exhausted pools remain unavailable",
      "Fresh provider price quote",
      "Live DOM-to-observation adapter with final-URL and field corroboration",
    ],
  };
}

export class DisabledRegistryProvider implements RegistryProvider {
  async observe(
    _lookup: Lookup,
    signal?: AbortSignal,
  ): Promise<{ observation: RegistryObservation; evidence: EvidenceReceipt }> {
    if (signal?.aborted)
      throw new RegistryError(
        "CANCELLED",
        "The lookup was cancelled before provider work.",
      );
    throw new RegistryError(
      "LIVE_DISABLED",
      "TinyVerify live retrieval is disabled; no provider request or allowance reservation was made.",
    );
  }
}

export function statusMonitorIntent(record: RegistrationRecord) {
  return {
    kind: "undispatched_status_monitor_intent" as const,
    source_url: recordUrl(record.registry, record.registration_id),
    registry: record.registry,
    registration_id: record.registration_id,
    dispatch_allowed: false as const,
    reason:
      "Default recurring creation is disabled. The controlled runtime requires a separate exact private owner permit and paused verification lifecycle; annual cron and cleanup are not a provider lifetime cap.",
    observed_contract: {
      endpoint: "https://agent.tinyfish.ai/v1/monitors",
      create_captures_baseline: true,
      scheduled_runs_continue_until_paused_or_deleted: true,
    },
    documentation: "https://docs.tinyfish.ai/monitor/api-reference.md",
  };
}

export async function createStatusMonitor(
  _record: RegistrationRecord,
): Promise<never> {
  throw new RegistryError(
    "MONITOR_UNBOUNDED",
    "Unbounded default Monitor creation is disabled; use the finite controlled operator only with an existing separately approved private owner permit.",
  );
}
