import { createHash } from "node:crypto";
import { load } from "cheerio";
import { z } from "zod";
import { Evidence, RegistryError, type EvidenceReceipt } from "./contracts.js";

export const FLORIDA_ORIGIN = "https://www.myfloridalicense.com";
export const FLORIDA_HOME = FLORIDA_ORIGIN + "/portalsearches/VerifyLicensee/";
export const FLORIDA_COMPLAINTS = FLORIDA_HOME + "ViewComplaint";
const text = z.string().trim().min(1).max(500);
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameName = (a: string, b: string) =>
  clean(a).normalize("NFKC").toUpperCase() ===
  clean(b).normalize("NFKC").toUpperCase();
function invalid(message: string): never {
  throw new RegistryError("SITE_CHANGED", message);
}
export function floridaDetailUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("The selected Florida detail URL is invalid.");
  }
  if (
    url.origin !== FLORIDA_ORIGIN ||
    url.pathname !== "/portalsearches/VerifyLicensee/LicenseDetail" ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].join(",") !== "ID" ||
    url.searchParams.getAll("ID").length !== 1 ||
    !/^[A-F0-9]{32}$/.test(url.searchParams.get("ID") ?? "")
  )
    invalid(
      "Use only the exact opaque detail URL actually observed in a Florida result row.",
    );
  return url.href;
}
export function floridaDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]),
    day = Number(match[2]),
    year = Number(match[3]);
  if (year < 1800 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${year}-${match[1]}-${match[2]}`
    : null;
}
export const FloridaRequest = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[\p{L}\p{N} .,&'’()\-+]+$/u),
    jurisdiction: z.literal("US-FL"),
    record_type: z.literal("real_estate_corporation"),
  })
  .strict();
export type FloridaRequestData = z.infer<typeof FloridaRequest>;
export const FloridaCandidate = z
  .object({
    licence_number: z.string().regex(/^CQ\d{1,8}$/),
    name: text.max(300),
    name_kind: z.enum(["primary", "dba", "other"]),
    licence_type: z.literal("Real Estate Corporation"),
    detail_url: z.string().refine((url) => {
      try {
        return floridaDetailUrl(url) === url;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export type FloridaCandidateData = z.infer<typeof FloridaCandidate>;
export const FloridaSearchObservation = z
  .object({
    kind: z.literal("florida_search"),
    source_url: z.literal(FLORIDA_HOME),
    query: text.max(120),
    jurisdiction: z.literal("US-FL"),
    licence_type: z.literal("Real Estate Corporation"),
    complete: z.boolean(),
    total_results: z.number().int().nonnegative().max(100000).nullable(),
    explicit_empty_text: z.string().max(1000).nullable(),
    candidates: z.array(FloridaCandidate).max(8),
    evidence_quote_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.complete &&
        (v.total_results === null ||
          v.total_results !== v.candidates.length)) ||
      (v.total_results !== null && v.total_results < v.candidates.length) ||
      (v.complete && v.total_results === 0 && !v.explicit_empty_text?.trim())
    )
      c.addIssue({
        code: "custom",
        message: "Florida search coverage contradicts its observed rows.",
      });
  });
export type FloridaSearchData = z.infer<typeof FloridaSearchObservation>;
export const FloridaSelection = z
  .object({
    request: FloridaRequest,
    candidate: FloridaCandidate,
    discovery_evidence: Evidence,
    discovery_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.discovery_evidence.source_url !== FLORIDA_HOME ||
      v.discovery_evidence.observation_sha256 !== v.discovery_sha256
    )
      c.addIssue({
        code: "custom",
        message: "Selection must preserve its discovery receipt/digest.",
      });
  });
export type FloridaSelectionData = z.infer<typeof FloridaSelection>;
export const FloridaDetailObservation = z
  .object({
    kind: z.literal("florida_detail"),
    source_url: z.string(),
    licence_number: z.string().regex(/^CQ\d{1,8}$/),
    legal_name: text.max(300),
    dba_name: text.max(300).nullable(),
    licence_type: z.literal("Real Estate Corporation"),
    native_status: text,
    expiry_literal: z.string().max(50).nullable(),
    expiry_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    complaint_form_id: z
      .string()
      .regex(/^\d{1,12}$/)
      .nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    try {
      floridaDetailUrl(v.source_url);
    } catch {
      c.addIssue({
        code: "custom",
        message: "Detail URL is outside reviewed Florida scope.",
      });
    }
    if (
      (v.expiry_literal === null) !== (v.expiry_date === null) ||
      (v.expiry_literal !== null &&
        floridaDate(v.expiry_literal) !== v.expiry_date)
    )
      c.addIssue({
        code: "custom",
        message:
          "Expiry must be an observed valid calendar date or explicitly unknown.",
      });
  });
export type FloridaDetailData = z.infer<typeof FloridaDetailObservation>;
export const FloridaComplaintRow = z
  .object({
    case_number: z.string().regex(/^\d{1,12}$/),
    case_class: text.max(150).nullable(),
    incident_date_literal: z.string().max(50).nullable(),
    incident_date: z.string().nullable(),
    incident_date_quality: z.enum([
      "observed",
      "placeholder_unknown",
      "not_reported",
    ]),
    status: text.max(100),
    disposition: text.max(150),
    disposition_date_literal: z.string().max(50).nullable(),
    disposition_date: z.string().nullable(),
    discipline_description: z.string().max(1000),
    action: z.enum(["fine", "sanctions", "unknown"]),
    action_date: z.string().nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    const incident = v.incident_date_literal;
    const expectedIncident =
      incident && incident !== "01/01/1901" ? floridaDate(incident) : null;
    const quality =
      incident === "01/01/1901"
        ? "placeholder_unknown"
        : incident
          ? "observed"
          : "not_reported";
    const disposed = v.disposition_date_literal
      ? floridaDate(v.disposition_date_literal)
      : null;
    const action = /^(\d{2}\/\d{2}\/\d{4}) - (.+)$/.exec(
      v.discipline_description,
    );
    const label = action?.[2]?.toLowerCase(),
      kind =
        label === "fine"
          ? "fine"
          : label === "sanctions"
            ? "sanctions"
            : "unknown",
      actionDate = action ? floridaDate(action[1]!) : null;
    if (
      (incident && incident !== "01/01/1901" && !expectedIncident) ||
      v.incident_date !== expectedIncident ||
      v.incident_date_quality !== quality ||
      (v.disposition_date_literal && !disposed) ||
      v.disposition_date !== disposed ||
      (v.discipline_description && !action) ||
      (action && !actionDate) ||
      v.action !== kind ||
      v.action_date !== actionDate
    )
      c.addIssue({
        code: "custom",
        message:
          "Case dates/actions must preserve the observed literals; placeholders and blank actions stay unknown.",
      });
  });
export const FloridaComplaintObservation = z
  .object({
    kind: z.literal("florida_complaints"),
    source_url: z.literal(FLORIDA_COMPLAINTS),
    detail_url: z.string(),
    licence_number: z.string().regex(/^CQ\d{1,8}$/),
    legal_name: text.max(300),
    observed_public_form_id: z.string().regex(/^\d{1,12}$/),
    response_name: text.max(300),
    coverage: z.literal("published_public_listing_non_exhaustive"),
    coverage_notice: text.max(3000),
    outcome: z.enum(["observed", "unknown", "blocked"]),
    rows: z.array(FloridaComplaintRow).max(20),
    raw_selected_text_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    transport_validation: z.literal(
      "agent_reported_selected_text_not_independent_browser_capture",
    ),
  })
  .strict()
  .superRefine((v, c) => {
    try {
      floridaDetailUrl(v.detail_url);
    } catch {
      c.addIssue({
        code: "custom",
        message: "History detail URL is outside scope.",
      });
    }
    if (
      !sameName(v.response_name, v.legal_name) ||
      !/may not reflect all public complaints/i.test(v.coverage_notice) ||
      !/precluded from disclosing.*confidential/i.test(v.coverage_notice) ||
      (v.outcome === "observed") !== v.rows.length > 0 ||
      new Set(v.rows.map((r) => r.case_number)).size !== v.rows.length
    )
      c.addIssue({
        code: "custom",
        message:
          "History identity, non-exhaustive coverage and case rows must agree.",
      });
  });
export type FloridaComplaintData = z.infer<typeof FloridaComplaintObservation>;
const instant = z.string().datetime({ offset: true });
export const FloridaLicence = z
  .object({
    registry: z.literal("florida_dbpr"),
    jurisdiction: z.literal("US-FL"),
    record_type: z.literal("real_estate_corporation"),
    licence_number: z.string().regex(/^CQ\d{1,8}$/),
    legal_name: text.max(300),
    dba_name: text.max(300).nullable(),
    licence_type: z.literal("Real Estate Corporation"),
    native_status: text,
    status: z.enum(["active", "inactive", "unknown"]),
    expiry_date: z.string().nullable(),
    expiry_literal: z.string().nullable(),
    source_url: z.string(),
    checked_at: instant,
    evidence: Evidence,
    detail_observation: FloridaDetailObservation,
    complaint_listing: FloridaComplaintObservation.nullable(),
    complaint_evidence: Evidence.nullable(),
    disciplinary_actions: z
      .array(
        z.object({
          case_number: z.string(),
          action: z.enum(["fine", "sanctions"]),
          action_date: z.string().nullable(),
          description: z.string(),
        }),
      )
      .nullable(),
    coverage: z
      .object({
        expiry: z.enum(["observed", "unknown"]),
        disciplinary_history: z.enum([
          "not_checked",
          "published_public_listing_non_exhaustive",
        ]),
      })
      .strict(),
    warnings: z.array(z.string()).min(1).max(10),
  })
  .strict()
  .superRefine((v, c) => {
    const d = v.detail_observation;
    if (
      v.evidence.kind === "provider" &&
      !["fetch", "monitor"].includes(v.evidence.endpoint)
    )
      c.addIssue({
        code: "custom",
        message:
          "Licence detail needs Fetch/Monitor evidence, separate from Agent search/history.",
      });
    const normalized = clean(d.native_status)
      .toLowerCase()
      .replace(/\s*,\s*/g, ",");
    const expectedStatus =
      normalized === "current,active" ? "active" : "unknown";
    const expectedActions =
      v.complaint_listing?.outcome === "observed"
        ? v.complaint_listing.rows
            .filter((r) => r.action !== "unknown")
            .map((r) => ({
              case_number: r.case_number,
              action: r.action,
              action_date: r.action_date,
              description: r.discipline_description,
            }))
        : null;
    if (
      v.status !== expectedStatus ||
      v.coverage.expiry !== (d.expiry_date ? "observed" : "unknown") ||
      v.coverage.disciplinary_history !==
        (v.complaint_listing
          ? "published_public_listing_non_exhaustive"
          : "not_checked") ||
      JSON.stringify(v.disciplinary_actions) !== JSON.stringify(expectedActions)
    )
      c.addIssue({
        code: "custom",
        message:
          "Derived status, field coverage and explicit actions must agree with source observations.",
      });
    if (
      d.source_url !== v.source_url ||
      d.licence_number !== v.licence_number ||
      d.legal_name !== v.legal_name ||
      d.dba_name !== v.dba_name ||
      d.native_status !== v.native_status ||
      d.expiry_date !== v.expiry_date ||
      d.expiry_literal !== v.expiry_literal ||
      v.evidence.source_url !== v.source_url ||
      v.evidence.checked_at !== v.checked_at ||
      v.evidence.observation_sha256 !== hash(d)
    )
      c.addIssue({
        code: "custom",
        message:
          "Licence fields/provenance must bind the same exact detail observation.",
      });
    if (
      (v.complaint_listing === null) !== (v.complaint_evidence === null) ||
      ((v.complaint_listing === null ||
        v.complaint_listing.outcome !== "observed") &&
        v.disciplinary_actions !== null)
    )
      c.addIssue({
        code: "custom",
        message: "Unchecked history stays unknown, never an empty clearance.",
      });
    if (v.complaint_listing && v.complaint_evidence) {
      const h = v.complaint_listing;
      if (
        h.detail_url !== v.source_url ||
        h.licence_number !== v.licence_number ||
        h.legal_name !== v.legal_name ||
        h.observed_public_form_id !== d.complaint_form_id ||
        !sameName(h.response_name, v.legal_name) ||
        v.complaint_evidence.source_url !== FLORIDA_COMPLAINTS ||
        v.complaint_evidence.observation_sha256 !== hash(h) ||
        v.complaint_evidence.kind !== v.evidence.kind ||
        (v.complaint_evidence.kind === "provider" &&
          v.complaint_evidence.endpoint !== "agent") ||
        Date.parse(v.complaint_evidence.checked_at) < Date.parse(v.checked_at)
      )
        c.addIssue({
          code: "custom",
          message:
            "Complaint history lacks the exact detail/form-ID/response-name provenance chain.",
        });
    }
  });
export type FloridaLicenceData = z.infer<typeof FloridaLicence>;
export const floridaDigest = hash;
export function floridaEvidence(
  observation: FloridaSearchData | FloridaDetailData | FloridaComplaintData,
  receipt: unknown,
): EvidenceReceipt {
  const evidence = Evidence.parse(receipt);
  if (
    evidence.source_url !== observation.source_url ||
    evidence.observation_sha256 !== hash(observation)
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Florida observation and source receipt disagree.",
    );
  return evidence;
}
export function selectFloridaCandidate(
  input: unknown,
  observed: unknown,
  receipt: unknown,
  licenceNumber: string,
  detailUrl: string,
): FloridaSelectionData {
  const request = FloridaRequest.parse(input),
    observation = FloridaSearchObservation.parse(observed),
    evidence = floridaEvidence(observation, receipt);
  if (observation.query !== request.name)
    invalid("Select only from the same observed Florida business query.");
  const matches = observation.candidates.filter(
    (c) => c.licence_number === licenceNumber && c.detail_url === detailUrl,
  );
  if (matches.length !== 1)
    invalid(
      "Explicitly select one observed licence and opaque detail URL; no ID is inferred or substituted.",
    );
  if (
    observation.candidates.some(
      (c) =>
        c.licence_number === licenceNumber &&
        (c.detail_url !== detailUrl || !sameName(c.name, matches[0]!.name)),
    )
  )
    invalid("Candidate licence identity is contradictory.");
  return FloridaSelection.parse({
    request,
    candidate: matches[0],
    discovery_evidence: evidence,
    discovery_sha256: hash(observation),
  });
}
export const FLORIDA_DETAIL_SELECTORS = [
  [
    "div.form-group:has(> label[for='FullName'])",
    "div.form-group:has(> label[for='DBA'])",
    "div.form-group:has(> label[for='ProfessionName'])",
    "div.form-group:has(> label[for='LicenseNumber'])",
    "div.form-group:has(> label[for='LicStatus'])",
    "div.form-group:has(> label[for='Expiry'])",
    "form[action='/portalsearches/VerifyLicensee/ViewComplaint']",
  ].join(", "),
] as const;
export function parseFloridaDetail(
  html: string,
  finalUrl: string,
): FloridaDetailData {
  const url = floridaDetailUrl(finalUrl);
  if (Buffer.byteLength(html) > 500000 || !html.trim())
    invalid("Florida detail is empty or oversized.");
  const $ = load(html);
  const field = (id: string, required = true): string | null => {
    const labels = $(`label[for='${id}']`);
    if (labels.length === 0 && !required) return null;
    if (labels.length !== 1)
      return invalid(
        "A required Florida licence field is missing or ambiguous.",
      );
    const row = labels.parent(),
      value = row.children("div");
    if (value.length !== 1) return invalid("Florida field structure changed.");
    const v = clean(value.text());
    return v || null;
  };
  const primary = field("FullName");
  if (!primary?.endsWith(" (Primary Name)"))
    invalid("The Florida detail must identify its primary corporate name.");
  const legal_name = primary.slice(0, -" (Primary Name)".length),
    licence_type = field("ProfessionName"),
    licence_number = field("LicenseNumber"),
    native_status = field("LicStatus");
  if (
    licence_type !== "Real Estate Corporation" ||
    !licence_number ||
    !/^CQ\d{1,8}$/.test(licence_number) ||
    !native_status
  )
    invalid(
      "Florida licence type, number or status is outside the reviewed corporate scope.",
    );
  const rawExpiry = field("Expiry", false);
  if (rawExpiry && !floridaDate(rawExpiry))
    invalid("Florida reported an invalid or unreviewed expiry date.");
  const forms = $("form").filter(
    (_, e) =>
      $(e).attr("action") === "/portalsearches/VerifyLicensee/ViewComplaint",
  );
  if (forms.length > 1)
    invalid("The selected detail has ambiguous public complaint forms.");
  let complaint_form_id: string | null = null;
  if (forms.length) {
    if ((forms.attr("method") ?? "").toLowerCase() !== "post")
      invalid("The complaint form method changed.");
    const input = forms.find("input[name='ID']");
    if (input.length !== 1 || !/^\d{1,12}$/.test(input.attr("value") ?? ""))
      invalid("The selected detail complaint ID is missing or malformed.");
    complaint_form_id = input.attr("value")!;
  }
  return FloridaDetailObservation.parse({
    kind: "florida_detail",
    source_url: url,
    licence_number,
    legal_name,
    dba_name: field("DBA", false),
    licence_type,
    native_status,
    expiry_literal: rawExpiry,
    expiry_date: rawExpiry ? floridaDate(rawExpiry) : null,
    complaint_form_id,
  });
}
export function resolveFloridaDetail(
  selectionInput: unknown,
  observationInput: unknown,
  receipt: unknown,
): FloridaLicenceData {
  const selection = FloridaSelection.parse(selectionInput),
    d = FloridaDetailObservation.parse(observationInput),
    evidence = floridaEvidence(d, receipt),
    candidate = selection.candidate;
  if (evidence.kind !== selection.discovery_evidence.kind)
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Synthetic discovery and provider detail cannot form one Florida review.",
    );
  if (
    d.source_url !== candidate.detail_url ||
    d.licence_number !== candidate.licence_number ||
    !sameName(
      candidate.name,
      candidate.name_kind === "dba" ? (d.dba_name ?? "") : d.legal_name,
    ) ||
    candidate.name_kind === "other"
  )
    invalid(
      "The independently read Florida detail differs from the explicitly selected candidate.",
    );
  return makeFloridaLicence(d, evidence);
}
function makeFloridaLicence(
  d: FloridaDetailData,
  evidence: EvidenceReceipt,
): FloridaLicenceData {
  const normalized = clean(d.native_status)
    .toLowerCase()
    .replace(/\s*,\s*/g, ",");
  const status = normalized === "current,active" ? "active" : "unknown";
  return FloridaLicence.parse({
    registry: "florida_dbpr",
    jurisdiction: "US-FL",
    record_type: "real_estate_corporation",
    licence_number: d.licence_number,
    legal_name: d.legal_name,
    dba_name: d.dba_name,
    licence_type: d.licence_type,
    native_status: d.native_status,
    status,
    expiry_date: d.expiry_date,
    expiry_literal: d.expiry_literal,
    source_url: d.source_url,
    checked_at: evidence.checked_at,
    evidence,
    detail_observation: d,
    complaint_listing: null,
    complaint_evidence: null,
    disciplinary_actions: null,
    coverage: {
      expiry: d.expiry_date ? "observed" : "unknown",
      disciplinary_history: "not_checked",
    },
    warnings: [
      "A Florida Real Estate Corporation licence is distinct from UK/Australian business registration and is not a legal eligibility or good-standing decision.",
      "Public disciplinary history has not been checked; unknown never means no actions.",
      ...(status === "unknown"
        ? [
            "The native licence status is unrecognized; retain it without inferring active or inactive.",
          ]
        : []),
    ],
  });
}
export function resolveFloridaMonitoredDetail(
  previous: unknown,
  raw: unknown,
  receipt: unknown,
) {
  const before = FloridaLicence.parse(previous),
    observation = FloridaDetailObservation.parse(raw),
    evidence = floridaEvidence(observation, receipt);
  if (
    observation.source_url !== before.source_url ||
    observation.licence_number !== before.licence_number
  )
    invalid("Monitor returned another Florida licence identity.");
  return {
    kind: "verified" as const,
    record: makeFloridaLicence(observation, evidence),
    evidence,
  };
}
export function parseFloridaComplaints(
  detailInput: unknown,
  reportedFormId: string,
  responseName: string,
  coverageNotice: string,
  selectedHtml: string,
): FloridaComplaintData {
  const detail = FloridaDetailObservation.parse(detailInput);
  if (
    !detail.complaint_form_id ||
    reportedFormId !== detail.complaint_form_id ||
    !sameName(responseName, detail.legal_name)
  )
    invalid(
      "Complaint output does not bind the selected detail's public form ID and corporate response name.",
    );
  if (Buffer.byteLength(selectedHtml) > 150000 || !selectedHtml.trim())
    invalid("Selected complaint text is empty or oversized.");
  if (
    !/may not reflect all public complaints/i.test(coverageNotice) ||
    !/precluded from disclosing.*confidential/i.test(coverageNotice)
  )
    invalid(
      "The public listing's non-exhaustive/confidential coverage warning is required.",
    );
  const $ = load(selectedHtml);
  $("br").replaceWith(" ");
  const visible = clean($.root().text());
  if (
    !visible.includes(clean(responseName)) ||
    !visible.includes(clean(coverageNotice))
  )
    invalid(
      "Complaint response name and coverage warning must occur in the same selected public text.",
    );
  if ($("input,script,form,iframe,img").length)
    invalid(
      "Only public selected complaint table text may be retained; session fields and unrelated content are rejected.",
    );
  const headers = [
    "Number",
    "Class",
    "Incident Date",
    "Status",
    "Disposition",
    "Disposition Date",
    "Discipline Date Description",
  ];
  const tables = $("table").filter(
    (_, e) =>
      $(e)
        .find("th")
        .map((_, h) => clean($(h).text()))
        .get()
        .join("|") === headers.join("|"),
  );
  if (tables.length !== 1)
    invalid("The reviewed public complaint table headers changed.");
  const rows: Array<z.infer<typeof FloridaComplaintRow>> = [];
  tables.find("tr").each((_, r) => {
    const cells = $(r).children("td");
    if (!cells.length) return;
    if (cells.length !== 7)
      invalid("A complaint row no longer matches the reviewed table.");
    const values = cells.map((_, c) => clean($(c).text())).get();
    const [
      case_number,
      case_class,
      incident,
      status,
      disposition,
      disposed,
      description,
    ] = values as [string, string, string, string, string, string, string];
    const parsedIncident =
      incident && incident !== "01/01/1901" ? floridaDate(incident) : null;
    const parsedDisposed = disposed ? floridaDate(disposed) : null;
    if (
      (incident && incident !== "01/01/1901" && !parsedIncident) ||
      (disposed && !parsedDisposed)
    )
      invalid("A public complaint date is invalid; no date is guessed.");
    const actionMatch = /^(\d{2}\/\d{2}\/\d{4}) - (.+)$/.exec(description);
    if (description && !actionMatch)
      invalid(
        "A discipline description changed from the reviewed date/action structure.",
      );
    const actionDate = actionMatch ? floridaDate(actionMatch[1]!) : null;
    if (actionMatch && !actionDate)
      invalid("The public discipline action date is invalid.");
    const label = actionMatch?.[2]?.toLowerCase();
    rows.push(
      FloridaComplaintRow.parse({
        case_number,
        case_class: case_class || null,
        incident_date_literal: incident || null,
        incident_date: parsedIncident,
        incident_date_quality:
          incident === "01/01/1901"
            ? "placeholder_unknown"
            : incident
              ? "observed"
              : "not_reported",
        status,
        disposition,
        disposition_date_literal: disposed || null,
        disposition_date: parsedDisposed,
        discipline_description: description,
        action:
          label === "fine"
            ? "fine"
            : label === "sanctions"
              ? "sanctions"
              : "unknown",
        action_date: actionDate,
      }),
    );
  });
  if (new Set(rows.map((r) => r.case_number)).size !== rows.length)
    invalid("Public complaint case numbers are duplicated or contradictory.");
  return FloridaComplaintObservation.parse({
    kind: "florida_complaints",
    source_url: FLORIDA_COMPLAINTS,
    detail_url: detail.source_url,
    licence_number: detail.licence_number,
    legal_name: detail.legal_name,
    observed_public_form_id: reportedFormId,
    response_name: responseName,
    coverage: "published_public_listing_non_exhaustive",
    coverage_notice: clean(coverageNotice),
    outcome: rows.length ? "observed" : "unknown",
    rows,
    raw_selected_text_sha256: createHash("sha256")
      .update(selectedHtml)
      .digest("hex"),
    transport_validation:
      "agent_reported_selected_text_not_independent_browser_capture",
  });
}
export function attachFloridaComplaints(
  recordInput: unknown,
  observationInput: unknown,
  receipt: unknown,
): FloridaLicenceData {
  const record = FloridaLicence.parse(recordInput),
    h = FloridaComplaintObservation.parse(observationInput),
    evidence = floridaEvidence(h, receipt);
  return FloridaLicence.parse({
    ...record,
    complaint_listing: h,
    complaint_evidence: evidence,
    disciplinary_actions:
      h.outcome === "observed"
        ? h.rows
            .filter((r) => r.action !== "unknown")
            .map((r) => ({
              case_number: r.case_number,
              action: r.action,
              action_date: r.action_date,
              description: r.discipline_description,
            }))
        : null,
    coverage: {
      ...record.coverage,
      disciplinary_history: "published_public_listing_non_exhaustive",
    },
    warnings: [
      record.warnings[0]!,
      "This published public complaint listing may omit public cases and cannot disclose confidential complaints; it is not exhaustive and never establishes clean discipline.",
      "Closed complaints and Final Order outcomes do not by themselves establish discipline. Only explicit action descriptions are identified; empty descriptions remain unknown.",
      "Historical Fine/Sanctions entries do not override the current native licence status.",
      "Complaint text is Agent-reported selected text, not an independently captured browser response. Its identity, dates and coverage are validated locally; independent source review remains required.",
    ],
  });
}
export function compareFloridaLicence(
  beforeInput: unknown,
  afterInput: unknown,
) {
  const before = FloridaLicence.parse(beforeInput),
    after = FloridaLicence.parse(afterInput);
  if (
    before.source_url !== after.source_url ||
    before.licence_number !== after.licence_number ||
    before.evidence.kind !== after.evidence.kind ||
    Date.parse(after.checked_at) <= Date.parse(before.checked_at)
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "Only later observations of the same exact Florida licence and evidence mode form one history.",
    );
  const fields = [
    "status",
    "expiry_date",
    "legal_name",
    "licence_type",
  ] as const;
  const changes = fields
    .filter((k) => before[k] !== after[k])
    .map((field) => ({ field, before: before[field], after: after[field] }));
  return {
    kind:
      before.status === "unknown" || after.status === "unknown"
        ? "status_unresolved"
        : changes.length
          ? "licence_fields_changed"
          : "unchanged",
    licence_number: before.licence_number,
    changes,
    complaint_history_rechecked: false,
    meaning:
      "GET detail monitoring covers licence status/expiry, not the separate POST complaint listing or legal clearance.",
  };
}
export function exportFloridaLicence(input: unknown) {
  const record = FloridaLicence.parse(input);
  const escape = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const fields = {
    legal_name: record.legal_name,
    licence_number: record.licence_number,
    licence_type: record.licence_type,
    native_status: record.native_status,
    status: record.status,
    expiry_date: record.expiry_date ?? "Unknown",
    disciplinary_history: record.complaint_listing?.outcome ?? "Not checked",
    history_coverage:
      record.complaint_listing?.coverage ?? "Unknown; not checked",
    explicit_actions:
      record.disciplinary_actions?.map((a) => a.description).join("; ") ||
      "Unknown; no clearance inferred",
    source_url: record.source_url,
    checked_at: record.checked_at,
  };
  const cell = (s: string) =>
    '"' +
    (/^[\s]*[=+\-@\t\r\n]/u.test(s) ? "'" + s : s).replaceAll('"', '""') +
    '"';
  return {
    record,
    json: JSON.stringify(record, null, 2) + "\n",
    csv:
      Object.keys(fields).map(cell).join(",") +
      "\r\n" +
      Object.values(fields).map(cell).join(",") +
      "\r\n",
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>TinyVerify Florida licence review</title><body><main><h1>${escape(record.legal_name)}</h1><p>Saved ${record.evidence.kind === "synthetic" ? "synthetic fixture" : "source observation"}. No fresh or independently certified check is established by this export.</p><dl>${Object.entries(
      fields,
    )
      .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`)
      .join(
        "",
      )}</dl><ul>${record.warnings.map((w) => `<li>${escape(w)}</li>`).join("")}</ul></main></body></html>\n`,
  };
}
