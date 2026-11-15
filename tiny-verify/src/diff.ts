import {
  Evidence,
  RegistryError,
  VerifiedRecord,
  type RegistrationRecord,
  type VerificationResult,
} from "./contracts.js";
import { canonicalSource, recordUrl } from "./registries.js";

export type RegistrationDiff = {
  kind:
    | "unchanged"
    | "registration_status_changed"
    | "metadata_changed"
    | "status_unresolved"
    | "observation_gap";
  registration_id: string;
  before_checked_at: string;
  after_checked_at: string;
  changes: Array<{
    field: string;
    before: string | null;
    after: string | null;
  }>;
  baseline_retained: boolean;
  message: string;
};

/** A retrieval failure or missing record is never converted into dissolution/cancellation. */
export function compareRegistration(
  previous: RegistrationRecord,
  latest: VerificationResult,
): RegistrationDiff {
  const before = VerifiedRecord.parse(previous);
  const latestEvidence = Evidence.parse(latest.evidence);
  const identityUrl = recordUrl(before.registry, before.registration_id);
  if (
    latest.registry !== before.registry ||
    latestEvidence.kind !== before.evidence.kind
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Only the same registry and evidence mode can form one history.",
    );
  if (
    canonicalSource(before.registry, before.source_url) !== identityUrl ||
    canonicalSource(latest.registry, latest.source_url) !== identityUrl ||
    canonicalSource(latest.registry, latestEvidence.source_url) !== identityUrl
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Every history observation must concern the exact same official registration URL.",
    );
  if (Date.parse(latestEvidence.checked_at) <= Date.parse(before.checked_at))
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "A later observation is required; older or replayed timestamps cannot advance history.",
    );
  const base = {
    registration_id: before.registration_id,
    before_checked_at: before.checked_at,
    after_checked_at: latest.evidence.checked_at,
  };
  if (latest.kind !== "verified")
    return {
      ...base,
      kind: "observation_gap",
      changes: [],
      baseline_retained: true,
      message:
        "The later lookup did not verify a record. Keep the previous baseline and show the retrieval/identity gap; do not infer a status change.",
    };
  const after = VerifiedRecord.parse(latest.record);
  if (JSON.stringify(after.evidence) !== JSON.stringify(latestEvidence))
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "The compared record and result carry different evidence receipts.",
    );
  if (
    after.registration_id !== before.registration_id ||
    after.registry !== before.registry ||
    after.source_url !== before.source_url
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Different registration identities cannot be compared as one entity.",
    );
  if (after.status === "unknown" || before.status === "unknown")
    return {
      ...base,
      kind: "status_unresolved",
      changes: [],
      baseline_retained: true,
      message:
        "A status is not understood; retain the known baseline and request source review instead of emitting a registration-status alert.",
    };
  const fields = [
    "status",
    "status_effective_from",
    "legal_name",
    "entity_type",
  ] as const;
  const changes = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
  const statusChanged = changes.some((change) =>
    ["status", "status_effective_from"].includes(change.field),
  );
  return {
    ...base,
    kind:
      changes.length === 0
        ? "unchanged"
        : statusChanged
          ? "registration_status_changed"
          : "metadata_changed",
    changes,
    baseline_retained: false,
    message: statusChanged
      ? "The same official identifier has a different observed registration status; this is not a professional-licence or trading-eligibility decision."
      : "Compared semantic registration fields for the same official identifier; receipt time and unrelated page text do not count as changes.",
  };
}
