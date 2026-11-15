import { lstat, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RegistryError, VerifiedRecord } from "./contracts.js";
import {
  prepareBusinessRequest,
  discoverBusiness,
  inspectBusinessSelection,
} from "./intake.js";
import { exportRegistration } from "./report.js";
import {
  loadRuntimeControls,
  privateDirectory,
  type RuntimeState,
} from "./runtime-controls.js";
import {
  TinyVerifyRuntimeTransport,
  type RuntimeReceipt,
} from "./runtime-transport.js";
import {
  FloridaRequest,
  FloridaLicence,
  selectFloridaCandidate,
  exportFloridaLicence,
} from "./florida.js";
import { verifyFiniteStatusWatch } from "./status-watch.js";
async function inputFile(path: string): Promise<unknown> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new RegistryError(
      "INVALID_INPUT",
      "Use one bounded regular input JSON file.",
    );
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new RegistryError("INVALID_INPUT", "Input must be valid JSON.");
  }
}
async function save(directory: string, name: string, value: unknown) {
  await writeFile(
    join(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
function budget(state: RuntimeState) {
  return {
    halted: state.halted,
    halt_reason: state.halt_reason,
    reserved_microusd: state.reserved_microusd,
    content_reservations: state.entries.length,
    active_or_uncertain: state.entries.filter((e) => e.state !== "terminal")
      .length,
    monitor_paused_confirmed: state.claim?.paused_confirmed ?? null,
  };
}
const publicCodes = new Set([
  "INVALID_INPUT",
  "SITE_CHANGED",
  "EVIDENCE_MISMATCH",
  "LIVE_DISABLED",
  "MONITOR_UNBOUNDED",
  "MONITOR_INVALID",
  "CANCELLED",
  "REMOTE_STATE_UNCERTAIN",
  "AUTHORIZATION_REQUIRED",
  "BUDGET_HALTED",
  "BUDGET_EXHAUSTED",
  "BUSY",
  "STATE_FAILURE",
  "PRICING_CHANGED",
  "PROVIDER_FAILURE",
  "PROVIDER_CONTRACT",
  "PROVIDER_TIMEOUT",
]);
function code(error: unknown) {
  const field =
    error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")
      : undefined;
  return field &&
    typeof field.value === "string" &&
    publicCodes.has(field.value)
    ? field.value
    : "PROVIDER_FAILURE";
}
export type OperatorDependencies = {
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  request?: typeof fetch;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  write?: (text: string) => void;
  load?: typeof loadRuntimeControls;
};
/** All live work needs an existing separate owner permit; this command never creates or upgrades an authorization. */
export async function runRuntimeOperator(
  argv: string[],
  deps: OperatorDependencies = {},
) {
  const env = deps.env ?? process.env,
    write = deps.write ?? ((text) => process.stdout.write(text));
  if (env.TINYVERIFY_LIVE !== "1") {
    const summary = {
      status: "disabled",
      provider_requests: 0,
      credential_paths_read: false,
    };
    write(JSON.stringify(summary) + "\n");
    return { exit_code: 0, summary };
  }
  let output: string | undefined,
    controls: Awaited<ReturnType<typeof loadRuntimeControls>>,
    transport: TinyVerifyRuntimeTransport | undefined,
    retained = false;
  try {
    const command = argv[0],
      clock = deps.clock ?? Date.now;
    if (command === "initialize" && argv.length === 1) {
      controls = await (deps.load ?? loadRuntimeControls)(env, clock);
      if (!controls) throw new RegistryError("LIVE_DISABLED", "Disabled.");
      await controls.ledger.initialize();
      const summary = { status: "initialized", provider_requests: 0 };
      write(JSON.stringify(summary) + "\n");
      return { exit_code: 0, summary };
    }
    if (command === "status" && argv.length === 1) {
      controls = await (deps.load ?? loadRuntimeControls)(env, clock, {
        allowExpiredForCleanup: true,
      });
      if (!controls) throw new RegistryError("LIVE_DISABLED", "Disabled.");
      const summary = {
        status: "local_status",
        ...budget(await controls.ledger.read()),
      };
      write(JSON.stringify(summary) + "\n");
      return { exit_code: 0, summary };
    }
    let input: unknown,
      selected: string | undefined,
      useAgent = false;
    if (command === "fl-discover" && argv.length === 3) {
      input = FloridaRequest.parse(await inputFile(argv[1]!));
      output = resolve(argv[2]!);
    } else if (command === "fl-inspect" && argv.length === 5) {
      const found = z
        .object({
          request: z.unknown(),
          observation: z.unknown(),
          evidence: z.unknown(),
        })
        .parse(await inputFile(argv[1]!));
      input = selectFloridaCandidate(
        found.request,
        found.observation,
        found.evidence,
        argv[2]!,
        argv[3]!,
      );
      output = resolve(argv[4]!);
    } else if (
      (command === "fl-history" || command === "fl-watch") &&
      argv.length === 3
    ) {
      input = FloridaLicence.parse(await inputFile(argv[1]!));
      output = resolve(argv[2]!);
    } else if (
      command === "discover" &&
      (argv.length === 3 || (argv.length === 4 && argv[3] === "--agent"))
    ) {
      input = await inputFile(argv[1]!);
      prepareBusinessRequest(input);
      output = resolve(argv[2]!);
      useAgent = argv[3] === "--agent";
    } else if (command === "inspect" && argv.length === 4) {
      input = z
        .object({
          request: z.unknown(),
          observation: z.unknown(),
          evidence: z.unknown(),
        })
        .parse(await inputFile(argv[1]!));
      selected = argv[2]!;
      output = resolve(argv[3]!);
    } else if (command === "watch" && argv.length === 3) {
      input = VerifiedRecord.parse(await inputFile(argv[1]!));
      output = resolve(argv[2]!);
    } else if (command === "cleanup" && argv.length === 2) {
      output = resolve(argv[1]!);
    } else
      throw new RegistryError(
        "INVALID_INPUT",
        "Use initialize/status/cleanup, discover/inspect/watch for UK/AU registrations, or fl-discover REQUEST OUT, fl-inspect DISCOVERY LICENCE EXACT_DETAIL_URL OUT, fl-history RECORD OUT, fl-watch RECORD OUT for Florida.",
      );
    await privateDirectory(dirname(output));
    await mkdir(output, { mode: 0o700 }); // Existing output, symlink or redirected parents stop before key loading.
    controls = await (deps.load ?? loadRuntimeControls)(env, clock, {
      allowExpiredForCleanup: command === "cleanup",
    });
    if (!controls) throw new RegistryError("LIVE_DISABLED", "Disabled.");
    await controls.ledger.read();
    transport = new TinyVerifyRuntimeTransport(controls.ledger, controls.key, {
      ...(deps.request ? { request: deps.request } : {}),
      clock,
      ...(deps.pause ? { pause: deps.pause } : {}),
    });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      let result: unknown;
      if (command === "cleanup") result = await transport.cleanup();
      else if (command === "fl-discover")
        result = await transport.discoverFlorida(input, abort.signal);
      else if (command === "fl-inspect")
        result = await transport.inspectFlorida(input, abort.signal);
      else if (command === "fl-history")
        result = await transport.floridaComplaints(input, abort.signal);
      else if (command === "discover")
        result = await discoverBusiness(
          input,
          useAgent ? transport.agentProvider() : transport,
          abort.signal,
        );
      else if (command === "inspect") {
        const found = input as {
          request: unknown;
          observation: unknown;
          evidence: unknown;
        };
        result = await inspectBusinessSelection(
          found.request,
          found,
          selected!,
          transport,
          abort.signal,
        );
      } else {
        const record =
            command === "fl-watch"
              ? FloridaLicence.parse(input)
              : VerifiedRecord.parse(input),
          grant = controls.ledger.permit,
          window = grant.monitor_window;
        if (!window || !grant.monitor_target_url)
          throw new RegistryError(
            "AUTHORIZATION_REQUIRED",
            "This separate permit authorizes no Monitor resource.",
          );
        result = await verifyFiniteStatusWatch(
          record,
          {
            ...window,
            target_url: grant.monitor_target_url,
            max_checks: 2,
            no_scheduled_runs: true,
            pause_on_completion: true,
          },
          await transport.monitorTransport(),
          abort.signal,
          clock,
        );
      }
      await save(output, "result.json", result);
      const reusable = (
        result as { result?: { kind?: string; record?: unknown } }
      )?.result;
      const floridaRecord = (result as { record?: unknown })?.record;
      if (
        floridaRecord &&
        (floridaRecord as { registry?: string }).registry === "florida_dbpr"
      ) {
        const exported = exportFloridaLicence(floridaRecord);
        for (const format of ["json", "csv", "html"] as const)
          await writeFile(join(output, "record." + format), exported[format], {
            flag: "wx",
            mode: 0o600,
          });
      }
      if (reusable?.kind === "verified") {
        const exported = exportRegistration(reusable.record);
        for (const format of ["json", "csv", "html"] as const)
          await writeFile(join(output, "record." + format), exported[format], {
            flag: "wx",
            mode: 0o600,
          });
      }
      await retain(
        output,
        transport.receipts,
        transport.captures,
        transport.agentExtractions,
        transport.pricing,
      );
      retained = true;
      await save(output, "budget.json", budget(await controls.ledger.read()));
      const cleanupComplete =
        command !== "cleanup" ||
        ((
          result as {
            agent_terminal_confirmed: boolean;
            monitor_paused_confirmed: boolean;
          }
        ).agent_terminal_confirmed &&
          (result as { monitor_paused_confirmed: boolean })
            .monitor_paused_confirmed);
      const summary = {
        status:
          command === "cleanup"
            ? cleanupComplete
              ? "cleanup_recorded"
              : "cleanup_required"
            : command === "watch" || command === "fl-watch"
              ? "paused_verification_recorded"
              : "result_saved",
        output_directory: output,
        ...budget(await controls.ledger.read()),
      };
      write(JSON.stringify(summary) + "\n");
      return { exit_code: cleanupComplete ? 0 : 1, summary };
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch (error) {
    if (controls) {
      try {
        await controls.ledger.halt("verification_failed");
      } catch {}
    }
    if (output) {
      if (transport && !retained) {
        try {
          await retain(
            output,
            transport.receipts,
            transport.captures,
            transport.agentExtractions,
            transport.pricing,
          );
        } catch {}
      }
      try {
        await save(output, "failure.json", {
          code: code(error),
          diagnostics: transport?.diagnostics ?? null,
          raw_errors_retained: false,
        });
      } catch {}
      if (controls) {
        try {
          await save(
            output,
            "budget.json",
            budget(await controls.ledger.read()),
          );
        } catch {}
      }
    }
    const summary = {
      status: "failed",
      code: code(error),
      output_directory: output ?? null,
    };
    write(JSON.stringify(summary) + "\n");
    return { exit_code: 1, summary };
  }
}
async function retain(
  directory: string,
  receipts: RuntimeReceipt[],
  captures: TinyVerifyRuntimeTransport["captures"],
  extractions: TinyVerifyRuntimeTransport["agentExtractions"],
  pricing: TinyVerifyRuntimeTransport["pricing"],
) {
  await save(directory, "pricing.json", pricing);
  await save(directory, "agent-extractions.json", extractions);
  await save(directory, "receipts.json", receipts);
  const metadata = [];
  for (const capture of captures) {
    await writeFile(join(directory, capture.name), capture.html, {
      flag: "wx",
      mode: 0o600,
    });
    metadata.push({
      file: capture.name,
      source_url: capture.source_url,
      checked_at: capture.checked_at,
      sha256: capture.sha256,
      scope: "selected_html_not_full_http_response",
    });
  }
  await save(directory, "captures.json", metadata);
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  runRuntimeOperator(process.argv.slice(2)).then(
    (result) => {
      process.exitCode = result.exit_code;
    },
    () => {
      process.stderr.write(
        "TinyVerify stopped; private details were withheld.\n",
      );
      process.exitCode = 1;
    },
  );
