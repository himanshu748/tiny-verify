// Synthetic parser/identity/date/coverage regressions, never live-provider proof.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FloridaRequest,
  FloridaLicence,
  FloridaSearchObservation,
  FloridaComplaintObservation,
  floridaDetailUrl,
  floridaDate,
  parseFloridaDetail,
  resolveFloridaDetail,
  selectFloridaCandidate,
  parseFloridaComplaints,
  attachFloridaComplaints,
  compareFloridaLicence,
  exportFloridaLicence,
  FLORIDA_COMPLAINTS,
} from "../src/florida.js";
import {
  FLORIDA_AGENT_SCHEMA,
  FLORIDA_DISCOVERY_SCHEMA,
  floridaDiscoveryGoal,
  prepareFloridaSearch,
  prepareFloridaComplaints,
} from "../src/florida-agent.js";
import { assertAgentOutputSchema } from "../src/runtime-transport.js";
import {
  FL_URL,
  flRequest,
  flCandidate,
  flHtml,
  flSearch,
  flReceipt,
  flSelection,
  flRecord,
  notice,
  complaintHtml,
  flSearchAgent,
  flLegacySearchAgent,
  flComplaintAgent,
} from "./florida-fixtures.js";
import { NOW } from "./runtime-fixtures.js";
test("Florida scope is corporate real-estate licensing, not a renamed UK/AU registration", () => {
  assert.equal(FloridaRequest.parse(flRequest).jurisdiction, "US-FL");
  for (const patch of [
    { jurisdiction: "GB" },
    { record_type: "company_registration" },
    { record_type: "real_estate_individual" },
    { name: "https://private.invalid" },
  ])
    assert.throws(() => FloridaRequest.parse({ ...flRequest, ...patch }));
  assertAgentOutputSchema(FLORIDA_AGENT_SCHEMA);
  assert.equal(FLORIDA_AGENT_SCHEMA.properties.detail.nullable, true);
});
test("opaque Florida detail IDs are observed URLs, never generated from CQ numbers", () => {
  assert.equal(floridaDetailUrl(FL_URL), FL_URL);
  for (const url of [
    FL_URL.replace("A".repeat(32), "CQ7654321"),
    FL_URL + "&x=1",
    FL_URL + "#token",
    FL_URL.replace("www.myfloridalicense.com", "private.invalid"),
    FL_URL.replace("ID=", "ID=x&ID="),
  ])
    assert.throws(() => floridaDetailUrl(url));
});
test("discovery requests only first-page fields in the supported wire subset and leaves complaint schema intact", () => {
  assertAgentOutputSchema(FLORIDA_DISCOVERY_SCHEMA);
  assert.deepEqual(FLORIDA_DISCOVERY_SCHEMA.properties.state.enum, [
    "search",
    "blocked",
  ]);
  assert.deepEqual(
    [...FLORIDA_DISCOVERY_SCHEMA.required].sort(),
    Object.keys(FLORIDA_DISCOVERY_SCHEMA.properties).sort(),
  );
  for (const field of [
    "detail",
    "response_name",
    "coverage_notice",
    "selected_complaint_html",
  ])
    assert.equal(field in FLORIDA_DISCOVERY_SCHEMA.properties, false);
  assert.deepEqual(FLORIDA_AGENT_SCHEMA.properties.state.enum, [
    "search",
    "complaints",
    "blocked",
  ]);
  assert.equal(FLORIDA_AGENT_SCHEMA.properties.detail.nullable, true);
  const goal = floridaDiscoveryGoal(flRequest);
  const inOrder = [
    "NameSubmit",
    "License Category",
    "WAIT",
    "AFTER those filters settle",
    "POST to",
    "EACH row",
    "FINISH IMMEDIATELY",
  ];
  let previous = -1;
  for (const step of inOrder) {
    const index = goal.indexOf(step, previous + 1);
    assert.ok(index > previous, step);
    previous = index;
  }
  assert.match(goal, /SKIP a source row with a blank or non-CQ licence cell/);
  assert.match(
    goal,
    /If any source row is skipped or coverage is unknown, set complete false/,
  );
  assert.match(goal, /maximum, never a quota/);
  assert.match(goal, /SAME row's visible company-name submit button/);
  assert.match(
    goal,
    /scope the click to the row with that actually observed CQ number and native type/,
  );
  assert.match(goal, /Do not inspect hidden inputs/);
  assert.match(goal, /ACTUAL CURRENT URL/);
  assert.match(goal, /returns at most ONE clicked candidate/);
  assert.match(
    goal,
    /Never open ViewComplaint, inspect detail fields, go back/,
  );
  assert.doesNotMatch(goal, /CQ247822|B1B7828012AA269780F1999CA2AC6DF5/);
  assert.match(
    goal,
    /canonical evidence metadata for the search origin, not an instruction to navigate back/,
  );
});
test("compact discovery and historical full-null discovery preserve the same public observation without accepting history contamination", () => {
  assert.deepEqual(
    prepareFloridaSearch(flRequest, flSearchAgent),
    prepareFloridaSearch(flRequest, flLegacySearchAgent),
  );
  for (const patch of [
    { detail: { observed_form_id: "" } },
    { response_name: "Another phase" },
    { coverage_notice: "Unrequested history" },
    { selected_complaint_html: "<table></table>" },
    { state: "complaints" },
    { unrelated: null },
  ])
    for (const base of [flSearchAgent, flLegacySearchAgent])
      assert.throws(() =>
        prepareFloridaSearch(flRequest, { ...base, ...patch }),
      );
});
test("discovery retains a raw total with skipped source rows but rejects every malformed returned row as a batch", () => {
  const valid = { ...flSearchAgent, total_results: 2, complete: false };
  const observed = prepareFloridaSearch(flRequest, valid).observation;
  assert.equal(observed.candidates.length, 1);
  assert.equal(observed.total_results, 2);
  assert.equal(observed.complete, false);
  assert.throws(() =>
    prepareFloridaSearch(flRequest, { ...valid, complete: true }),
  );
  for (const bad of [
    { licence_number: "" },
    { licence_number: "CQ" },
    { detail_url: FL_URL.replace("A".repeat(32), "") },
    { detail_url: FL_URL.replace("A".repeat(32), "CQ7654321") },
  ])
    assert.throws(() =>
      prepareFloridaSearch(flRequest, {
        ...valid,
        candidates: [flCandidate, { ...flCandidate, ...bad }],
      }),
    );
});
test("explicit name-selection then independent detail establishes status and observed expiry", () => {
  const d = parseFloridaDetail(flHtml(), FL_URL),
    record = resolveFloridaDetail(flSelection(), d, flReceipt(d));
  assert.equal(record.licence_number, "CQ7654321");
  assert.equal(record.expiry_date, "2028-03-31");
  assert.equal(record.expiry_literal, "03/31/2028");
  assert.equal(record.status, "active");
  assert.equal(record.complaint_listing, null);
  assert.equal(record.disciplinary_actions, null);
  assert.equal(record.coverage.disciplinary_history, "not_checked");
});
test("expiry dates are calendar checked and absent expiry stays unknown", () => {
  assert.equal(floridaDate("02/29/2028"), "2028-02-29");
  for (const d of ["02/29/2027", "13/01/2028", "03/32/2028", "2028-03-31"])
    assert.equal(floridaDate(d), null);
  assert.throws(() =>
    parseFloridaDetail(flHtml({ expiry: "02/29/2027" }), FL_URL),
  );
  const d = parseFloridaDetail(flHtml({ expiry: null }), FL_URL);
  assert.equal(d.expiry_date, null);
  assert.equal(
    resolveFloridaDetail(flSelection(), d, flReceipt(d)).coverage.expiry,
    "unknown",
  );
});
test("detail identity rejects another licence/name/type, duplicate labels and changed complaint IDs", () => {
  for (const html of [
    flHtml({ licence: "CQ111" }),
    flHtml({ name: "ANOTHER CORPORATION" }),
    flHtml().replace("Real Estate Corporation", "Real Estate Broker"),
  ])
    assert.throws(() => {
      const d = parseFloridaDetail(html, FL_URL);
      return resolveFloridaDetail(flSelection(), d, flReceipt(d));
    });
  assert.throws(() => parseFloridaDetail(flHtml() + flHtml(), FL_URL));
  assert.throws(() =>
    selectFloridaCandidate(
      flRequest,
      flSearch,
      flReceipt(flSearch),
      "CQ111",
      FL_URL,
    ),
  );
  assert.throws(() =>
    selectFloridaCandidate(
      { ...flRequest, name: "ANOTHER" },
      flSearch,
      flReceipt(flSearch),
      flCandidate.licence_number,
      FL_URL,
    ),
  );
});
test("partial and ambiguous discovery cannot become automatic unique identity or absence", () => {
  const prepared = prepareFloridaSearch(flRequest, flSearchAgent);
  assert.equal(prepared.observation.complete, false);
  assert.equal(prepared.observation.total_results, null);
  assert.equal(prepared.observation.candidates.length, 1);
  assert.throws(() =>
    FloridaSearchObservation.parse({ ...flSearch, complete: true }),
  );
  const two = {
    ...flSearch,
    candidates: [
      flCandidate,
      {
        ...flCandidate,
        licence_number: "CQ111",
        detail_url: FL_URL.replace("A".repeat(32), "B".repeat(32)),
      },
    ],
  };
  assert.equal(FloridaSearchObservation.parse(two).candidates.length, 2);
  assert.throws(() =>
    prepareFloridaSearch(flRequest, {
      ...flSearchAgent,
      observed_query: "ANOTHER",
    }),
  );
});
test("receipt/digest mutation and source-selected URL substitution fail closed", () => {
  const d = parseFloridaDetail(flHtml(), FL_URL);
  assert.throws(() =>
    resolveFloridaDetail(
      flSelection(),
      { ...d, expiry_date: "2029-03-31" },
      flReceipt(d),
    ),
  );
  assert.throws(() =>
    resolveFloridaDetail(flSelection(), d, {
      ...flReceipt(d),
      source_url: FLORIDA_COMPLAINTS,
    }),
  );
  assert.throws(() =>
    resolveFloridaDetail(
      { ...flSelection(), discovery_sha256: "f".repeat(64) },
      d,
      flReceipt(d),
    ),
  );
});
test("complaint read binds separate numeric form ID, exact detail/licence and response name", () => {
  const r = flRecord(),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml(),
    );
  assert.equal(h.rows.length, 3);
  assert.equal(h.detail_url, FL_URL);
  assert.equal(h.observed_public_form_id, "999001");
  for (const [id, name] of [
    ["CQ7654321", r.legal_name],
    ["A".repeat(32), r.legal_name],
    ["999001", "ANOTHER COMPANY"],
  ])
    assert.throws(() =>
      parseFloridaComplaints(
        r.detail_observation,
        id!,
        name!,
        notice,
        complaintHtml(),
      ),
    );
  assert.throws(() =>
    prepareFloridaComplaints(r, {
      ...flComplaintAgent(),
      detail: { ...flComplaintAgent().detail, observed_form_id: "111" },
    }),
  );
});
test("historical fines/sanctions coexist with active current licence; closed/Final Order alone is unknown", () => {
  const r = flRecord(),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml(),
    ),
    record = attachFloridaComplaints(r, h, flReceipt(h));
  assert.equal(record.status, "active");
  assert.equal(record.disciplinary_actions?.length, 2);
  assert.equal(h.rows[2]!.action, "unknown");
  assert.equal(h.rows[2]!.disposition, "Final Order");
  assert.equal(
    record.coverage.disciplinary_history,
    "published_public_listing_non_exhaustive",
  );
  assert.match(record.warnings.join(" "), /not exhaustive/);
});
test("1901 incident placeholders remain literal/unknown and invalid action/disposition dates are rejected", () => {
  const r = flRecord(),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml(),
    );
  assert.equal(h.rows[0]!.incident_date_literal, "01/01/1901");
  assert.equal(h.rows[0]!.incident_date, null);
  assert.equal(h.rows[0]!.incident_date_quality, "placeholder_unknown");
  for (const html of [
    complaintHtml({ incident: "02/30/2028" }),
    complaintHtml({ description: "02/30/2028 - Fine" }),
    complaintHtml().replace("08/13/1998</td>", "13/13/1998</td>"),
  ])
    assert.throws(() =>
      parseFloridaComplaints(
        r.detail_observation,
        "999001",
        r.legal_name,
        notice,
        html,
      ),
    );
});
test("missing warning, forged all-clear text and empty tables never establish exhaustive/no-actions history", () => {
  const r = flRecord();
  for (const warning of [
    "All public complaints are listed; confidential cases excluded.",
    "No discipline.",
    "Public complaints only.",
  ])
    assert.throws(() =>
      parseFloridaComplaints(
        r.detail_observation,
        "999001",
        r.legal_name,
        warning,
        complaintHtml(),
      ),
    );
  const h = parseFloridaComplaints(
    r.detail_observation,
    "999001",
    r.legal_name,
    notice,
    complaintHtml({ empty: true }),
  );
  assert.equal(h.outcome, "unknown");
  assert.equal(h.rows.length, 0);
  assert.throws(() =>
    parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml().replace("<th>Class</th>", "<th>Other</th>"),
    ),
  );
});
test("only bounded public fields survive; session/raw input and unrelated private data are not exports", () => {
  const d = parseFloridaDetail(
    flHtml() +
      "<p>DO_NOT_RETAIN_ADDRESS</p><input name='__RequestVerificationToken' value='SECRET_CSRF'>",
    FL_URL,
  );
  assert.doesNotMatch(JSON.stringify(d), /ADDRESS|SECRET|Token/);
  const r = resolveFloridaDetail(flSelection(), d, flReceipt(d));
  const report = exportFloridaLicence(r);
  assert.doesNotMatch(
    report.json + report.html + report.csv,
    /DO_NOT_RETAIN|SECRET_CSRF/,
  );
  assert.match(report.html, /Unknown|not checked/i);
  assert.throws(() =>
    parseFloridaComplaints(
      d,
      "999001",
      r.legal_name,
      notice,
      complaintHtml() + "<input name='token' value='secret'>",
    ),
  );
});
test("GET monitoring compares licence status/expiry without claiming complaint history was rechecked", () => {
  const base = flRecord(),
    history = parseFloridaComplaints(
      base.detail_observation,
      "999001",
      base.legal_name,
      notice,
      complaintHtml(),
    ),
    before = attachFloridaComplaints(base, history, flReceipt(history)),
    d = parseFloridaDetail(flHtml({ expiry: "03/31/2029" }), FL_URL),
    after = resolveFloridaDetail(
      flSelection(),
      d,
      flReceipt(d, "synthetic", "fixture", NOW + 1000),
    );
  const diff = compareFloridaLicence(before, after);
  assert.equal(diff.kind, "licence_fields_changed");
  assert.deepEqual(diff.changes, [
    { field: "expiry_date", before: "2028-03-31", after: "2029-03-31" },
  ]);
  assert.equal(diff.complaint_history_rechecked, false);
  assert.throws(() => compareFloridaLicence(after, before));
  const unknown = parseFloridaDetail(
    flHtml({ status: "Unexpected Status" }),
    FL_URL,
  );
  assert.equal(
    resolveFloridaDetail(flSelection(), unknown, flReceipt(unknown)).status,
    "unknown",
  );
});

