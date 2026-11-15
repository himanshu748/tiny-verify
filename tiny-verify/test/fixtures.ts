import {
  recordUrl,
  searchUrl,
  syntheticReceipt,
  resolveObservation,
  type RegistryObservation,
  type RegistryId,
  type Candidate,
  type EvidenceReceipt,
  type RegistrationRecord,
  type VerificationResult,
} from "../src/index.js";

// All fixture entities and observations are synthetic. Shape-valid IDs may collide with real IDs.
export const T0 = "2026-11-08T08:00:00Z";
export const T1 = "2026-11-09T08:00:00Z";
export const UK = "uk_companies_house" as const;
export const AU = "au_abn_lookup" as const;
export const UK_ID = "ZZ000001";
export const AU_ID = "10000000000";
export type RecordObservation = Extract<
  RegistryObservation,
  { kind: "record" }
>;
export type SearchObservation = Extract<
  RegistryObservation,
  { kind: "search" }
>;

export function record(
  registry: RegistryId = UK,
  status = registry === UK ? "Active" : "Active from 01 Nov 1999",
  id = registry === UK ? UK_ID : AU_ID,
): RecordObservation {
  return {
    kind: "record",
    registry,
    source_url: recordUrl(registry, id),
    title: "SYNTHETIC FIXTURE",
    fields:
      registry === UK
        ? [
            { label: "Company number", value: id },
            { label: "Company name", value: "Synthetic Lantern Labs Ltd" },
            { label: "Company status", value: status },
            { label: "Company type", value: "Private limited company" },
          ]
        : [
            { label: "ABN", value: id },
            { label: "Entity name", value: "SYNTHETIC LANTERN LABS PTY LTD" },
            { label: "ABN status", value: status },
            { label: "Entity type", value: "Australian Private Company" },
          ],
  };
}
export function candidate(
  id = UK_ID,
  name = "Synthetic Lantern Labs Ltd",
  registry: RegistryId = UK,
  matchKind: Candidate["match_kind"] = "entity_name",
) {
  return {
    registration_id: id,
    name,
    source_url: recordUrl(registry, id),
    match_kind: matchKind,
  };
}
export function search(
  candidates = [candidate()],
  registry: RegistryId = UK,
  name = "Synthetic Lantern Labs Ltd",
): SearchObservation {
  return {
    kind: "search",
    registry,
    source_url: searchUrl(registry, name),
    query: name,
    scope: "all_records",
    complete: true,
    total_results: candidates.length,
    empty_message_present: candidates.length === 0,
    candidates,
  };
}
export function resolveFixture(
  observation: RegistryObservation,
  at = T0,
  evidence?: EvidenceReceipt,
): VerificationResult {
  const lookup =
    observation.kind === "search"
      ? { registry: observation.registry, by: "name", name: observation.query }
      : {
          registry: observation.registry,
          by: "registration_id",
          registration_id: observation.registry === UK ? UK_ID : AU_ID,
        };
  return resolveObservation(
    lookup,
    observation,
    evidence ?? syntheticReceipt(observation, at),
  );
}
export function verified(
  observation: RecordObservation = record(),
  at = T0,
): RegistrationRecord {
  const result = resolveFixture(observation, at);
  if (result.kind !== "verified") throw new Error("Expected verified fixture.");
  return result.record;
}
