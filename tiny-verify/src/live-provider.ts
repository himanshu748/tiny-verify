import { createHash } from "node:crypto";
import type { PoolLedger, PrivateApiKey } from "../../shared/index.js";
import {
  fetchHtml,
  FetchSourceError,
  type FetchedHtml,
  type FetchPricingTier,
} from "../../providers/fetch.js";
import {
  Evidence,
  RegistryError,
  type Lookup,
  type RegistryObservation,
  type EvidenceReceipt,
} from "./contracts.js";
import type { RegistryProvider } from "./provider.js";
import { observationDigest } from "./parser.js";
import {
  canonicalSource,
  parseLookup,
  recordUrl,
  searchUrl,
} from "./registries.js";
import { parseRecordHtml, recordSelectors, type RecordLookup } from "./html.js";
import {
  parseSearchHtml,
  searchSelectors,
  type NameLookup,
} from "./search-html.js";

export type RegistryTransportReceipt = {
  reservation_id: string;
  source_url: string;
  final_url: string | null;
  observed_at: string;
  source_html_sha256: string | null;
  source_error_code: string | null;
};
export type LiveRegistryObservation = {
  observation: RegistryObservation;
  evidence: EvidenceReceipt;
  transport: RegistryTransportReceipt;
};
function failedObservation(
  lookup: Lookup,
  error: FetchSourceError,
): RegistryObservation {
  const base = {
    registry: lookup.registry,
    source_url:
      lookup.by === "registration_id"
        ? recordUrl(lookup.registry, lookup.registration_id)
        : searchUrl(lookup.registry, lookup.name),
  };
  if (error.sourceCode === "page_not_found" && error.sourceHttpStatus === 404)
    return { ...base, kind: "not_found", http_status: 404 };
  if (error.sourceCode === "bot_blocked")
    return { ...base, kind: "blocked", reason: "access_denied" };
  if (error.sourceCode === "login_required")
    return { ...base, kind: "blocked", reason: "authentication" };
  if (error.sourceHttpStatus === 403)
    return { ...base, kind: "blocked", reason: "access_denied" };
  if (error.sourceHttpStatus === 429)
    return { ...base, kind: "blocked", reason: "rate_limited" };
  return {
    ...base,
    kind: "provider_error",
    reason:
      error.sourceCode === "timeout"
        ? "timeout"
        : error.sourceCode === "target_unreachable"
          ? "unreachable"
          : "upstream_error",
  };
}

/** Explicit injected controls only; the default service still uses DisabledRegistryProvider. */
export class FetchRegistryProvider implements RegistryProvider {
  constructor(
    private readonly controls: { pool: PoolLedger; key: PrivateApiKey },
    private readonly options: {
      policyId?: string;
      request?: typeof fetch;
      pricingTier?: FetchPricingTier;
      onFetched?: (lookup: RecordLookup, fetched: FetchedHtml) => Promise<void>;
      onSearchFetched?: (
        lookup: NameLookup,
        fetched: FetchedHtml,
      ) => Promise<void>;
    } = {},
  ) {}
  async observe(
    input: Lookup,
    signal?: AbortSignal,
  ): Promise<LiveRegistryObservation> {
    const lookup = parseLookup(input);
    if (signal?.aborted)
      throw new RegistryError(
        "CANCELLED",
        "Cancelled before registry retrieval.",
      );
    const url =
      lookup.by === "registration_id"
        ? recordUrl(lookup.registry, lookup.registration_id)
        : searchUrl(lookup.registry, lookup.name);
    const assertAllowed = (candidate: string) => {
      if (
        candidate !== url ||
        canonicalSource(lookup.registry, candidate) !== url
      )
        throw new RegistryError(
          "SITE_CHANGED",
          "The fetched record left its exact official identity URL.",
        );
    };
    let observation: RegistryObservation, transport: RegistryTransportReceipt;
    try {
      const fetched = await fetchHtml({
        ...this.controls,
        bountyId: "tiny-verify",
        policyId: this.options.policyId ?? "fetch-public",
        url,
        selectors:
          lookup.by === "registration_id"
            ? recordSelectors(lookup.registry)
            : searchSelectors(lookup.registry),
        assertAllowed,
        ...(this.options.pricingTier
          ? { pricingTier: this.options.pricingTier }
          : {}),
        signal,
        request: this.options.request,
      });
      if (lookup.by === "registration_id") {
        await this.options.onFetched?.(lookup, fetched);
        observation = parseRecordHtml(lookup, fetched.html, fetched.final_url);
      } else {
        await this.options.onSearchFetched?.(lookup, fetched);
        observation = parseSearchHtml(lookup, fetched.html, fetched.final_url);
      }
      transport = {
        reservation_id: fetched.reservation_id,
        source_url: url,
        final_url: fetched.final_url,
        observed_at: fetched.observed_at,
        source_html_sha256: createHash("sha256")
          .update(fetched.html)
          .digest("hex"),
        source_error_code: null,
      };
    } catch (error) {
      if (!(error instanceof FetchSourceError)) throw error;
      observation = failedObservation(lookup, error);
      transport = {
        reservation_id: error.reservationId,
        source_url: url,
        final_url: null,
        observed_at: error.observedAt,
        source_html_sha256: null,
        source_error_code: error.sourceCode,
      };
    }
    if (signal?.aborted)
      throw new RegistryError(
        "CANCELLED",
        "Cancelled registry observations are not accepted.",
      );
    const evidence = Evidence.parse({
      kind: "provider",
      endpoint: "fetch",
      source_url: url,
      checked_at: transport.observed_at,
      observation_sha256: observationDigest(observation),
      provider_run_id: null,
    });
    return { observation, evidence, transport };
  }
}
