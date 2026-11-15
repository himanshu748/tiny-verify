import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  readdir,
  writeFile,
  lstat,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const label =
  process.argv[2] ??
  "candidate-gate-" + new Date().toISOString().replace(/[^\d]/g, "");
if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(label))
  throw Error("Use a bounded local evidence label.");
const out = join(root, "evidence", label);
await mkdir(out); // A verification receipt is never overwritten; use a new label.
const clean = await mkdtemp(join(tmpdir(), "tinyverify-standalone-"));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const pointerPath = "evidence/current-source.json";
const currentSource = JSON.parse(
  await readFile(join(root, pointerPath), "utf8"),
);
if (
  currentSource.version !== 1 ||
  currentSource.expected_tests !== 132 ||
  !/^evidence\/[a-z0-9][a-z0-9-]{2,79}\/source-manifest\.json$/.test(
    currentSource.source_manifest,
  )
)
  throw Error("The current source pointer is invalid.");
const manifestPath = currentSource.source_manifest;
const sourceManifest = JSON.parse(
  await readFile(join(root, manifestPath), "utf8"),
);
if (
  sourceManifest.expected_tests !== currentSource.expected_tests ||
  sourceManifest.source_tree_sha256 !==
    currentSource.current_source_tree_sha256 ||
  hash(
    sourceManifest.files
      .map((file) => file.path + " " + file.sha256)
      .join("\n"),
  ) !== sourceManifest.source_tree_sha256
)
  throw Error("Current source manifest identity is inconsistent.");
const liveManifestPath = currentSource.live_evidence_source_manifest;
if (
  !/^evidence\/[a-z0-9][a-z0-9-]{2,79}\/source-manifest\.json$/.test(
    liveManifestPath,
  )
)
  throw Error("The historical live-source pointer is invalid.");
const liveSourceManifest = JSON.parse(
  await readFile(join(root, liveManifestPath), "utf8"),
);
if (
  liveSourceManifest.source_tree_sha256 !==
    currentSource.live_evidence_source_tree_sha256 ||
  liveSourceManifest.files.length !== 47 ||
  hash(
    liveSourceManifest.files
      .map((file) => file.path + " " + file.sha256)
      .join("\n"),
  ) !== liveSourceManifest.source_tree_sha256
)
  throw Error("Historical live-source identity is inconsistent.");
const inventory = [];
async function copy(relative) {
  const source = resolve(root, relative);
  if (!source.startsWith(root)) throw Error("Package path escaped its root.");
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink())
    throw Error("Unsafe package file.");
  const body = await readFile(source),
    target = join(clean, relative);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  inventory.push({ path: relative, bytes: body.length, sha256: hash(body) });
}
for (const file of sourceManifest.files) {
  if (hash(await readFile(join(root, file.path))) !== file.sha256)
    throw Error(
      "Packaged source differs from its frozen original: " + file.path,
    );
  await copy(file.path);
}
const contentManifest = JSON.parse(
  await readFile(join(root, "release-content-manifest.json"), "utf8"),
);
if (
  contentManifest.kind !== "PUBLIC_RELEASE_CANDIDATE_FIXED_CONTENT" ||
  sourceManifest.files.length !== 47 ||
  contentManifest.source_tree_sha256 !== sourceManifest.source_tree_sha256 ||
  !Array.isArray(contentManifest.files) ||
  new Set(contentManifest.files.map((file) => file.path)).size !==
    contentManifest.files.length ||
  hash(
    contentManifest.files
      .map((file) => file.path + " " + file.sha256)
      .join("\n"),
  ) !== contentManifest.content_tree_sha256
)
  throw Error("Release content identity is inconsistent.");
const sourcePaths = new Set(sourceManifest.files.map((file) => file.path));
for (const file of contentManifest.files) {
  if (
    typeof file.path !== "string" ||
    file.path.startsWith("/") ||
    file.path.split("/").some((segment) => segment === ".." || !segment) ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw Error("Unsafe release manifest path.");
  const body = await readFile(join(root, file.path));
  if (hash(body) !== file.sha256 || body.length !== file.bytes)
    throw Error("Release content changed: " + file.path);
  if (!sourcePaths.has(file.path)) await copy(file.path);
}
await copy("release-content-manifest.json");
const reviewed = JSON.parse(
  await readFile(join(clean, "evidence/release/reviewed-florida.json"), "utf8"),
);
const liveSummary = JSON.parse(
  await readFile(
    join(clean, "evidence/verification/florida-live-outcome-summary.json"),
    "utf8",
  ),
);
if (
  reviewed.source_runtime_sha256 !== liveSourceManifest.source_tree_sha256 ||
  reviewed.record.licence_number !== "CQ247822" ||
  reviewed.record.complaint_listing.rows.length !== 7 ||
  reviewed.record.disciplinary_actions.length !== 4 ||
  reviewed.monitor.paused_confirmed !== true ||
  reviewed.monitor.client_diff.kind !== "unchanged" ||
  reviewed.monitor.client_diff.complaint_history_rechecked !== false ||
  reviewed.monitor.provider_metadata.baseline.provider_outcome !== "unknown" ||
  reviewed.monitor.provider_metadata.followup.provider_outcome !== "unknown" ||
  reviewed.fresh_recheck_performed_on_open !== false ||
  liveSummary.source_runtime_sha256 !== liveSourceManifest.source_tree_sha256 ||
  liveSummary.successful_operations.discovery_agent !== 1 ||
  liveSummary.successful_operations.detail_fetch !== 1 ||
  liveSummary.successful_operations.complaint_agent !== 1 ||
  liveSummary.successful_operations.monitor_check !== 2
)
  throw Error(
    "The selected saved Florida evidence lost its reviewed boundary.",
  );
await writeFile(join(clean, "empty-npmrc"), "");
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  TZ: "UTC",
  BOUNTY_POOL_LIVE: "0",
  TINYVERIFY_LIVE: "0",
  NPM_CONFIG_USERCONFIG: join(clean, "empty-npmrc"),
  NPM_CONFIG_CACHE: join(clean, ".npm-cache"),
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
};
const checks = [];
const publicCommand = (command) =>
  command === process.execPath ? "node" : command;
