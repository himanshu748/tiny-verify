// Entirely synthetic source-shaped test data. IDs are not asserted to be unissued.
import {
  FLORIDA_HOME,
  FLORIDA_COMPLAINTS,
  floridaDigest,
  parseFloridaDetail,
  selectFloridaCandidate,
  resolveFloridaDetail,
} from "../src/florida.js";
import { NOW } from "./runtime-fixtures.js";
export const FL_URL = FLORIDA_HOME + "LicenseDetail?ID=" + "A".repeat(32);
export const flRequest = {
  name: "SYNTHETIC BROKERAGE LLC",
  jurisdiction: "US-FL",
  record_type: "real_estate_corporation",
} as const;
export const flCandidate = {
  licence_number: "CQ7654321",
  name: flRequest.name,
  name_kind: "primary",
  licence_type: "Real Estate Corporation",
  detail_url: FL_URL,
} as const;
export const notice =
  "Below is a listing of public complaints regarding the person or entity selected. This may not reflect all public complaints filed with the Department. The Department is also precluded from disclosing any complaints which are confidential pursuant to Florida Statutes.";
export function flHtml(
  options: {
    name?: string;
    expiry?: string | null;
    status?: string;
    id?: string;
    licence?: string;
  } = {},
) {
  const field = (id: string, label: string, value: string) =>
    `<div class="form-group"><label for="${id}">${label}</label><div>${value}</div></div>`;
  return (
    field(
      "FullName",
      "Name",
      (options.name ?? flRequest.name) + " (Primary Name)",
    ) +
    field("DBA", "DBA Name", "SYNTHETIC REALTY") +
    field("ProfessionName", "License Type", "Real Estate Corporation") +
    field("LicenseNumber", "License Number", options.licence ?? "CQ7654321") +
    field("LicStatus", "Status", options.status ?? "Current,Active") +
    (options.expiry === null
      ? ""
      : field("Expiry", "Expires", options.expiry ?? "03/31/2028")) +
    `<form method="post" action="/portalsearches/VerifyLicensee/ViewComplaint"><input type="hidden" name="ID" value="${options.id ?? "999001"}"></form>`
  );
}
export const flSearch = {
  kind: "florida_search",
  source_url: FLORIDA_HOME,
  query: flRequest.name,
  jurisdiction: "US-FL",
  licence_type: "Real Estate Corporation",
  complete: false,
  total_results: null,
  explicit_empty_text: null,
  candidates: [flCandidate],
  evidence_quote_sha256: floridaDigest(
    "Synthetic fixture corporate licence row",
  ),
} as const;
export const flSearchAgent = {
  state: "search",
  source_url: FLORIDA_HOME,
  observed_query: flRequest.name,
  complete: false,
  total_results: null,
  explicit_empty_text: null,
  candidates: [flCandidate],
  evidence_quote: "Synthetic fixture corporate licence row",
  stop_reason: null,
};
export const flLegacySearchAgent = {
  ...flSearchAgent,
  detail: null,
  response_name: null,
  coverage_notice: null,
  selected_complaint_html: null,
};
export function flReceipt(
  observation: { source_url: string },
  kind: "synthetic" | "provider" = "synthetic",
  endpoint: "fixture" | "fetch" | "agent" | "monitor" = "fixture",
  time = NOW,
  run: string | null = null,
) {
  return {
    kind,
    endpoint,
    source_url: observation.source_url,
    checked_at: new Date(time).toISOString(),
    observation_sha256: floridaDigest(observation),
    provider_run_id: run,
  };
}
export function flSelection(kind: "synthetic" | "provider" = "synthetic") {
  return selectFloridaCandidate(
    flRequest,
    flSearch,
    flReceipt(
      flSearch,
      kind,
      kind === "synthetic" ? "fixture" : "agent",
      NOW - 20000,
      kind === "provider" ? "00000000-0000-4000-8000-000000000101" : null,
    ),
    flCandidate.licence_number,
    FL_URL,
  );
}
export function flRecord(kind: "synthetic" | "provider" = "synthetic") {
  const d = parseFloridaDetail(flHtml(), FL_URL);
  return resolveFloridaDetail(
    flSelection(kind),
    d,
    flReceipt(d, kind, kind === "synthetic" ? "fixture" : "fetch", NOW - 10000),
  );
}
export function complaintHtml(
  options: { empty?: boolean; incident?: string; description?: string } = {},
) {
  const header =
    "<table><thead><tr><th>Number</th><th>Class</th><th>Incident Date</th><th>Status</th><th>Disposition</th><th>Disposition Date</th><th>Discipline Date<br>Description</th></tr></thead><tbody>";
  const row = (n: string, description: string) =>
    `<tr><td>${n}</td><td>RE Corp.</td><td>${options.incident ?? "01/01/1901"}</td><td>Closed</td><td>Final Order</td><td>08/13/1998</td><td>${description}</td></tr>`;
  return (
    `<h6>${flRequest.name}</h6><p>${notice}</p>` +
    header +
    (options.empty
      ? ""
      : row("9990001", options.description ?? "08/13/1998 - Fine") +
        row("9990002", "08/13/1998 - Sanctions") +
        row("9990003", "")) +
    "</tbody></table>"
  );
}
export function flComplaintAgent() {
  const record = flRecord();
  return {
    state: "complaints",
    source_url: FLORIDA_COMPLAINTS,
    observed_query: null,
    complete: false,
    total_results: null,
    explicit_empty_text: null,
    candidates: [],
    detail: {
      detail_url: FL_URL,
      licence_number: record.licence_number,
      legal_name: record.legal_name,
      licence_type: record.licence_type,
      native_status: record.native_status,
      expiry_literal: record.expiry_literal,
      observed_form_id: "999001",
    },
    response_name: record.legal_name,
    coverage_notice: notice,
    selected_complaint_html: complaintHtml(),
    evidence_quote: "Synthetic fixture: three historical public rows",
    stop_reason: null,
  };
}
