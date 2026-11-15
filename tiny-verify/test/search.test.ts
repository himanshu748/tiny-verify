// Synthetic structural fixtures derived from the observed official search contracts; no live call.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSearchHtml, searchSelectors } from "../src/search-html.js";
import { searchUrl } from "../src/registries.js";
import { resolveObservation, syntheticReceipt } from "../src/parser.js";
const uk = {
  by: "name",
  registry: "uk_companies_house",
  name: "Synthetic Company",
} as const;
const au = {
  by: "name",
  registry: "au_abn_lookup",
  name: "Synthetic Company",
} as const;
export const ukSearch = (total = 1, name = "Synthetic Company") =>
  `<main id="page-container"><h1>Search results</h1><div id="search-meta">${total} matches found ${total > 1 ? '<a id="next-page">Next page</a>' : ""}</div><ul id="results"><li><h3><a href="/company/ZZ000001">${name}</a></h3></li></ul></main>`;
export const auSearch = (total = 1, type = "Entity Name") =>
  `<div id="content"><h1>Search results - all ABNs and names<span class="version">Version: fixture</span></h1><input id="Results_ActualResultsCount" value="1"><input id="Results_TotalResultsCount" value="${total}"><input id="Results_SearchStopped" value="False"><table><tr><th>ABN</th><th>Name</th><th>Type</th><th>Location</th></tr><tr><td><a href="/ABN/View?abn=10000000000">10 000 000 000</a><br>Active</td><td>Synthetic Company</td><td>${type}</td><td>Fixture location omitted from observation</td></tr></table></div>`;
const result = (lookup: typeof uk | typeof au, html: string) => {
  const observation = parseSearchHtml(
    lookup,
    html,
    searchUrl(lookup.registry, lookup.name),
  );
  return resolveObservation(
    lookup,
    observation,
    syntheticReceipt(observation, "2026-11-13T00:00:00Z"),
  );
};
test("company-only search and ABN all-record rows produce a candidate only after full observed coverage", () => {
  assert.equal(result(uk, ukSearch()).kind, "candidate");
  assert.equal(result(au, auSearch()).kind, "candidate");
  assert.equal(result(uk, ukSearch(25)).kind, "incomplete");
  assert.equal(result(au, auSearch(43)).kind, "incomplete");
  assert.match(searchUrl(uk.registry, uk.name), /\/search\/companies\?/);
  assert.deepEqual(searchSelectors(uk.registry), ["#page-container"]);
});
test("business aliases and historic entity names remain ambiguous instead of becoming a current legal name", () => {
  for (const type of [
    "Business Name",
    "Entity Name (Historic)",
    "Trading Name",
    "Other Name",
  ])
    assert.equal(result(au, auSearch(1, type)).kind, "ambiguous");
});
test("corroborated ordinary empty structures establish scoped no-match; a blank shell cannot", () => {
  const emptyUk =
    '<h1>Search results</h1><div id="no-results"><h2>No results found</h2> <p>There are no results that match your search. Try searching again using different search criteria.</p></div>';
  const emptyAu =
    '<div id="content"><h1>Search results - all ABNs and names</h1><input id="Results_ActualResultsCount" value="0"><input id="Results_TotalResultsCount" value="0"><input id="Results_SearchStopped" value="False"><p>Your search found no matching names.</p></div>';
  assert.equal(result(uk, emptyUk).kind, "not_found");
  assert.equal(result(au, emptyAu).kind, "not_found");
  for (const lookup of [uk, au])
    assert.throws(() => result(lookup, "<h1>Search results</h1>"));
});
test("wrong origins, changed links, duplicated headers and inconsistent counts fail closed", () => {
  assert.throws(() =>
    parseSearchHtml(
      uk,
      ukSearch(),
      searchUrl(uk.registry, uk.name) + "&page=2",
    ),
  );
  assert.throws(() =>
    result(
      uk,
      ukSearch().replace(
        "/company/ZZ000001",
        "https://evil.invalid/company/ZZ000001",
      ),
    ),
  );
  assert.throws(() => result(uk, ukSearch() + "<h1>Another</h1>"));
  assert.throws(() =>
    result(au, auSearch().replace("abn=10000000000", "abn=88000014675")),
  );
  assert.throws(() => result(au, auSearch().replace('value="1"', 'value="2"')));
  assert.throws(() => result(au, auSearch(1, "Unexpected Name Type")));
});
test("ABN stopped or partial search never establishes absence or a unique current selection", () => {
  assert.equal(
    result(au, auSearch().replace('value="False"', 'value="True"')).kind,
    "incomplete",
  );
});
