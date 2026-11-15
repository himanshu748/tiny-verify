import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  compareRegistration,
  resolveObservation,
  syntheticReceipt,
  recordUrl,
  type RegistryObservation,
  type VerificationResult,
} from "./index.js";

/** Fictional names and shape-valid identifiers; no assertion that these identifiers are unissued. */
function example(
  registry: "uk_companies_house" | "au_abn_lookup",
  status: string,
  checkedAt: string,
): VerificationResult {
  const uk = registry === "uk_companies_house";
  const id = uk ? "ZZ000001" : "10000000000";
  const observation: RegistryObservation = {
    registry,
    source_url: recordUrl(registry, id),
    kind: "record",
    title: "SYNTHETIC FIXTURE — no live registry lookup",
    fields: uk
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
  return resolveObservation(
    { registry, by: "registration_id", registration_id: id },
    observation,
    syntheticReceipt(observation, checkedAt),
  );
}

export function offlineDemo() {
  const uk = example("uk_companies_house", "Active", "2026-11-08T08:00:00Z");
  const au = example(
    "au_abn_lookup",
    "Active from 01 Nov 1999",
    "2026-11-08T08:00:00Z",
  );
  const later = example(
    "au_abn_lookup",
    "Cancelled from 09 Nov 2026",
    "2026-11-09T08:00:00Z",
  );
  if (au.kind !== "verified")
    throw new Error("The synthetic example did not resolve.");
  return {
    mode: "synthetic_offline",
    provider_requests: 0,
    warning:
      "Fictional observations, including a dated synthetic cancellation. This is not provider or monitored registry evidence.",
    registries: [uk, au],
    synthetic_diff: compareRegistration(au.record, later),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(JSON.stringify(offlineDemo(), null, 2) + "\n");
