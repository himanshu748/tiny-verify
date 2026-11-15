import { createHash } from "node:crypto";
import {
  Evidence,
  Observation,
  RegistryError,
  VerifiedRecord,
  type Candidate,
  type EvidenceReceipt,
  type RegistrationRecord,
  type RegistryObservation,
  type VerificationResult,
} from "./contracts.js";
import {
  canonicalSource,
  normalizedName,
  parseLookup,
  recordUrl,
  registrationId,
  REGISTRIES,
} from "./registries.js";

const notFoundMeaning =
  "No record established in this exact observed scope; not a negative licensing verdict." as const;
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
function date(value: string): string | null {
  const match = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
  if (!match) return null;
  const monthName = match[2]!.toLowerCase();
  const month = months.findIndex(
    (value) => monthName === value || monthName === value.slice(0, 3),
  );
  const day = Number(match[1]),
    year = Number(match[3]);
  if (month < 0 || year < 1800 || year > 2200) return null;
  const observed = new Date(Date.UTC(year, month, day));
  if (
    observed.getUTCFullYear() !== year ||
    observed.getUTCMonth() !== month ||
    observed.getUTCDate() !== day
  )
    return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function literal(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
function fields(
  input: Array<{ label: string; value: string }>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of input) {
    const label = literal(field.label).replace(/:$/, "").toLowerCase();
    const value = literal(field.value);
    if (result.has(label) && result.get(label) !== value)
      throw new RegistryError(
        "SITE_CHANGED",
        "The source observation contains contradictory field values.",
      );
    result.set(label, value);
  }
  return result;
}
function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value)
    throw new RegistryError(
      "SITE_CHANGED",
      "The source no longer contains required registration fields.",
    );
  return value;
}

export function observationDigest(observation: RegistryObservation): string {
  return createHash("sha256")
    .update(JSON.stringify(Observation.parse(observation)))
    .digest("hex");
}

/** Only for explicitly labelled offline examples and tests. This does not create provider evidence. */
export function syntheticReceipt(
  observation: RegistryObservation,
  checkedAt: string,
): EvidenceReceipt {
  return Evidence.parse({
    kind: "synthetic",
    endpoint: "fixture",
    source_url: observation.source_url,
    checked_at: checkedAt,
    observation_sha256: observationDigest(observation),
    provider_run_id: null,
  });
}

function parseRecord(
  observation: Extract<RegistryObservation, { kind: "record" }>,
  evidence: EvidenceReceipt,
): RegistrationRecord {
  const values = fields(observation.fields);
  const uk = observation.registry === "uk_companies_house";
  let id: string;
  try {
    id = registrationId(
      observation.registry,
      required(values, uk ? "company number" : "abn"),
    );
  } catch {
    throw new RegistryError(
      "SITE_CHANGED",
      "The source identifier is missing or malformed.",
    );
  }
  const legalName = required(values, uk ? "company name" : "entity name");
  const nativeStatus = required(values, uk ? "company status" : "abn status");
  if (
    recordUrl(observation.registry, id) !==
    canonicalSource(observation.registry, observation.source_url)
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The observed registration identifier disagrees with its official record URL.",
    );
  let status: RegistrationRecord["status"] = "unknown";
  let effectiveFrom: string | null = null;
  if (uk) {
    const label = nativeStatus.toLowerCase();
    if (label === "active") status = "active";
    else if (["dissolved", "converted/closed", "removed"].includes(label))
      status = "inactive";
    else if (
      [
        "liquidation",
        "administration",
        "receivership",
        "voluntary arrangement",
      ].includes(label)
    )
      status = "insolvency";
  } else {
    const match =
      /^(Active|Cancelled)(?: from (\d{1,2} [A-Za-z]+ \d{4}))?$/i.exec(
        nativeStatus,
      );
    if (match) {
      effectiveFrom = match[2] ? date(match[2]) : null;
      if (!match[2] || effectiveFrom)
        status = match[1]!.toLowerCase() === "active" ? "active" : "inactive";
    }
  }
  const warnings = [
    uk
      ? "Company registration is not identity assurance, trading permission or a professional licence; filed information is not certified by this tool."
      : "An active ABN concerns ABN registration, not professional or financial-services licensing or a promise that a business is trading.",
  ];
  if (status === "unknown")
    warnings.push(
      "The source status is unrecognized or has an invalid effective date; no registration conclusion is inferred.",
    );
  return VerifiedRecord.parse({
    registry: observation.registry,
    registration_id: id,
    legal_name: legalName,
    registration_basis: REGISTRIES[observation.registry].basis,
    native_status: nativeStatus,
    status,
    status_effective_from: effectiveFrom,
    entity_type: values.get(uk ? "company type" : "entity type") ?? null,
    source_url: recordUrl(observation.registry, id),
    checked_at: evidence.checked_at,
    evidence,
    warnings,
  });
}

