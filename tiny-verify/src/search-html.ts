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
  searchUrl,
} from "./registries.js";
export type NameLookup = Extract<Lookup, { by: "name" }>;
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
export function searchSelectors(registry: RegistryId): readonly string[] {
  return registry === "uk_companies_house" ? ["#page-container"] : ["#content"];
}
/** One observed page only. Truncated/filtered results stay incomplete; this never silently walks pagination. */
export function parseSearchHtml(
  input: NameLookup,
  html: string,
  finalUrl: string,
): RegistryObservation {
  const lookup = parseLookup(input) as NameLookup;
  const expected = searchUrl(lookup.registry, lookup.name);
  if (
    finalUrl !== expected ||
    canonicalSource(lookup.registry, finalUrl) !== expected ||
    Buffer.byteLength(html) > 500000
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The official search scope or byte bound changed.",
    );
  const $ = load(html);
  if ($("h1").length !== 1)
    throw new RegistryError(
      "SITE_CHANGED",
      "The search heading is missing or ambiguous.",
    );
  const candidates: Array<{
    registration_id: string;
    name: string;
    source_url: string;
    match_kind: "entity_name" | "business_name" | "historic_name";
  }> = [];
  let total: number,
    complete: boolean,
    empty = false;
  if (lookup.registry === "uk_companies_house") {
    if (clean($("h1").text()) !== "Search results")
      throw new RegistryError(
        "SITE_CHANGED",
        "Companies House search heading changed.",
      );
    if (
      $("#no-results").length === 1 &&
      $("#results").length === 0 &&
      /^(?:No results found )?There are no results that match your search\./.test(
        clean($("#no-results").text()),
      )
    ) {
      total = 0;
      complete = true;
      empty = true;
    } else {
      if ($("#search-meta").length !== 1 || $("#results").length !== 1)
        throw new RegistryError(
          "SITE_CHANGED",
          "Companies House search sections changed.",
        );
      const meta = clean($("#search-meta").text());
      const count = /([\d,]+) matches found\b/i.exec(meta);
      if (!count)
        throw new RegistryError(
          "SITE_CHANGED",
          "The official result count was not observed.",
        );
      total = Number(count[1]!.replaceAll(",", ""));
      $("#results h3 a").each((_, link) => {
        const href = $(link).attr("href") ?? "";
        const id = /^\/company\/([A-Z0-9]{8})$/.exec(href)?.[1];
        if (!id)
          throw new RegistryError(
            "SITE_CHANGED",
            "A company result left the reviewed record scope.",
          );
        const name = clean($(link).text());
        candidates.push({
          registration_id: registrationId(lookup.registry, id),
          name,
          source_url: recordUrl(lookup.registry, id),
          match_kind: "entity_name",
        });
      });
      complete = total === candidates.length && $("#next-page").length === 0;
      empty =
        total === 0 &&
        /no (?:results|matches)|0 matches found/i.test(
          meta + " " + $("#results").text(),
        );
    }
  } else {
    const heading = $("h1").clone();
    heading.find(".version").remove();
    if (clean(heading.text()) !== "Search results - all ABNs and names")
      throw new RegistryError(
        "SITE_CHANGED",
        "The ABN all-record search heading changed.",
      );
    const count = (id: string) => {
      if (
        $("#" + id).length !== 1 ||
        !/^\d+$/.test($("#" + id).attr("value") ?? "")
      )
        throw new RegistryError(
          "SITE_CHANGED",
          "ABN coverage counters were not observed.",
        );
      return Number($("#" + id).attr("value"));
    };
    const actual = count("Results_ActualResultsCount");
    total = count("Results_TotalResultsCount");
    const stopped = $("#Results_SearchStopped");
    if (
      stopped.length !== 1 ||
      !/^(True|False)$/.test(stopped.attr("value") ?? "")
    )
      throw new RegistryError(
        "SITE_CHANGED",
        "ABN search completion was not observed.",
      );
    const tables = $("table").filter(
      (_, table) =>
        $(table)
          .find("th")
          .slice(0, 4)
          .map((_, cell) => clean($(cell).text()))
          .get()
          .join("|") === "ABN|Name|Type|Location",
    );
    if (tables.length !== 1 && actual !== 0)
      throw new RegistryError(
        "SITE_CHANGED",
        "The ABN search table is missing or ambiguous.",
      );
    tables
      .find("tr")
      .filter((_, row) => $(row).find("td").length > 0)
      .each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length !== 4 || cells.eq(0).find("a").length !== 1)
          throw new RegistryError("SITE_CHANGED", "An ABN result row changed.");
        const link = cells.eq(0).find("a");
        const href = new URL(link.attr("href") ?? "", expected);
        const id =
          href.pathname === "/ABN/View" &&
          [...href.searchParams.keys()].join(",") === "abn" &&
          href.searchParams.getAll("abn").length === 1
            ? registrationId(lookup.registry, href.searchParams.get("abn")!)
            : null;
        if (
          !id ||
          href.origin !== new URL(expected).origin ||
          href.hash ||
          registrationId(lookup.registry, clean(link.text())) !== id
        )
          throw new RegistryError(
            "SITE_CHANGED",
            "The ABN link and visible identifier disagree.",
          );
        const type = clean(cells.eq(2).text());
        const match_kind = type.includes("(Historic)")
          ? "historic_name"
          : type === "Entity Name"
            ? "entity_name"
            : ["Business Name", "Trading Name", "Other Name"].includes(type)
              ? "business_name"
              : null;
        if (!match_kind)
          throw new RegistryError(
            "SITE_CHANGED",
            "An ABN name type is unrecognized.",
          );
        candidates.push({
          registration_id: id,
          name: clean(cells.eq(1).text()),
          source_url: recordUrl(lookup.registry, id),
          match_kind,
        });
      });
    if (actual !== candidates.length || total < actual)
      throw new RegistryError(
        "SITE_CHANGED",
        "ABN row and coverage counters disagree.",
      );
    complete = total === actual && stopped.attr("value") === "False";
    empty =
      actual === 0 &&
      /(?:no matching names|no matches|0 matches|did not match|no results)/i.test(
        $("#content").text(),
      );
  }
  const parsed = Observation.safeParse({
    kind: "search",
    registry: lookup.registry,
    source_url: expected,
    query: lookup.name,
    scope: "all_records",
    complete,
    total_results: total,
    empty_message_present: empty,
    candidates,
  });
  if (!parsed.success)
    throw new RegistryError(
      "SITE_CHANGED",
      "The bounded official search observation is invalid.",
    );
  return parsed.data;
}
