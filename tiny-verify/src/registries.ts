import {
  LookupInput,
  RegistryError,
  type Lookup,
  type RegistryId,
} from "./contracts.js";

export const REGISTRIES = {
  uk_companies_house: {
    origin: "https://find-and-update.company-information.service.gov.uk",
    label: "UK Companies House",
    basis: "uk_company_register",
  },
  au_abn_lookup: {
    origin: "https://abr.business.gov.au",
    label: "Australian ABN Lookup",
    basis: "australian_abn_register",
  },
} as const;

export function registrationId(registry: RegistryId, input: string): string {
  const id = input.trim().toUpperCase();
  if (registry === "uk_companies_house") {
    if (!/^(?=.*\d)[A-Z0-9]{8}$/.test(id))
      throw new RegistryError(
        "INVALID_INPUT",
        "Use the complete eight-character Companies House number.",
      );
    return id;
  }
  const digits = id.replaceAll(" ", "");
  if (!/^\d{11}$/.test(digits))
    throw new RegistryError("INVALID_INPUT", "Use an eleven-digit ABN.");
  const values = [...digits].map(Number);
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = values.reduce(
    (total, value, index) =>
      total + (value - (index === 0 ? 1 : 0)) * weights[index]!,
    0,
  );
  if (sum % 89 !== 0)
    throw new RegistryError(
      "INVALID_INPUT",
      "The ABN check digits do not match.",
    );
  return digits;
}

export function parseLookup(input: unknown): Lookup {
  const parsed = LookupInput.safeParse(input);
  if (!parsed.success)
    throw new RegistryError(
      "INVALID_INPUT",
      "Use a supported registry and name or registration ID.",
    );
  if (parsed.data.by === "registration_id")
    return {
      ...parsed.data,
      registration_id: registrationId(
        parsed.data.registry,
        parsed.data.registration_id,
      ),
    };
  if (!/^[\p{L}\p{N} .,&'’()\-+]+$/u.test(parsed.data.name))
    throw new RegistryError(
      "INVALID_INPUT",
      "Use a plain business name, not a URL or instruction.",
    );
  return parsed.data;
}

export function recordUrl(registry: RegistryId, value: string): string {
  const id = registrationId(registry, value);
  return (
    REGISTRIES[registry].origin +
    (registry === "uk_companies_house" ? "/company/" : "/ABN/View/") +
    id
  );
}

export function searchUrl(registry: RegistryId, name: string): string {
  const query = parseLookup({ registry, by: "name", name });
  if (query.by !== "name")
    throw new RegistryError("INVALID_INPUT", "A business name is required.");
  const url = new URL(
    registry === "uk_companies_house"
      ? "/search/companies"
      : "/Search/ResultsAll",
    REGISTRIES[registry].origin,
  );
  url.searchParams.set(
    registry === "uk_companies_house" ? "q" : "SearchText",
    query.name,
  );
  return url.href;
}

export function canonicalSource(registry: RegistryId, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RegistryError(
      "SITE_CHANGED",
      "The observed source URL is invalid.",
    );
  }
  if (
    url.origin !== REGISTRIES[registry].origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.includes("%")
  )
    throw new RegistryError(
      "SITE_CHANGED",
      "The observed source left the supported official registry scope.",
    );
  if (registry === "uk_companies_house") {
    const id = /^\/company\/([A-Z0-9]{8})$/.exec(url.pathname)?.[1];
    if (id && !url.search) return recordUrl(registry, id);
    if (
      ["/search", "/search/companies"].includes(url.pathname) &&
      [...url.searchParams.keys()].every((k) => k === "q") &&
      url.searchParams.getAll("q").length === 1
    ) {
      const result = new URL(searchUrl(registry, url.searchParams.get("q")!));
      result.pathname = url.pathname;
      return result.href;
    }
  } else {
    const id = /^\/ABN\/View\/(\d{11})$/.exec(url.pathname)?.[1];
    if (id && !url.search) return recordUrl(registry, id);
    if (
      ["/Search/ResultsAll", "/Search/ResultsActive"].includes(url.pathname) &&
      [...url.searchParams.keys()].every((k) => k === "SearchText") &&
      url.searchParams.getAll("SearchText").length === 1
    ) {
      const canonical = new URL(
        searchUrl(registry, url.searchParams.get("SearchText")!),
      );
      canonical.pathname = url.pathname;
      return canonical.href;
    }
  }
  throw new RegistryError(
    "SITE_CHANGED",
    "The observed path or query is outside the supported registry contract.",
  );
}

export function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleUpperCase("en-GB")
    .replace(/[.,'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