// These status literals are synthetic illustrations, not verified regulator vocabulary.
for (const { name, nativeStatuses, normalizedStatuses, changes } of [
  {
    name: "different unknown native status literals remain visible in an unresolved comparison",
    nativeStatuses: ["Suspended", "Expired"],
    normalizedStatuses: ["unknown", "unknown"],
    changes: [
      { field: "native_status", before: "Suspended", after: "Expired" },
    ],
  },
  {
    name: "identical unknown native status literals remain unresolved without a false change",
    nativeStatuses: ["Suspended", "Suspended"],
    normalizedStatuses: ["unknown", "unknown"],
    changes: [],
  },
  {
    name: "an active to unknown comparison retains both native and normalized status changes",
    nativeStatuses: ["Current,Active", "Suspended"],
    normalizedStatuses: ["active", "unknown"],
    changes: [
      { field: "status", before: "active", after: "unknown" },
      {
        field: "native_status",
        before: "Current,Active",
        after: "Suspended",
      },
    ],
  },
]) {
  test(name, () => {
    const records = nativeStatuses.map((status, index) => {
      const detail = parseFloridaDetail(flHtml({ status }), FL_URL);
      return resolveFloridaDetail(
        flSelection(),
        detail,
        flReceipt(detail, "synthetic", "fixture", NOW + index * 1000),
      );
    });
    assert.deepEqual(
      records.map((record) => record.status),
      normalizedStatuses,
    );
    assert.deepEqual(
      records.map((record) => record.native_status),
      nativeStatuses,
    );
    const diff = compareFloridaLicence(records[0], records[1]);
    assert.equal(diff.kind, "status_unresolved");
    assert.deepEqual(diff.changes, changes);
    assert.equal(diff.complaint_history_rechecked, false);
  });
}

