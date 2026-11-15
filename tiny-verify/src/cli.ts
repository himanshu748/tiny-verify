import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prepareBusinessRequest } from "./intake.js";
import { parseLookup } from "./registries.js";
import { resolveObservation } from "./parser.js";
import { exportRegistration } from "./report.js";
import { RegistryError } from "./contracts.js";
async function jsonFile(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1000000)
    throw new RegistryError(
      "INVALID_INPUT",
      "Use a regular JSON file up to one megabyte.",
    );
  return JSON.parse(await readFile(path, "utf8"));
}
/** Keyless entry points only. This command never loads a grant, key, environment live switch or provider adapter. */
export async function runCli(
  argv: string[],
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  if (argv[0] === "plan" && argv.length === 2) {
    write(
      JSON.stringify(
        {
          mode: "zero_call_plan",
          ...prepareBusinessRequest(await jsonFile(argv[1]!)),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (argv[0] === "replay" && argv.length === 3) {
    const proof = z
      .object({
        kind: z.literal("tinyverify_live_fetch_proof"),
        attempts: z
          .array(
            z.object({
              lookup: z.unknown(),
              observation: z.unknown(),
              evidence: z.unknown(),
            }),
          )
          .min(1)
          .max(10),
      })
      .parse(await jsonFile(argv[1]!));
    const attempts = proof.attempts.map((attempt) => {
      const lookup = parseLookup(attempt.lookup);
      const result = resolveObservation(
        lookup,
        attempt.observation,
        attempt.evidence,
      );
      return {
        lookup,
        result,
        output:
          result.kind === "verified" ? exportRegistration(result.record) : null,
      };
    });
    const directory = resolve(argv[2]!);
    await mkdir(directory, { mode: 0o700 }); // Existing paths are never overwritten.
    for (const [index, attempt] of attempts.entries())
      if (attempt.output) {
        for (const format of ["json", "csv", "html"] as const)
          await writeFile(
            join(directory, `record-${index + 1}.${format}`),
            attempt.output[format],
            { flag: "wx", mode: 0o600 },
          );
      }
    const summary = {
      mode: "historical_saved_proof_replay",
      provider_requests: 0,
      credentials_read: false,
      independently_verified_transport: false,
      attempts: attempts.map(({ lookup, result }) => ({ lookup, result })),
    };
    await writeFile(
      join(directory, "replay.json"),
      JSON.stringify(summary, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    write(
      JSON.stringify({
        mode: summary.mode,
        provider_requests: 0,
        output: directory,
        records: attempts.filter((x) => x.output).length,
      }) + "\n",
    );
    return 0;
  }
  throw new RegistryError(
    "INVALID_INPUT",
    "Usage: tiny-verify/src/cli.ts plan request.json | replay evidence/live-fetch-proof.json NEW_OUTPUT_DIRECTORY",
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(
        "TinyVerify stopped: invalid input or output could not be written. No provider call was made.\n",
      );
      process.exitCode = 1;
    },
  );
