import { z } from "zod";
import { RegistryError, type Lookup } from "./contracts.js";
import type { RegistryProvider } from "./provider.js";
import { DisabledRegistryProvider, fetchIntent } from "./provider.js";
import { parseLookup, registrationId } from "./registries.js";
import { resolveObservation } from "./parser.js";

export const BusinessRequest = z.discriminatedUnion("jurisdiction", [
  z
    .object({
      name: z.string(),
      jurisdiction: z.literal("GB"),
      record_type: z.literal("company_registration"),
    })
    .strict(),
  z
    .object({
      name: z.string(),
      jurisdiction: z.literal("AU"),
      record_type: z.literal("abn_registration"),
    })
    .strict(),
]);
export type BusinessVerificationRequest = z.infer<typeof BusinessRequest>;
export function prepareBusinessRequest(input: unknown) {
  const parsed = BusinessRequest.safeParse(input);
  if (!parsed.success)
    throw new RegistryError(
      "INVALID_INPUT",
      "Choose GB/company_registration or AU/abn_registration and provide a business name.",
    );
  const registry =
    parsed.data.jurisdiction === "GB" ? "uk_companies_house" : "au_abn_lookup";
  const lookup = parseLookup({ by: "name", registry, name: parsed.data.name });
  return {
    request: {
      ...parsed.data,
      name: lookup.by === "name" ? lookup.name : parsed.data.name,
    },
    lookup,
    intent: fetchIntent(lookup),
    provider_requests: 0 as const,
  };
}
export async function discoverBusiness(
  input: unknown,
  provider: RegistryProvider = new DisabledRegistryProvider(),
  signal?: AbortSignal,
) {
  const plan = prepareBusinessRequest(input);
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "Discovery cancelled before retrieval.",
    );
  const observed = await provider.observe(plan.lookup, signal);
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "Cancelled observations are not accepted.",
    );
  return {
    ...plan,
    observation: observed.observation,
    evidence: observed.evidence,
    result: resolveObservation(
      plan.lookup,
      observed.observation,
      observed.evidence,
    ),
  };
}
/** Explicit selection binds an observed candidate to this name/type/place request, then checks its detail page separately. */
export async function inspectBusinessSelection(
  input: unknown,
  discovery: { observation: unknown; evidence: unknown },
  selectedId: string,
  provider: RegistryProvider = new DisabledRegistryProvider(),
  signal?: AbortSignal,
) {
  const plan = prepareBusinessRequest(input);
  const found = resolveObservation(
    plan.lookup,
    discovery.observation,
    discovery.evidence,
  );
  const candidates =
    found.kind === "candidate"
      ? [found.candidate]
      : found.kind === "ambiguous" || found.kind === "incomplete"
        ? found.candidates
        : [];
  const id = registrationId(plan.lookup.registry, selectedId);
  if (!candidates.some((candidate) => candidate.registration_id === id))
    throw new RegistryError(
      "INVALID_INPUT",
      "Select an identifier from this observed search; no different or missing entity is substituted.",
    );
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "Selection cancelled before retrieval.",
    );
  const lookup: Lookup = {
    by: "registration_id",
    registry: plan.lookup.registry,
    registration_id: id,
  };
  const observed = await provider.observe(lookup, signal);
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "Cancelled observations are not accepted.",
    );
  return {
    request: plan.request,
    selected_registration_id: id,
    search_coverage: found.kind,
    observation: observed.observation,
    evidence: observed.evidence,
    result: resolveObservation(lookup, observed.observation, observed.evidence),
  };
}