test("blank public case classes remain unknown and typed action/date tampering is rejected", () => {
  const r = flRecord(),
    html = complaintHtml().replaceAll("<td>RE Corp.</td>", "<td></td>"),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      html,
    );
  assert.equal(h.rows[0]!.case_class, null);
  assert.throws(() =>
    FloridaComplaintObservation.parse({
      ...h,
      rows: [{ ...h.rows[0], action_date: "2028-99-99" }],
    }),
  );
  const record = attachFloridaComplaints(r, h, flReceipt(h));
  assert.throws(() =>
    FloridaLicence.parse({ ...record, disciplinary_actions: [] }),
  );
});
test("an empty published table preserves unknown disciplinary actions rather than an empty clearance", () => {
  const r = flRecord(),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml({ empty: true }),
    ),
    record = attachFloridaComplaints(r, h, flReceipt(h));
  assert.equal(h.outcome, "unknown");
  assert.equal(record.disciplinary_actions, null);
  assert.throws(() =>
    FloridaSearchObservation.parse({
      ...flSearch,
      complete: true,
      total_results: 0,
      candidates: [],
      explicit_empty_text: null,
    }),
  );
});

test("unreviewed or explicit no-action descriptions stay literal/unknown and never become disciplinary actions", () => {
  const r = flRecord(),
    h = parseFloridaComplaints(
      r.detail_observation,
      "999001",
      r.legal_name,
      notice,
      complaintHtml({ description: "08/13/1998 - No action" }),
    );
  assert.equal(h.rows[0]!.discipline_description, "08/13/1998 - No action");
  assert.equal(h.rows[0]!.action, "unknown");
  assert.equal(
    attachFloridaComplaints(r, h, flReceipt(h)).disciplinary_actions?.length,
    1,
  );
});
