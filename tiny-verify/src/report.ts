import { VerifiedRecord, RegistryError } from "./contracts.js";
import { canonicalSource, recordUrl } from "./registries.js";
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
function csvCell(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
/** Render a supplied typed record; formatting does not establish fresh or independent provider provenance. */
export function exportRegistration(input: unknown) {
  const record = VerifiedRecord.parse(input);
  if (
    canonicalSource(record.registry, record.source_url) !==
    recordUrl(record.registry, record.registration_id)
  )
    throw new RegistryError(
      "EVIDENCE_MISMATCH",
      "The report record and official URL disagree.",
    );
  const fields = {
    legal_name: record.legal_name,
    registry: record.registry,
    registration_number: record.registration_id,
    status: record.status,
    native_status: record.native_status,
    status_effective_from: record.status_effective_from ?? "Unknown",
    expiry_date: "Unknown — not established by the selected record",
    disciplinary_actions:
      "Unknown — not checked by this business-registration adapter",
    entity_type: record.entity_type ?? "Unknown",
    source_url: record.source_url,
    checked_at: record.checked_at,
    evidence_kind: record.evidence.kind,
    evidence_endpoint: record.evidence.endpoint,
  };
  const csv =
    Object.keys(fields).map(csvCell).join(",") +
    "\r\n" +
    Object.values(fields).map(csvCell).join(",") +
    "\r\n";
  const warning =
    record.evidence.kind === "synthetic"
      ? "Synthetic fixture. No live source check is established."
      : "Saved observation. This export makes no fresh provider call and does not independently certify provenance.";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TinyVerify registration review</title><body><main><h1>${escape(record.legal_name)}</h1><p>${escape(warning)}</p><p>A scoped business-registration observation, not a professional licence, disciplinary clearance or trading-eligibility decision.</p><dl>${Object.entries(
    fields,
  )
    .map(
      ([key, value]) =>
        `<dt>${escape(key.replaceAll("_", " "))}</dt><dd>${key === "source_url" ? `<a href="${escape(value)}">Official registration record</a>` : escape(value)}</dd>`,
    )
    .join(
      "",
    )}</dl><h2>Limits</h2><ul>${record.warnings.map((value) => `<li>${escape(value)}</li>`).join("")}</ul></main></body></html>\n`;
  return { record, json: JSON.stringify(record, null, 2) + "\n", csv, html };
}
