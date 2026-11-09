// Managers config (version 2): the people who take part in the distribution.
// A manager is identified by email. The full name is display-only: it drifts between
// exports (word order, login instead of a name), the email does not.

import {
  cmpStr,
  isNoneEmptyOrZero,
  isNoneOrEmpty,
  normEmail,
  normName,
  pyBool,
  pyInt,
} from "./pystr.ts";

export interface ManagerEntry {
  email: string;
  name: string;
  is_support: boolean;
  has_cap: boolean;
  cap: number | null;
}

export interface ManagersConfig {
  version: 2;
  managers: ManagerEntry[];
}

/** A config entry as it may arrive from a file: legacy entries have no email, fields can be missing. */
export type ManagerInput = Partial<Record<keyof ManagerEntry, unknown>>;

export interface ManagersConfigInput {
  version?: number;
  managers: ManagerInput[];
}

export function defaultConfig(): ManagersConfig {
  return { version: 2, managers: [] };
}

/** Config entry key: email, or name for legacy entries without email. */
export function managerKey(item: ManagerInput): string {
  return normEmail(item.email) || normName(item.name).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cleans up config entries: trims and lowercases emails, drops duplicates and
 * entries with neither email nor name, coerces `cap`.
 * With `strictCap` an unparsable cap throws (used on save); otherwise it is dropped.
 */
export function normalizeManagers(items: unknown, strictCap: boolean): ManagerEntry[] {
  const normalized: ManagerEntry[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item)) continue;

    const email = normEmail(item.email);
    const name = normName(item.name);
    const key = email || name.toLowerCase();
    if (!key || seen.has(key)) continue;

    const hasCapRaw = "has_cap" in item ? item.has_cap : !isNoneEmptyOrZero(item.cap);
    const hasCap = pyBool(hasCapRaw);
    let cap: number | null = null;
    if (hasCap && !isNoneOrEmpty(item.cap)) {
      try {
        cap = pyInt(item.cap);
      } catch (error) {
        if (strictCap) throw error;
        cap = null;
      }
    }

    normalized.push({
      email,
      name: name || email,
      is_support: pyBool(item.is_support ?? false),
      has_cap: cap !== null,
      cap,
    });
    seen.add(key);
  }

  return normalized;
}

/** Parses the text of a managers.json file. Legacy (version 1, no emails) files are accepted. */
export function parseManagersConfig(text: string): ManagersConfig {
  const raw: unknown = JSON.parse(text);
  const items = isRecord(raw) ? raw.managers : [];
  return { version: 2, managers: normalizeManagers(items ?? [], false) };
}

/** Serialises a config the way the Python version wrote it (strict cap, 2-space indent). */
export function serializeManagersConfig(data: ManagersConfigInput): string {
  const out: ManagersConfig = { version: 2, managers: normalizeManagers(data.managers, true) };
  return JSON.stringify(out, null, 2);
}

/** (email, full name) pairs from an export, one per email, ordered by email. */
export function sortPairs(pairs: Map<string, string>): [string, string][] {
  return [...pairs.entries()].sort((a, b) => cmpStr(a[0], b[0]));
}

/**
 * Adds managers from the export to the config (new ones are not support).
 *
 * Legacy entries without email get one when their name exactly matches a full name
 * in the export. Everything else is up to the person running the distribution, in the UI.
 */
export function ensureManagersPresent(
  config: ManagersConfigInput,
  managers: readonly (readonly [string, string])[],
): ManagersConfig {
  const entries: ManagerInput[] = (config.managers ?? []).map((x) => ({ ...x }));

  const byEmail = new Map<string, ManagerInput>();
  const legacyByName = new Map<string, ManagerInput>();
  for (const entry of entries) {
    const email = normEmail(entry.email);
    if (email) byEmail.set(email, entry);
    else legacyByName.set(normName(entry.name).toLowerCase(), entry);
  }

  for (const [rawEmail, rawName] of managers) {
    const email = normEmail(rawEmail);
    const name = normName(rawName);
    if (!email || byEmail.has(email)) continue;

    const legacyKey = name.toLowerCase();
    const legacy = name ? legacyByName.get(legacyKey) : undefined;
    if (legacy !== undefined) {
      legacyByName.delete(legacyKey);
      legacy.email = email;
      byEmail.set(email, legacy);
      continue;
    }

    const entry: ManagerInput = {
      email,
      name: name || email,
      is_support: false,
      has_cap: false,
      cap: null,
    };
    entries.push(entry);
    byEmail.set(email, entry);
  }

  entries.sort((a, b) => cmpStr(String(a.name ?? "").toLowerCase(), String(b.name ?? "").toLowerCase()));
  return { version: 2, managers: entries as unknown as ManagerEntry[] };
}

/** Emails of support managers. An entry without email cannot take part. */
export function getSupportManagers(config: ManagersConfigInput): string[] {
  return config.managers
    .filter((x) => pyBool(x.is_support) && normEmail(x.email))
    .map((x) => normEmail(x.email));
}

/** Names of support entries that have no email (they are skipped by the distribution). */
export function getSupportWithoutEmail(config: ManagersConfigInput): string[] {
  return config.managers
    .filter((x) => pyBool(x.is_support) && !normEmail(x.email))
    .map((x) => normName(x.name));
}

/** Email → cap (null when the manager has none). */
export function getCapMap(config: ManagersConfigInput): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const item of config.managers) {
    const email = normEmail(item.email);
    if (!email) continue;
    if (pyBool(item.has_cap) && !isNoneOrEmpty(item.cap)) out.set(email, pyInt(item.cap));
    else out.set(email, null);
  }
  return out;
}

/** Email → display name: from the export, overridden by the config. */
export function getNameMap(
  config: ManagersConfigInput,
  pairs: readonly (readonly [string, string])[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [email, name] of pairs) out.set(email, name || email);
  for (const item of config.managers) {
    const email = normEmail(item.email);
    if (email && normName(item.name)) out.set(email, normName(item.name));
  }
  return out;
}
