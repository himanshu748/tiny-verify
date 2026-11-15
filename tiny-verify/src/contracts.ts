import { z } from "zod";

export const Registry = z.enum(["uk_companies_house", "au_abn_lookup"]);
export type RegistryId = z.infer<typeof Registry>;
const instant = z.string().datetime({ offset: true });
const plain = z.string().trim().min(1).max(500);

export const LookupInput = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("registration_id"),
      registry: Registry,
      registration_id: plain,
    })
    .strict(),
  z
    .object({
      by: z.literal("name"),
      registry: Registry,
      name: plain.min(3).max(120),
    })
    .strict(),
]);
export type Lookup = z.infer<typeof LookupInput>;

export const Evidence = z
  .object({
    kind: z.enum(["synthetic", "provider"]),
    endpoint: z.enum(["fixture", "fetch", "agent", "monitor"]),
    source_url: z.string().url().max(800),
    checked_at: instant,
    observation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    provider_run_id: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "synthetic") !== (value.endpoint === "fixture"))
      context.addIssue({
        code: "custom",
        message: "Synthetic observations must remain fixture evidence.",
      });
    if (value.kind === "synthetic" && value.provider_run_id !== null)
      context.addIssue({
        code: "custom",
        message: "Synthetic evidence cannot claim a provider run.",
      });
    if (
      ["agent", "monitor"].includes(value.endpoint) &&
      value.provider_run_id === null
    )
      context.addIssue({
        code: "custom",
        message: "Agent and Monitor evidence require an actual run identifier.",
      });
  });
export type EvidenceReceipt = z.infer<typeof Evidence>;

const base = { registry: Registry, source_url: z.string().url().max(800) };
const field = z
  .object({ label: plain.max(100), value: plain.max(1000) })
  .strict();
export const CandidateObservation = z
  .object({
    registration_id: plain.max(30),
    name: plain.max(300),
    source_url: z.string().url().max(800),
    match_kind: z.enum(["entity_name", "business_name", "historic_name"]),
  })
  .strict();
export const Observation = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("record"),
      title: plain.max(400),
      fields: z.array(field).max(20),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("search"),
      query: plain.max(120),
      scope: z.enum(["all_records", "active_only"]),
      complete: z.boolean(),
      total_results: z.number().int().nonnegative().max(100000),
      empty_message_present: z.boolean(),
      candidates: z.array(CandidateObservation).max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("not_found"),
      http_status: z.literal(404),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("blocked"),
      reason: z.enum([
        "authentication",
        "captcha",
        "access_denied",
        "rate_limited",
      ]),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("provider_error"),
      reason: z.enum(["timeout", "unreachable", "upstream_error"]),
    })
    .strict(),
]);
export type RegistryObservation = z.infer<typeof Observation>;

export const VerifiedRecord = z
  .object({
    registry: Registry,
    registration_id: plain.max(30),
    legal_name: plain.max(300),
    registration_basis: z.enum([
      "uk_company_register",
      "australian_abn_register",
    ]),
    native_status: plain,
    status: z.enum(["active", "inactive", "insolvency", "unknown"]),
    status_effective_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    entity_type: plain.nullable(),
    expiry_date: z.null().default(null),
    disciplinary_actions: z.null().default(null),
    field_coverage: z
      .object({
        expiry_date: z.literal("not_established_by_selected_record"),
        disciplinary_actions: z.literal(
          "not_checked_by_business_registration_adapter",
        ),
      })
      .strict()
      .default({
        expiry_date: "not_established_by_selected_record",
        disciplinary_actions: "not_checked_by_business_registration_adapter",
      }),
    source_url: z.string().url(),
    checked_at: instant,
    evidence: Evidence,
    warnings: z.array(z.string()).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.registry === "uk_companies_house"
        ? "uk_company_register"
        : "australian_abn_register";
    if (
      value.registration_basis !== expected ||
      value.source_url !== value.evidence.source_url ||
      value.checked_at !== value.evidence.checked_at
    )
      context.addIssue({
        code: "custom",
        message:
          "Record identity, registry basis and provenance must describe the same observation.",
      });
  });
export type RegistrationRecord = z.infer<typeof VerifiedRecord>;
export type Candidate = z.infer<typeof CandidateObservation> & {
  aliases: string[];
};

type ResultBase = {
  registry: RegistryId;
  source_url: string;
  evidence: EvidenceReceipt;
};
export type VerificationResult =
  | (ResultBase & { kind: "verified"; record: RegistrationRecord })
  | (ResultBase & {
      kind: "candidate";
      candidate: Candidate;
      requires_detail_check: true;
    })
  | (ResultBase & {
      kind: "ambiguous";
      candidates: Candidate[];
      reason: string;
    })
  | (ResultBase & {
      kind: "not_found";
      meaning: "No record established in this exact observed scope; not a negative licensing verdict.";
    })
  | (ResultBase & {
      kind: "incomplete";
      candidates: Candidate[];
      reason: string;
    })
  | (ResultBase & {
      kind: "blocked";
      reason: "authentication" | "captcha" | "access_denied" | "rate_limited";
    })
  | (ResultBase & {
      kind: "provider_error";
      reason: "timeout" | "unreachable" | "upstream_error";
    });

export class RegistryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "SITE_CHANGED"
      | "EVIDENCE_MISMATCH"
      | "LIVE_DISABLED"
      | "MONITOR_UNBOUNDED"
      | "MONITOR_INVALID"
      | "REMOTE_STATE_UNCERTAIN"
      | "AUTHORIZATION_REQUIRED"
      | "BUDGET_HALTED"
      | "BUDGET_EXHAUSTED"
      | "BUSY"
      | "STATE_FAILURE"
      | "PRICING_CHANGED"
      | "PROVIDER_FAILURE"
      | "PROVIDER_CONTRACT"
      | "PROVIDER_TIMEOUT"
      | "CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
