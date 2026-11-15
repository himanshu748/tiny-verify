import type { RegistryProvider } from "./provider.js";
import { DisabledRegistryProvider } from "./provider.js";
import { RegistryError } from "./contracts.js";
import { parseLookup } from "./registries.js";
import { resolveObservation } from "./parser.js";

/** One lookup only. A name candidate requires explicit selection and a separate ID lookup. */
export async function lookupRegistration(
  input: unknown,
  provider: RegistryProvider = new DisabledRegistryProvider(),
  signal?: AbortSignal,
) {
  const lookup = parseLookup(input);
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "The lookup was cancelled before provider work.",
    );
  const result = await provider.observe(lookup, signal);
  if (signal?.aborted)
    throw new RegistryError(
      "CANCELLED",
      "The lookup was cancelled; its observation was not accepted.",
    );
  return resolveObservation(lookup, result.observation, result.evidence);
}
