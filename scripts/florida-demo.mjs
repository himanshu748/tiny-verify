import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseFloridaComplaints,
  attachFloridaComplaints,
  exportFloridaLicence,
} from "../tiny-verify/src/florida.ts";
import {
  flRecord,
  flReceipt,
  complaintHtml,
  notice,
} from "../tiny-verify/test/florida-fixtures.ts";

// Reuse explicitly synthetic source-shaped fixtures; no registry or provider call.
const [output, ...extra] = process.argv.slice(2);
if (extra.length)
  throw Error("Use at most one NEW synthetic output directory.");
const before = flRecord();
function history(empty) {
  const observed = parseFloridaComplaints(
    before.detail_observation,
    "999001",
    before.legal_name,
    notice,
    complaintHtml({ empty }),
  );
  return attachFloridaComplaints(before, observed, flReceipt(observed));
}
const record = history(false),
  empty = history(true),
  exported = exportFloridaLicence(record);
if (output) {
  const directory = resolve(output);
  await mkdir(directory, { mode: 0o700 }); // Never overwrite an existing directory.
  for (const format of ["json", "csv", "html"])
    await writeFile(join(directory, "record." + format), exported[format], {
      flag: "wx",
      mode: 0o600,
    });
  await writeFile(
    join(directory, "empty-history.json"),
    exportFloridaLicence(empty).json,
    { flag: "wx", mode: 0o600 },
  );
}
console.log(
  JSON.stringify(
    {
      mode: "synthetic_offline_florida",
      provider_requests: 0,
      credentials_read: false,
      fictional_data:
        "Fixture names, IDs and cases; not asserted to be unissued.",
      record,
      empty_visible_table: {
        visible_rows: empty.complaint_listing.rows.length,
        outcome: empty.complaint_listing.outcome,
        disciplinary_actions: empty.disciplinary_actions,
        coverage: empty.coverage.disciplinary_history,
        clearance_claimed: false,
      },
      output_directory: output ? resolve(output) : null,
    },
    null,
    2,
  ),
);
