import { load } from "cheerio";
import {
  Observation,
  RegistryError,
  type Lookup,
  type RegistryObservation,
  type RegistryId,
} from "./contracts.js";
import {
  canonicalSource,
  parseLookup,
  recordUrl,
  registrationId,
} from "./registries.js";

const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
export const recordSelectors = (registry: RegistryId): readonly string[] =>
  registry === "uk_companies_house"
    ? ["h1", "#company-number", "#company-status", "#company-type-value"]
    : ["h1", "table"];
export type RecordLookup = Extract<Lookup, { by: "registration_id" }>;
export function parseRecordHtml(
  input: RecordLookup,
  html: string,
  finalUrl: string,
): RegistryObservation {
  const lookup = parseLookup(input) as RecordLookup,
    url = recordUrl(lookup.registry, lookup.registration_id);
  if (
    finalUrl !== url ||
    canonicalSource(lookup.registry, finalUrl) !== url ||
    Buffer.byteLength(html) > 500000
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The live record URL or content bound changed.",
    );
  const $ = load(html);
  const one = (selector: string) => {
    if ($(selector).length !== 1)
      throw new RegistryError(
        "SITE_CHANGED",
        "The expected registry identity block is missing or ambiguous.",
      );
    return clean($(selector).text());
  };
  const fields: Array<{ label: string; value: string }> = [];
  let title: string;
  if (lookup.registry === "uk_companies_house") {
    title = one("h1");
    const id = registrationId(lookup.registry, one("#company-number strong"));
    if (id !== lookup.registration_id)
      throw new RegistryError(
        "SITE_CHANGED",
        "The page company number differs from the exact requested identifier.",
      );
    fields.push(
      { label: "Company number", value: id },
      { label: "Company name", value: title },
      { label: "Company status", value: one("#company-status") },
      { label: "Company type", value: one("#company-type-value") },
    );
  } else {
    one("h1");
    const heading = $("h1").clone();
    heading.find(".version").remove();
    title = clean(heading.text());
    const match = /^Current details for ABN (\d{2} \d{3} \d{3} \d{3})$/u.exec(
      title,
    );
    if (
      !match ||
      registrationId(lookup.registry, match[1]!) !== lookup.registration_id
    )
      throw new RegistryError(
        "SITE_CHANGED",
        "The page ABN differs from the exact requested identifier.",
      );
    const tables = $("table").filter((_, table) =>
      /^ABN details(?: help)?$/u.test(
        clean($(table).find("caption").first().text()),
      ),
    );
    if (tables.length !== 1)
      throw new RegistryError(
        "SITE_CHANGED",
        "The current ABN details table is missing or ambiguous.",
      );
    fields.push({ label: "ABN", value: lookup.registration_id });
    const wanted = new Set(["Entity name", "ABN status", "Entity type"]);
    tables.find("tr").each((_, row) => {
      const label = clean($(row).find("th").text()).replace(/:$/u, "");
      if (wanted.has(label)) {
        if (
          fields.some((field) => field.label === label) ||
          $(row).find("td").length !== 1
        )
          throw new RegistryError(
            "SITE_CHANGED",
            "The current ABN fields are ambiguous.",
          );
        fields.push({ label, value: clean($(row).find("td").text()) });
      }
    });
    if (
      [...wanted].some(
        (label) => !fields.some((field) => field.label === label),
      )
    )
      throw new RegistryError(
        "SITE_CHANGED",
        "The current ABN registration fields are missing.",
      );
  }
  const observation = Observation.safeParse({
    kind: "record",
    registry: lookup.registry,
    source_url: url,
    title,
    fields,
  });
  if (!observation.success)
    throw new RegistryError(
      "SITE_CHANGED",
      "The extracted current registration fields are invalid.",
    );
  return observation.data;
}
