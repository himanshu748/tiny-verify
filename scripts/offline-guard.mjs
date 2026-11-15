import { appendFileSync } from "node:fs";

// Only injected HTTP is allowed in the offline test and verification commands.
globalThis.fetch = () => {
  if (process.env.TINYVERIFY_NETWORK_LOG)
    appendFileSync(process.env.TINYVERIFY_NETWORK_LOG, "BLOCKED_FETCH\n");
  throw Error("OFFLINE_VERIFICATION_BLOCKED_EXTERNAL_FETCH");
};