const safeArgument = (argument) =>
  argument.startsWith(clean)
    ? argument.replace(clean, "<isolated-copy>")
    : argument;
function run(name, command, args, offline = true, expectedExit = 0) {
  const result = spawnSync(command, args, {
    cwd: clean,
    env: {
      ...env,
      ...(offline
        ? {
            NODE_OPTIONS:
              "--import=" + join(clean, "scripts/offline-guard.mjs"),
            TINYVERIFY_NETWORK_LOG: join(out, "blocked-fetch.log"),
          }
        : {}),
    },
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 2000000,
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  checks.push({
    name,
    command: [publicCommand(command), ...args.map(safeArgument)],
    exit_code: result.status,
    expected_exit_code: expectedExit,
    output_sha256: hash(output),
    output_bytes: Buffer.byteLength(output),
  });
  if (result.status !== expectedExit) {
    // Full output is diagnostic-only in the disposable copy, never a public receipt.
    return writeFile(join(clean, "failed-" + name + ".log"), output).then(
      () => {
        throw Error(
          name + " failed; inspect the disposable diagnostic output.",
        );
      },
    );
  }
  return Promise.resolve(result.stdout || result.stderr);
}
try {
  await writeFile(
    join(out, "package-inventory.json"),
    JSON.stringify(inventory, null, 2) + "\n",
  );
  await run(
    "fresh-install",
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    false,
  );
  const tests = await run("tests", "npm", ["test"]);
  const count = Number(/(?:#|ℹ) tests (\d+)/.exec(tests)?.[1]);
  const pass = Number(/(?:#|ℹ) pass (\d+)/.exec(tests)?.[1]);
  if (count !== currentSource.expected_tests || pass !== count)
    throw Error(
      "The declared native-status comparison repair test suite changed.",
    );
  await run("typecheck", "npm", ["run", "typecheck"]);
  await run("build", "npm", ["run", "build"]);
  await run("format", "npm", ["run", "format:check"]);
  const demo = JSON.parse(
    await run("compiled-demo", process.execPath, [
      "dist/tiny-verify/src/demo.js",
    ]),
  );
  if (demo.mode !== "synthetic_offline" || demo.provider_requests !== 0)
    throw Error("The compiled demo did not remain synthetic.");
  const plan = JSON.parse(
    await run("compiled-plan", process.execPath, [
      "dist/tiny-verify/src/cli.js",
      "plan",
      "examples/request-gb.json",
    ]),
  );
  if (plan.provider_requests !== 0)
    throw Error("Planning dispatched a request.");
  const replay = JSON.parse(
    await run("compiled-replay", process.execPath, [
      "dist/tiny-verify/src/cli.js",
      "replay",
      "tiny-verify/evidence/live-fetch-proof.json",
      "historical-review",
    ]),
  );
  if (replay.provider_requests !== 0 || replay.records !== 2)
    throw Error("Historical replay changed its boundary.");
  const floridaDemo = await run("source-florida-demo", "npm", [
    "run",
    "--silent",
    "demo:florida",
    "--",
    "florida-synthetic-review",
  ]);
  const florida = JSON.parse(floridaDemo);
  if (
    florida.mode !== "synthetic_offline_florida" ||
    florida.provider_requests !== 0 ||
    florida.record.disciplinary_actions.length !== 2 ||
    florida.empty_visible_table.visible_rows !== 0 ||
    florida.empty_visible_table.outcome !== "unknown" ||
    florida.empty_visible_table.disciplinary_actions !== null ||
    florida.empty_visible_table.clearance_claimed !== false
  )
    throw Error(
      "The synthetic Florida demo or empty-history semantics changed.",
    );
  await run("compiled-florida-semantics", process.execPath, [
    "--input-type=module",
    "-e",
    'import {parseFloridaComplaints,attachFloridaComplaints,exportFloridaLicence} from "./dist/tiny-verify/src/florida.js";import {flRecord,flReceipt,complaintHtml,notice} from "./dist/tiny-verify/test/florida-fixtures.js";const r=flRecord();const h=parseFloridaComplaints(r.detail_observation,"999001",r.legal_name,notice,complaintHtml({empty:true}));const record=attachFloridaComplaints(r,h,flReceipt(h));if(record.disciplinary_actions!==null||h.outcome!=="unknown"||h.rows.length!==0)throw Error("False clearance");const report=exportFloridaLicence(record);if(!report.html.includes("Unknown; no clearance inferred"))throw Error("Missing warning");console.log(JSON.stringify({mode:"synthetic_compiled_florida",provider_requests:0,expiry:record.expiry_date,visible_rows:h.rows.length,outcome:h.outcome,disciplinary_actions:record.disciplinary_actions,clearance_claimed:false}));',
  ]);
  for (const name of [
    "discover",
    "watch",
    "initialize",
    "cleanup",
    "fl-discover",
    "fl-inspect",
    "fl-history",
    "fl-watch",
  ]) {
    const result = JSON.parse(
      await run("compiled-operator-disabled-" + name, process.execPath, [
        "dist/tiny-verify/src/operator.js",
        name,
        "/unread-input",
        "/unread-output",
      ]),
    );
    if (
      result.status !== "disabled" ||
      result.provider_requests !== 0 ||
      result.credential_paths_read !== false
    )
      throw Error("The real operator read private state while disabled.");
  }
  await run("compiled-library-disabled", process.execPath, [
    "--input-type=module",
    "-e",
    'import {discoverBusiness} from "./dist/tiny-verify/src/index.js";try{await discoverBusiness({name:"Example Company",jurisdiction:"GB",record_type:"company_registration"});throw Error("unexpected enabled provider");}catch(e){if(e.code!=="LIVE_DISABLED")throw e;}console.log(JSON.stringify({provider_requests:0,status:"LIVE_DISABLED"}));',
  ]);
  const legacyOutput = await run(
    "compiled-legacy-proof-disabled",
    process.execPath,
    [
      "dist/tiny-verify/src/live-proof.js",
      "--output",
      join(clean, "must-not-be-created"),
    ],
    true,
    1,
  );
  const legacy = JSON.parse(legacyOutput);
  if (legacy.error !== "LIVE_DISABLED")
    throw Error("Legacy proof did not remain disabled.");
  try {
    await lstat(join(clean, "must-not-be-created"));
    throw Error("Disabled legacy proof created output.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let external = "";
  try {
    external = await readFile(join(out, "blocked-fetch.log"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (external) throw Error("An offline entry point attempted external fetch.");
  for (const file of inventory)
    if (hash(await readFile(join(root, file.path))) !== file.sha256)
      throw Error("Package changed during verification: " + file.path);
  const receipt = {
    checked_at: new Date().toISOString(),
    kind: "fresh_install_isolated_public_release_candidate_gate",
    status: "LOCAL_CANDIDATE_PASSED_NOT_PUBLISHED_OR_SUBMITTED",
    node: process.version,
    clean_copy: "Disposable fresh temporary copy; machine-local path omitted.",
    tests: count,
    pass,
    checks,
    source_tree_sha256: sourceManifest.source_tree_sha256,
    source_manifest: manifestPath,
    live_evidence_source_manifest: liveManifestPath,
    live_evidence_source_tree_sha256: liveSourceManifest.source_tree_sha256,
    current_source_differs_from_live_evidence:
      sourceManifest.source_tree_sha256 !==
      liveSourceManifest.source_tree_sha256,
    source_pointer: pointerPath,
    frozen_source: currentSource.frozen_source,
    source_bytes_match_current_manifest: true,
    frozen_source_files: sourceManifest.files.length,
    release_content_files: contentManifest.files.length,
    release_content_tree_sha256: contentManifest.content_tree_sha256,
    historical_metadata_omissions_explicit: true,
    saved_florida_evidence_boundary_checked: true,
    package_unchanged_during_gate: true,
    dependency_mode:
      "Fresh npm ci --ignore-scripts from the standalone lockfile; no node_modules symlink or parent dependencies.",
    provider_operations: 0,
    external_fetch_attempts: 0,
    real_credentials_or_private_grants_read: false,
    historical_evidence:
      "Two unchanged genuine 8 November UK/AU observations replayed. A separate labelled 13 November eight-Fetch summary remains historical. No source status or provider account rechecked.",
    florida_evidence:
      "Saved 15 November source129 discovery, detail Fetch, complaint Agent and paused two-observation Monitor evidence retains its original source hash. The 16 November native-status comparison repair is verified offline on its separate current source hash. This gate performs no provider work. Source QA, saved-review UI and video checks are existing dated receipts, not fresh live checks.",
    empty_history_result:
      "unknown with null actions; zero visible rows never means clean history",
    hosting_publication_or_submission: false,
    submission_ready: false,
  };
  await writeFile(
    join(out, "verification.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  await rm(clean, { recursive: true, force: true });
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  await writeFile(
    join(out, "verification.json"),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        status: "LOCAL_CANDIDATE_FAILED_NOT_READY",
        checks,
        provider_operations: 0,
        real_credentials_or_private_grants_read: false,
        message:
          "Inspect the disposable-copy diagnostic output; no later gate is claimed.",
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
}
