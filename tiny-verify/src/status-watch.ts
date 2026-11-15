import { z } from "zod";
import {
  RegistryError,
  VerifiedRecord,
  type RegistrationRecord,
} from "./contracts.js";
import { recordUrl } from "./registries.js";
import { resolveObservation } from "./parser.js";
import {
  FloridaLicence,
  floridaDetailUrl,
  resolveFloridaMonitoredDetail,
  compareFloridaLicence,
  type FloridaLicenceData,
} from "./florida.js";
import type { VerificationResult } from "./contracts.js";
import { compareRegistration } from "./diff.js";

const Permit = z
  .object({
    operation_id: z.uuid(),
    authorized_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    target_url: z.string().url(),
    max_checks: z.literal(2),
    no_scheduled_runs: z.literal(true),
    pause_on_completion: z.literal(true),
  })
  .strict();
export type StatusWatchPermit = z.infer<typeof Permit>;
const Owned = z
  .object({
    id: z.uuid(),
    name: z.string(),
    url: z.string().url(),
    status: z.enum(["active", "paused"]),
  })
  .strict();
export type OwnedStatusMonitor = z.infer<typeof Owned>;
export type StatusMonitorObservation = {
  monitor_id: string;
  run_id: string;
  observation: unknown;
  evidence: unknown;
  provider_metadata?: {
    checkpoint_role: "baseline" | "followup";
    provider_is_baseline: boolean | null;
    provider_outcome: "baseline" | "changed" | "unchanged" | "unknown";
    provider_diff_sha256: string | null;
    provider_diff_truncated: boolean | null;
  };
};
/** The controlled HTTP runtime supplies this interface, durably claiming/reserving its private permit and validating source responses. This interface alone dispatches nothing. */
export interface StatusWatchTransport {
  mode: "synthetic_offline" | "provider";
  claim(permit: StatusWatchPermit): Promise<void>;
  creationState?(): Promise<"not_dispatched" | "attempted">;
  create(
    body: { name: string; url: string; schedule_cron: "0 0 1 1 *" },
    signal: AbortSignal,
  ): Promise<{
    monitor: OwnedStatusMonitor;
    baseline: StatusMonitorObservation;
  }>;
  findOwned(
    name: string,
    url: string,
    signal: AbortSignal,
  ): Promise<OwnedStatusMonitor[]>;
  pause(id: string, signal: AbortSignal): Promise<void>;
  get(id: string, signal: AbortSignal): Promise<OwnedStatusMonitor>;
  runPaused(id: string, signal: AbortSignal): Promise<StatusMonitorObservation>;
  halt(reason: "verification_failed" | "cleanup_unconfirmed"): Promise<void>;
}
function invalid(message: string): never {
  throw new RegistryError("MONITOR_INVALID", message);
}
/** Finite lifecycle core. Its real adapter is default-disabled and remains provider-unverified; the client cleanup model is not a provider lifetime cap. */
export async function verifyFiniteStatusWatch(
  recordInput: RegistrationRecord | FloridaLicenceData,
  permitInput: unknown,
  transport?: StatusWatchTransport,
  signal?: AbortSignal,
  clock: () => number = Date.now,
) {
  if (!transport)
    throw new RegistryError(
      "LIVE_DISABLED",
      "No charged Monitor adapter is enabled.",
    );
  if (!["synthetic_offline", "provider"].includes(transport.mode))
    invalid("The Monitor evidence mode is unsupported.");
  const isFlorida = recordInput.registry === "florida_dbpr";
  const record = isFlorida
      ? FloridaLicence.parse(recordInput)
      : VerifiedRecord.parse(recordInput),
    permit = Permit.parse(permitInput),
    now = clock();
  const issued = Date.parse(permit.authorized_at),
    expires = Date.parse(permit.expires_at),
    target = isFlorida
      ? floridaDetailUrl(record.source_url)
      : recordUrl(
          (record as RegistrationRecord).registry,
          (record as RegistrationRecord).registration_id,
        );
  const annual = Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1);
  if (
    permit.target_url !== target ||
    issued > now ||
    expires <= now ||
    expires - issued > 30 * 60000 ||
    expires <= issued ||
    annual <= expires + 86400000
  )
    invalid(
      "A current exact-record permit and a future annual schedule outside the finite window are required.",
    );
  if ((transport.mode === "provider") !== (record.evidence.kind === "provider"))
    invalid("Synthetic and provider histories cannot be combined.");
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "Watch verification cancelled before claiming.",
    );
  const name = "tinyverify-" + permit.operation_id;
  const deadline = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(Math.min(120000, expires - now)),
  ]);
  const bounded = async <T>(
    operation: () => Promise<T>,
    s: AbortSignal,
  ): Promise<T> => {
    if (s.aborted)
      throw new RegistryError(
        "CANCELLED",
        "Watch verification ended; cleanup is still required.",
      );
    let listener: () => void = () => {};
    const stop = new Promise<never>((_, reject) => {
      listener = () =>
        reject(
          new RegistryError("CANCELLED", "The finite watch window ended."),
        );
      s.addEventListener("abort", listener, { once: true });
    });
    try {
      return await Promise.race([operation(), stop]);
    } finally {
      s.removeEventListener("abort", listener);
    }
  };
  const owned = (value: unknown): OwnedStatusMonitor => {
    const parsed = Owned.parse(value);
    if (parsed.name !== name || parsed.url !== target)
      invalid("The response identifies a different monitor or target.");
    return parsed;
  };
  let monitor: OwnedStatusMonitor | undefined,
    attempted = false,
    completed = false;
  const paused = async (s: AbortSignal) => {
    if (!monitor) return false;
    const id = monitor.id;
    await bounded(() => transport.pause(id, s), s);
    const read = owned(await bounded(() => transport.get(id, s), s));
    if (read.id !== id || read.status !== "paused") return false;
    return true;
  };
  const observation = (check: StatusMonitorObservation) => {
    if (
      !monitor ||
      check.monitor_id !== monitor.id ||
      !z.uuid().safeParse(check.run_id).success
    )
      invalid("Monitor observation identity changed.");
    const result = isFlorida
      ? resolveFloridaMonitoredDetail(record, check.observation, check.evidence)
      : resolveObservation(
          {
            registry: (record as RegistrationRecord).registry,
            by: "registration_id",
            registration_id: (record as RegistrationRecord).registration_id,
          },
          check.observation,
          check.evidence,
        );
    if (
      Date.parse(result.evidence.checked_at) < issued ||
      Date.parse(result.evidence.checked_at) > expires ||
      Date.parse(result.evidence.checked_at) > clock() + 5000
    )
      invalid("The check time is outside the observed verification window.");
    if (
      transport.mode === "provider" &&
      (result.evidence.endpoint !== "monitor" ||
        result.evidence.kind !== "provider" ||
        result.evidence.provider_run_id !== check.run_id)
    )
      invalid("Monitor output needs its matching actual run receipt.");
    if (
      transport.mode === "synthetic_offline" &&
      result.evidence.kind !== "synthetic"
    )
      invalid("Injected synthetic checks cannot claim provider evidence.");
    return result;
  };
  try {
    await bounded(() => transport.claim(permit), deadline); // Durable one-use allocation must precede creation, even when creation later fails.
    if (deadline.aborted)
      throw new RegistryError(
        "CANCELLED",
        "The watch was cancelled before creation.",
      );
    attempted = true;
    const created = await bounded(
      () =>
        transport.create(
          { name, url: target, schedule_cron: "0 0 1 1 *" },
          deadline,
        ),
      deadline,
    );
    monitor = owned(created.monitor);
    if (!(await paused(deadline)))
      throw new RegistryError(
        "REMOTE_STATE_UNCERTAIN",
        "The new monitor was not confirmed paused.",
      );
    const baseline = observation(created.baseline);
    if (baseline.kind !== "verified")
      invalid("The immediate baseline did not verify this record.");
    const id = monitor.id;
    const checked = await bounded(
      () => transport.runPaused(id, deadline),
      deadline,
    );
    if (checked.run_id === created.baseline.run_id)
      invalid("A baseline cannot be replayed as a later check.");
    const latest = observation(checked),
      diff = isFlorida
        ? compareFloridaLicence(
            baseline.record,
            latest.kind === "verified"
              ? latest.record
              : invalid("Florida Monitor did not verify its later detail."),
          )
        : compareRegistration(
            baseline.record as RegistrationRecord,
            latest as VerificationResult,
          );
    completed = true;
    return {
      mode: transport.mode,
      monitor_id: monitor.id,
      baseline,
      latest,
      diff,
      comparison_origin: "client_structured_comparison" as const,
      provider_metadata: {
        baseline: created.baseline.provider_metadata ?? null,
        followup: checked.provider_metadata ?? null,
      },
      scheduled_runs_permitted: false as const,
      paused_confirmed: true as const,
    };
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(
      "MONITOR_INVALID",
      "Finite Monitor verification failed; private transport details were withheld.",
    );
  } finally {
    const cleanup = AbortSignal.timeout(10000);
    let confirmed = !attempted;
    try {
      if (attempted && !monitor) {
        if (
          transport.creationState &&
          (await bounded(() => transport.creationState!(), cleanup)) ===
            "not_dispatched"
        )
          confirmed = true;
        else {
          const matches = await bounded(
            () => transport.findOwned(name, target, cleanup),
            cleanup,
          );
          if (matches.length === 1) monitor = owned(matches[0]);
        }
      }
      if (monitor) confirmed = await paused(cleanup);
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      try {
        await bounded(
          () => transport.halt("cleanup_unconfirmed"),
          AbortSignal.timeout(10000),
        );
      } catch {
        throw new RegistryError(
          "REMOTE_STATE_UNCERTAIN",
          "The Monitor halt could not be confirmed; private state details were withheld.",
        );
      }
      throw new RegistryError(
        "REMOTE_STATE_UNCERTAIN",
        "Exact owned Monitor pause/readback was not confirmed; no repeat is permitted.",
      );
    }
    if (!completed)
      try {
        await bounded(
          () => transport.halt("verification_failed"),
          AbortSignal.timeout(10000),
        );
      } catch {
        throw new RegistryError(
          "REMOTE_STATE_UNCERTAIN",
          "The Monitor halt could not be confirmed; private state details were withheld.",
        );
      }
  }
}
