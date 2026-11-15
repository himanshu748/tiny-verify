import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  writeFile,
  mkdir,
  open,
  rename,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PrivateApiKey } from "../../shared/index.js";
import { RegistryError } from "./contracts.js";
import { floridaDetailUrl } from "./florida.js";
import { canonicalSource, REGISTRIES } from "./registries.js";
export const RUNTIME_RESERVATIONS = {
  fetch: 1000,
  agent: 384000,
  monitor_check: 6000,
} as const;
export type RuntimeOperation = keyof typeof RUNTIME_RESERVATIONS;
const path = z
  .string()
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const instant = z.string().datetime({ offset: true });
export const RuntimePermit = z
  .object({
    version: z.literal(1),
    project: z.literal("tiny-verify"),
    permit_id: z.uuid(),
    permit_file: path,
    state_directory: path,
    authorization_basis: z.literal("separate_owner_supplement_not_shared_pool"),
    previous_pools_remain_halted: z.literal(true),
    authorized_at: instant,
    expires_at: instant,
    key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fetch_tier: z.enum(["hobby", "builder"]),
    max_reserved_microusd: z.number().int().min(1000).max(2000000),
    limits: z
      .object({
        fetch: z.number().int().min(0).max(8),
        agent: z.number().int().min(0).max(2),
        monitor_check: z.number().int().min(0).max(2),
      })
      .strict(),
    agent_beta_enrollment_confirmed: z.boolean(),
    monitor_control_model: z.literal(
      "annual_outside_window_immediate_pause_client_cleanup_not_provider_cap",
    ),
    monitor_target_url: z.string().url().nullable(),
    monitor_window: z
      .object({
        operation_id: z.uuid(),
        authorized_at: instant,
        expires_at: instant,
      })
      .strict()
      .nullable(),
    allow_owned_cleanup_after_expiry: z.literal(true),
  })
  .strict();
export type RuntimePermitData = z.infer<typeof RuntimePermit>;
const Entry = z
  .object({
    id: z.uuid(),
    kind: z.enum(["fetch", "agent", "monitor_check"]),
    reserved_microusd: z.number().int().nonnegative(),
    state: z.enum(["reserved", "started", "terminal", "uncertain"]),
    reference: z.uuid().nullable(),
    outcome: z.enum(["success", "failure"]).nullable(),
    accounted_units: z.number().int().nonnegative().nullable(),
  })
  .strict();
const Claim = z
  .object({
    operation_id: z.uuid(),
    name: z.string(),
    url: z.string().url(),
    authorized_at: instant,
    expires_at: instant,
    creation_attempted: z.boolean(),
    monitor_id: z.uuid().nullable(),
    paused_confirmed: z.boolean(),
    manual_attempted: z.boolean(),
  })
  .strict();
const State = z
  .object({
    version: z.literal(1),
    permit_id: z.uuid(),
    permit_sha256: z.string(),
    halted: z.boolean(),
    halt_reason: z.enum([
      "none",
      "operation_failed",
      "remote_unknown",
      "preflight_failed",
      "verification_failed",
      "cleanup_unconfirmed",
    ]),
    reserved_microusd: z.number().int().nonnegative(),
    entries: z.array(Entry).max(12),
    claim: Claim.nullable(),
  })
  .strict();
export type RuntimeState = z.infer<typeof State>;
export type RuntimeEntry = z.infer<typeof Entry>;
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot =
  basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot;