export function resolveObservation(
  input: unknown,
  raw: unknown,
  receipt: unknown,
): VerificationResult {
  const lookup = parseLookup(input);
  const parsed = Observation.safeParse(raw),
    provenance = Evidence.safeParse(receipt);
  if (!parsed.success)
    throw new RegistryError(
      "SITE_CHANGED",
      "The structured registry observation contract is incomplete or changed.",
    );
  if (!provenance.success)
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "The observation has no valid evidence receipt.",
    );
  const observation = parsed.data,
    evidence = provenance.data;
  const source = canonicalSource(observation.registry, observation.source_url);
  if (
    observation.registry !== lookup.registry ||
    canonicalSource(observation.registry, evidence.source_url) !== source ||
    observationDigest(observation) !== evidence.observation_sha256
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "The source, registry or observation digest disagrees with its receipt.",
    );
  const context = {
    registry: observation.registry,
    source_url: source,
    evidence,
  };
  const url = new URL(source);
  if (
    lookup.by === "registration_id" &&
    source !== recordUrl(lookup.registry, lookup.registration_id)
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The observed source is not the exact requested registration record.",
    );
  if (lookup.by === "name") {
    const parameter =
      lookup.registry === "uk_companies_house" ? "q" : "SearchText";
    if (url.searchParams.get(parameter) !== lookup.name)
      throw new RegistryError(
        "SITE_CHANGED",
        "The observed search URL does not match the requested business name.",
      );
  }
  if (observation.kind === "blocked")
    return { ...context, kind: "blocked", reason: observation.reason };
  if (observation.kind === "provider_error")
    return { ...context, kind: "provider_error", reason: observation.reason };
  if (observation.kind === "not_found")
    return { ...context, kind: "not_found", meaning: notFoundMeaning };
  if (observation.kind === "record") {
    if (lookup.by !== "registration_id")
      throw new RegistryError(
        "SITE_CHANGED",
        "Name discovery requires candidate selection before record verification.",
      );
    const record = parseRecord(observation, evidence);
    if (record.registration_id !== lookup.registration_id)
      throw new RegistryError(
        "SITE_CHANGED",
        "The source returned a different registration record.",
      );
    return { ...context, kind: "verified", record };
  }
  if (lookup.by !== "name" || observation.query !== lookup.name)
    throw new RegistryError(
      "SITE_CHANGED",
      "The observed result page does not match the requested search.",
    );
  if (
    observation.registry === "au_abn_lookup" &&
    (url.pathname === "/Search/ResultsActive") !==
      (observation.scope === "active_only")
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The declared search coverage disagrees with the official result-page path.",
    );
  const candidates = new Map<string, Candidate>();
  for (const row of observation.candidates) {
    const id = registrationId(observation.registry, row.registration_id);
    const candidateUrl = recordUrl(observation.registry, id);
    if (canonicalSource(observation.registry, row.source_url) !== candidateUrl)
      throw new RegistryError(
        "SITE_CHANGED",
        "A search candidate points to a different registration identifier.",
      );
    const existing = candidates.get(id);
    if (existing) {
      if (
        existing.match_kind === "entity_name" &&
        row.match_kind === "entity_name" &&
        normalizedName(existing.name) !== normalizedName(row.name)
      )
        throw new RegistryError(
          "SITE_CHANGED",
          "One registration identifier has contradictory current entity names.",
        );
      if (!existing.aliases.includes(row.name)) existing.aliases.push(row.name);
      if (
        existing.match_kind !== "entity_name" &&
        row.match_kind === "entity_name"
      ) {
        existing.name = row.name;
        existing.match_kind = row.match_kind;
      }
    } else
      candidates.set(id, {
        ...row,
        registration_id: id,
        source_url: candidateUrl,
        aliases: [row.name],
      });
  }
  const rows = [...candidates.values()];
  if (
    observation.total_results < observation.candidates.length ||
    (observation.complete &&
      observation.total_results !== observation.candidates.length)
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The source result count and supplied candidate coverage disagree.",
    );
  if (!observation.complete || observation.scope !== "all_records")
    return {
      ...context,
      kind: "incomplete",
      candidates: rows,
      reason:
        "The observed page is filtered or truncated; absence is not established.",
    };
  if (rows.length === 0) {
    if (!observation.empty_message_present || observation.total_results !== 0)
      throw new RegistryError(
        "SITE_CHANGED",
        "An empty page lacks a corroborating source empty-result contract.",
      );
    return { ...context, kind: "not_found", meaning: notFoundMeaning };
  }
  const exact = rows.filter(
    (row) =>
      row.match_kind === "entity_name" &&
      normalizedName(row.name) === normalizedName(lookup.name),
  );
  if (exact.length === 1)
    return {
      ...context,
      kind: "candidate",
      candidate: exact[0]!,
      requires_detail_check: true,
    };
  return {
    ...context,
    kind: "ambiguous",
    candidates: rows,
    reason:
      exact.length > 1
        ? "Several distinct registration IDs share this name; select the correct official identifier."
        : "No unique exact current entity-name match is established; select an official identifier.",
  };
}
