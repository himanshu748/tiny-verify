import { mkdir, open, rename, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadControlsFromEnvironment } from "../../shared/index.js";
import { FetchRegistryProvider } from "./live-provider.js";
import { resolveObservation } from "./parser.js";
import type { Lookup } from "./contracts.js";

export const LIVE_CASES: readonly Lookup[] = [
  {
    by: "registration_id",
    registry: "uk_companies_house",
    registration_id: "00445790",
  },
  {
    by: "registration_id",
    registry: "au_abn_lookup",
    registration_id: "88000014675",
  },
];
const safeCode = (error: unknown) => {
  const value =
    error && typeof error === "object" && "code" in error
      ? error.code
      : "OPERATION_FAILED";
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value)
    ? value
    : "OPERATION_FAILED";
};
async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--output" ||
    !args[1] ||
    !isAbsolute(args[1]) ||
    resolve(args[1]) !== args[1]
  )
    throw new Error("INVALID_ARGUMENTS");
  const output = args[1];
  const controls = await loadControlsFromEnvironment();
  await mkdir(output, { mode: 0o700 });
  if ((await realpath(output)) !== output)
    throw new Error("UNSAFE_OUTPUT_PATH");
  const atomic = async (name: string, value: string) => {
    const temp = join(output, `.${randomUUID()}.tmp`),
      file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(output, name));
    const directory = await open(output, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  const attempts: Array<{
    lookup: Lookup;
    status: string;
    [key: string]: unknown;
  }> = [];
  const report = () => ({
    kind: "tinyverify_live_fetch_proof",
    recorded_at: new Date().toISOString(),
    maximum_url_operations: 2,
    planned_cases: LIVE_CASES,
    unattempted_cases: LIVE_CASES.filter(
      (lookup) =>
        !attempts.some(
          (attempt) =>
            attempt.lookup.registry === lookup.registry &&
            attempt.status !== "not_attempted",
        ),
    ),
    monitor_created: false,
    attempts,
  });
  await atomic("proof.json", JSON.stringify(report(), null, 2));
  const provider = new FetchRegistryProvider(controls, {
    onFetched: async (lookup, fetched) => {
      await atomic(
        `${lookup.registry}-${lookup.registration_id}.html`,
        fetched.html,
      );
      await atomic(
        `${lookup.registry}-${lookup.registration_id}.transport.json`,
        JSON.stringify({ ...fetched, html: undefined }, null, 2),
      );
    },
  });
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    for (const lookup of LIVE_CASES) {
      if (controller.signal.aborted) {
        attempts.push({ lookup, status: "not_attempted", error: "CANCELLED" });
        break;
      }
      const status = await controls.pool.status();
      if (
        status.halted ||
        status.active_operations >= 2 ||
        (status.by_bounty["tiny-verify"]?.operations ?? 0) >= 6
      ) {
        attempts.push({
          lookup,
          status: "not_attempted",
          error: status.halted
            ? "HALTED"
            : status.active_operations >= 2
              ? "BUSY"
              : "OPERATION_LIMIT",
        });
        await atomic("proof.json", JSON.stringify(report(), null, 2));
        break;
      }
      try {
        const observed = await provider.observe(lookup, controller.signal),
          result = resolveObservation(
            lookup,
            observed.observation,
            observed.evidence,
          );
        attempts.push({ lookup, status: "observed", ...observed, result });
      } catch (error) {
        const code = safeCode(error);
        attempts.push({ lookup, status: "failed", error: code });
        await atomic("proof.json", JSON.stringify(report(), null, 2));
        if (
          [
            "HALTED",
            "BUSY",
            "PROVIDER_UNCERTAIN",
            "STATE_FAILURE",
            "CANCELLED",
          ].includes(code)
        )
          break;
      }
      await atomic("proof.json", JSON.stringify(report(), null, 2));
    }
    await atomic("proof.json", JSON.stringify(report(), null, 2));
    console.log(JSON.stringify(report(), null, 2));
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: safeCode(error),
      message:
        "The finite proof did not complete. No automatic retry was made.",
    }),
  );
  process.exitCode = 1;
});
