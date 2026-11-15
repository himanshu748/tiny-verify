import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(resolve(root, "tiny-verify/test")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => "tiny-verify/test/" + name);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/offline-guard.mjs",
    "--import",
    "tsx",
    "--test",
    ...tests,
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      BOUNTY_POOL_LIVE: "0",
      TINYVERIFY_LIVE: "0",
      ...(process.env.TINYVERIFY_NETWORK_LOG
        ? { TINYVERIFY_NETWORK_LOG: process.env.TINYVERIFY_NETWORK_LOG }
        : {}),
    },
    stdio: "inherit",
    timeout: 180000,
  },
);
process.exitCode = result.status ?? 1;