const insidePublic = (value: string) => {
  const r = relative(publicRoot, value);
  return !r.startsWith("..") && !isAbsolute(r);
};
async function durableCreate(file: string, text: string) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function fail(
  code: ConstructorParameters<typeof RegistryError>[0],
  message: string,
): never {
  throw new RegistryError(code, message);
}
export async function privateDirectory(value: string): Promise<void> {
  if (!isAbsolute(value) || resolve(value) !== value || insidePublic(value))
    fail(
      "AUTHORIZATION_REQUIRED",
      "Use an absolute private directory outside the public workspace.",
    );
  try {
    const s = await lstat(value);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.mode & 0o077) !== 0 ||
      s.uid !== process.getuid?.() ||
      (await realpath(value)) !== value
    )
      throw Error();
  } catch {
    fail(
      "AUTHORIZATION_REQUIRED",
      "The private directory must exist, be owner-only and contain no redirected path.",
    );
  }
}
export async function privateText(
  value: string,
  maximum = 20000,
): Promise<string> {
  if (!isAbsolute(value) || resolve(value) !== value || insidePublic(value))
    fail(
      "AUTHORIZATION_REQUIRED",
      "Use an absolute private file outside the public workspace.",
    );
  try {
    const s = await lstat(value);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      (s.mode & 0o077) !== 0 ||
      s.uid !== process.getuid?.() ||
      s.size > maximum ||
      (await realpath(value)) !== value
    )
      throw Error();
    return await readFile(value, "utf8");
  } catch {
    fail(
      "AUTHORIZATION_REQUIRED",
      "The private file is missing, redirected, oversized or not owner-only.",
    );
  }
}
export function validateRuntimePermit(
  input: unknown,
  clock: () => number = Date.now,
  allowExpiredForCleanup = false,
): RuntimePermitData {
  const result = RuntimePermit.safeParse(input);
  if (!result.success)
    fail(
      "AUTHORIZATION_REQUIRED",
      "The separate TinyVerify permit is invalid.",
    );
  const p = result.data,
    start = Date.parse(p.authorized_at),
    end = Date.parse(p.expires_at),
    now = clock();
  if (
    start > now + 5000 ||
    (end <= now && !allowExpiredForCleanup) ||
    end <= start ||
    end - start > 24 * 3600000 ||
    dirname(p.state_directory) !== dirname(p.permit_file) ||
    insidePublic(p.permit_file) ||
    insidePublic(p.state_directory)
  )
    fail(
      "AUTHORIZATION_REQUIRED",
      "The private permit window or bound state path is invalid.",
    );
  const cost = Object.entries(p.limits).reduce(
    (sum, [kind, count]) =>
      sum + count * RUNTIME_RESERVATIONS[kind as RuntimeOperation],
    0,
  );
  if (
    cost > p.max_reserved_microusd ||
    (p.limits.agent && !p.agent_beta_enrollment_confirmed) ||
    (p.limits.monitor_check !== 0 && p.limits.monitor_check !== 2)
  )
    fail(
      "AUTHORIZATION_REQUIRED",
      "The permit does not cover its conservative operation limits.",
    );
  if (p.limits.monitor_check) {
    if (!p.monitor_target_url || !p.monitor_window)
      fail(
        "AUTHORIZATION_REQUIRED",
        "Monitor needs one exact public record target.",
      );
    const windowStart = Date.parse(p.monitor_window.authorized_at),
      windowEnd = Date.parse(p.monitor_window.expires_at),
      annual = Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1);
    if (
      windowStart < start ||
      windowEnd > end ||
      windowEnd <= windowStart ||
      windowEnd - windowStart > 30 * 60000 ||
      annual <= windowEnd + 86400000
    )
      fail(
        "AUTHORIZATION_REQUIRED",
        "The exact Monitor window must be finite and outside the next annual schedule.",
      );
    let allowed = false;
    for (const registry of Object.keys(REGISTRIES) as Array<
      keyof typeof REGISTRIES
    >) {
      try {
        const u = new URL(p.monitor_target_url);
        allowed ||=
          canonicalSource(registry, p.monitor_target_url) ===
            p.monitor_target_url &&
          (registry === "uk_companies_house"
            ? /^\/company\/[A-Z0-9]{8}$/
            : /^\/ABN\/View\/\d{11}$/
          ).test(u.pathname);
      } catch {}
    }
    try {
      allowed ||=
        floridaDetailUrl(p.monitor_target_url) === p.monitor_target_url;
    } catch {}
    if (!allowed)
      fail(
        "AUTHORIZATION_REQUIRED",
        "The Monitor target is outside an exact supported official record.",
      );
  } else if (p.monitor_target_url !== null || p.monitor_window !== null)
    fail(
      "AUTHORIZATION_REQUIRED",
      "A permit without Monitor capacity cannot authorize a target or window.",
    );
  return p;
}
/** Separate owner supplement ledger. It neither opens nor changes the halted shared pool. */
export class RuntimeLedger {
  readonly permit: RuntimePermitData;
  readonly fingerprint: string;
  constructor(
    permit: RuntimePermitData,
    private readonly clock: () => number = Date.now,
  ) {
    this.permit = structuredClone(permit);
    Object.freeze(this.permit.limits);
    Object.freeze(this.permit);
    this.fingerprint = digest(JSON.stringify(this.permit));
  }
  private get stateFile() {
    return join(this.permit.state_directory, "ledger.json");
  }
  private get bindingFile() {
    return join(
      dirname(this.permit.permit_file),
      `.tinyverify-${this.permit.permit_id}.binding.json`,
    );
  }
  async initialize(): Promise<void> {
    validateRuntimePermit(this.permit, this.clock);
    await privateDirectory(dirname(this.permit.permit_file));
    const binding = {
      permit_sha256: this.fingerprint,
      state_directory: this.permit.state_directory,
    };
    try {
      await durableCreate(this.bindingFile, JSON.stringify(binding));
      await mkdir(this.permit.state_directory, { mode: 0o700 });
      await durableCreate(
        this.stateFile,
        JSON.stringify({
          version: 1,
          permit_id: this.permit.permit_id,
          permit_sha256: this.fingerprint,
          halted: false,
          halt_reason: "none",
          reserved_microusd: 0,
          entries: [],
          claim: null,
        }),
      );
    } catch {
      fail(
        "STATE_FAILURE",
        "Initialization was not completed; an existing binding or state must never be reset.",
      );
    }
  }
  async read(): Promise<RuntimeState> {
    await privateDirectory(this.permit.state_directory);
    let raw: unknown, binding: unknown;
    try {
      raw = JSON.parse(await privateText(this.stateFile, 100000));
      binding = JSON.parse(await privateText(this.bindingFile));
    } catch {
      fail(
        "STATE_FAILURE",
        "The bound allowance state could not be read safely.",
      );
    }
    const parsed = State.safeParse(raw);
    if (
      !parsed.success ||
      JSON.stringify(binding) !==
        JSON.stringify({
          permit_sha256: this.fingerprint,
          state_directory: this.permit.state_directory,
        })
    )
      fail("STATE_FAILURE", "The allowance state or permit binding changed.");
    const s = parsed.data;
    if (
      (s.halted && s.halt_reason === "none") ||
      (!s.halted && s.halt_reason !== "none")
    )
      fail("STATE_FAILURE", "The halt flag and reason disagree.");
    if (
      s.permit_id !== this.permit.permit_id ||
      s.permit_sha256 !== this.fingerprint ||
      new Set(s.entries.map((e) => e.id)).size !== s.entries.length ||
      s.reserved_microusd !==
        s.entries.reduce((n, e) => n + e.reserved_microusd, 0) ||
      s.reserved_microusd > this.permit.max_reserved_microusd
    )
      fail(
        "STATE_FAILURE",
        "The durable allowance accounting disagrees with this permit.",
      );
    for (const kind of Object.keys(
      RUNTIME_RESERVATIONS,
    ) as RuntimeOperation[]) {
      if (
        s.entries.filter((e) => e.kind === kind).length >
          this.permit.limits[kind] ||
        s.entries.some(
          (e) =>
            e.kind === kind &&
            e.reserved_microusd !== RUNTIME_RESERVATIONS[kind],
        )
      )
        fail("STATE_FAILURE", "An operation exceeded its original bound.");
    }
    if (
      s.entries.some(
        (e) => e.state === "uncertain" || e.outcome === "failure",
      ) &&
      !s.halted
    )
      fail(
        "STATE_FAILURE",
        "Uncertain remote work cannot leave dispatch enabled.",
      );
    const references = s.entries.flatMap((e) =>
      e.reference ? [e.reference] : [],
    );
    if (new Set(references).size !== references.length)
      fail("STATE_FAILURE", "A provider run reference was reused.");
    if (
      s.entries.some((e) =>
        e.state === "terminal"
          ? e.outcome === null ||
            e.accounted_units === null ||
            e.accounted_units > (e.kind === "agent" ? 24 : 1)
          : e.outcome !== null || e.accounted_units !== null,
      )
    )
      fail("STATE_FAILURE", "Operation outcome and lifecycle state disagree.");
    if (
      s.claim &&
      ((s.claim.monitor_id && !s.claim.creation_attempted) ||
        (s.claim.paused_confirmed && !s.claim.monitor_id) ||
        (s.claim.manual_attempted &&
          (!s.claim.monitor_id || !s.claim.creation_attempted)))
    )
      fail("STATE_FAILURE", "Monitor ownership and lifecycle flags disagree.");
    if (
      s.claim &&
      (s.claim.name !== `tinyverify-${s.claim.operation_id}` ||
        s.claim.url !== this.permit.monitor_target_url)
    )
      fail("STATE_FAILURE", "The owned Monitor claim changed identity.");
    return s;
  }
  private async mutate<T>(fn: (state: RuntimeState) => T): Promise<T> {
    await privateDirectory(this.permit.state_directory);
    let lock;
    try {
      lock = await open(
        join(this.permit.state_directory, ".lock"),
        "wx",
        0o600,
      );
    } catch {
      fail(
        "BUSY",
        "The allowance is already in use or requires lock reconciliation.",
      );
    }
    try {
      const s = await this.read(),
        result = fn(s),
        temp = join(this.permit.state_directory, `.write-${randomUUID()}`);
      await durableCreate(temp, JSON.stringify(s));
      await rename(temp, this.stateFile);
      const directory = await open(this.permit.state_directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return result;
    } finally {
      await lock.close();
      await unlink(join(this.permit.state_directory, ".lock"));
    }
  }
  async eligible(kind: RuntimeOperation) {
    validateRuntimePermit(this.permit, this.clock);
    const s = await this.read();
    if (s.halted)
      fail(
        "BUDGET_HALTED",
        "This separate allowance is halted; no repeat is authorized.",
      );
    if (s.entries.some((e) => e.state !== "terminal"))
      fail(
        "BUDGET_HALTED",
        "An earlier operation requires reconciliation before more content work.",
      );
    if (
      s.claim?.creation_attempted &&
      !s.claim.paused_confirmed &&
      s.entries.some((e) => e.kind === "monitor_check")
    )
      fail(
        "BUDGET_HALTED",
        "Owned Monitor pause must be confirmed before any later content operation.",
      );
    if (
      s.entries.filter((e) => e.kind === kind).length >=
        this.permit.limits[kind] ||
      s.reserved_microusd + RUNTIME_RESERVATIONS[kind] >
        this.permit.max_reserved_microusd
    )
      fail(
        "BUDGET_EXHAUSTED",
        "The separate operation or reservation allowance is exhausted.",
      );
  }
  async reserve(kind: RuntimeOperation): Promise<RuntimeEntry> {
    await this.eligible(kind);
    return this.mutate((s) => {
      if (
        s.halted ||
        (s.claim?.creation_attempted &&
          !s.claim.paused_confirmed &&
          s.entries.some((e) => e.kind === "monitor_check")) ||
        s.entries.some((e) => e.state !== "terminal") ||
        s.entries.filter((e) => e.kind === kind).length >=
          this.permit.limits[kind] ||
        s.reserved_microusd + RUNTIME_RESERVATIONS[kind] >
          this.permit.max_reserved_microusd
      )
        fail("BUDGET_HALTED", "Concurrent or exhausted dispatch is blocked.");
      const e: RuntimeEntry = {
        id: randomUUID(),
        kind,
        reserved_microusd: RUNTIME_RESERVATIONS[kind],
        state: "reserved",
        reference: null,
        outcome: null,
        accounted_units: null,
      };
      s.entries.push(e);
      s.reserved_microusd += e.reserved_microusd;
      return structuredClone(e);
    });
  }
  async started(id: string, reference: string) {
    if (!z.uuid().safeParse(reference).success)
      fail(
        "STATE_FAILURE",
        "Use a real provider UUID, not a connection or credential.",
      );
    await this.mutate((s) => {
      const e = s.entries.find((e) => e.id === id);
      if (
        !e ||
        e.state !== "reserved" ||
        s.entries.some(
          (other) => other.id !== id && other.reference === reference,
        )
      )
        fail("STATE_FAILURE", "The operation association changed.");
      e.reference = reference;
      e.state = "started";
    });
  }
  async finish(id: string, outcome: "success" | "failure", units: number) {
    await this.mutate((s) => {
      const e = s.entries.find((e) => e.id === id);
      if (
        !e ||
        e.state === "terminal" ||
        !Number.isInteger(units) ||
        units < 0 ||
        units > (e.kind === "agent" ? 24 : 1)
      )
        fail(
          "STATE_FAILURE",
          "Terminal accounting exceeded the conservative bound.",
        );
      e.state = "terminal";
      e.outcome = outcome;
      e.accounted_units = units;
      if (outcome === "failure") {
        s.halted = true;
        s.halt_reason = "operation_failed";
      }
    });
  }
  async uncertain(id: string) {
    await this.mutate((s) => {
      const e = s.entries.find((e) => e.id === id);
      if (!e || e.state === "terminal")
        fail("STATE_FAILURE", "Unknown or already terminal reservation.");
      e.state = "uncertain";
      s.halted = true;
      s.halt_reason = "remote_unknown";
    });
  }
  async halt(reason: Exclude<RuntimeState["halt_reason"], "none">) {
    await this.mutate((s) => {
      s.halted = true;
      s.halt_reason = reason;
    });
  }
  async claimMonitor(value: {
    operation_id: string;
    name: string;
    url: string;
    authorized_at: string;
    expires_at: string;
  }) {
    validateRuntimePermit(this.permit, this.clock);
    const start = Date.parse(value.authorized_at),
      end = Date.parse(value.expires_at),
      annual = Date.UTC(new Date(this.clock()).getUTCFullYear() + 1, 0, 1);
    if (
      !z.uuid().safeParse(value.operation_id).success ||
      start > this.clock() ||
      end <= this.clock() ||
      end <= start ||
      end - start > 30 * 60000 ||
      annual <= end + 86400000
    )
      fail(
        "AUTHORIZATION_REQUIRED",
        "The finite Monitor claim window is invalid.",
      );
    await this.mutate((s) => {
      if (
        s.halted ||
        s.claim ||
        value.operation_id !== this.permit.monitor_window?.operation_id ||
        value.authorized_at !== this.permit.monitor_window?.authorized_at ||
        value.expires_at !== this.permit.monitor_window?.expires_at ||
        value.url !== this.permit.monitor_target_url ||
        value.name !== `tinyverify-${value.operation_id}` ||
        Date.parse(value.authorized_at) <
          Date.parse(this.permit.authorized_at) ||
        Date.parse(value.expires_at) > Date.parse(this.permit.expires_at)
      )
        fail(
          "AUTHORIZATION_REQUIRED",
          "The exact finite Monitor permit is not available.",
        );
      s.claim = {
        ...value,
        creation_attempted: false,
        monitor_id: null,
        paused_confirmed: false,
        manual_attempted: false,
      };
    });
  }
  async updateClaim(
    update: Partial<
      Pick<
        z.infer<typeof Claim>,
        | "creation_attempted"
        | "monitor_id"
        | "paused_confirmed"
        | "manual_attempted"
      >
    >,
  ) {
    await this.mutate((s) => {
      if (!s.claim)
        fail("STATE_FAILURE", "No exact owned Monitor claim exists.");
      const next = Claim.safeParse({ ...s.claim, ...update });
      if (
        !next.success ||
        (next.data.monitor_id && !next.data.creation_attempted) ||
        (next.data.paused_confirmed && !next.data.monitor_id)
      )
        fail(
          "STATE_FAILURE",
          "The Monitor update lacks coherent exact ownership.",
        );
      if (
        (s.claim.creation_attempted && update.creation_attempted === false) ||
        (s.claim.manual_attempted && update.manual_attempted === false) ||
        (s.claim.monitor_id && update.monitor_id === null)
      )
        fail("STATE_FAILURE", "One-use Monitor state cannot be reset.");
      if (
        update.monitor_id &&
        s.claim.monitor_id &&
        update.monitor_id !== s.claim.monitor_id
      )
        fail("STATE_FAILURE", "Cannot replace an owned Monitor identity.");
      Object.assign(s.claim, update);
    });
  }
}
/** Disabled before any path, input, key or ledger read. Initialization is an explicit operator command. */
export async function loadRuntimeControls(
  env: NodeJS.ProcessEnv = process.env,
  clock: () => number = Date.now,
  options: { allowExpiredForCleanup?: boolean } = {},
) {
  if (env.TINYVERIFY_LIVE !== "1") return undefined;
  if (!env.TINYVERIFY_PERMIT_FILE || !env.TINYFISH_KEY_FILE)
    fail(
      "AUTHORIZATION_REQUIRED",
      "TINYVERIFY_PERMIT_FILE and TINYFISH_KEY_FILE must reference existing private files.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(await privateText(env.TINYVERIFY_PERMIT_FILE));
  } catch {
    fail(
      "AUTHORIZATION_REQUIRED",
      "The private TinyVerify permit could not be validated.",
    );
  }
  const permit = validateRuntimePermit(
    raw,
    clock,
    options.allowExpiredForCleanup === true,
  );
  if (permit.permit_file !== env.TINYVERIFY_PERMIT_FILE)
    fail(
      "AUTHORIZATION_REQUIRED",
      "The permit is bound to a different private file.",
    );
  await privateDirectory(dirname(permit.permit_file));
  const text = await privateText(env.TINYFISH_KEY_FILE),
    lines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("TINYFISH_API_KEY=")),
    key = lines[0]?.slice("TINYFISH_API_KEY=".length).trim();
  if (
    lines.length !== 1 ||
    !key ||
    !/^[\x21-\x7e]{16,512}$/.test(key) ||
    /^["']|["']$/.test(key) ||
    digest(key) !== permit.key_sha256
  )
    fail(
      "AUTHORIZATION_REQUIRED",
      "The referenced key does not match this separate permit.",
    );
  return {
    ledger: new RuntimeLedger(permit, clock),
    key: new PrivateApiKey(key),
  };
}
