// Helpers that reproduce the Python semantics the reference implementation relies on.
//
// The distribution has to match the Python version row by row, and several tie-breakers
// there are string comparisons and conversions. JS differs from Python in small ways
// (strip() character set, UTF-16 vs code point ordering, int()/float() parsing), so the
// places where it could change an assignment are ported explicitly instead of approximated.

/** A value as it comes out of a spreadsheet cell or a parsed JSON file. */
export type Cell = string | number | boolean | Date | null;

// Code points for which Python's str.isspace() is true, i.e. what str.strip() removes:
// \t \n \v \f \r, the separators 0x1c..0x1f, space, NEL, NBSP, and the Unicode space separators.
const PY_WHITESPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python `str.strip()`. */
export function pyStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PY_WHITESPACE.has(value.charCodeAt(start))) start += 1;
  while (end > start && PY_WHITESPACE.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** Python `str.lower()` (both languages apply the full Unicode lowercase mapping). */
export function pyLower(value: string): string {
  return value.toLowerCase();
}

/**
 * Three-way string comparison by Unicode code point, as Python compares `str`.
 * JS `<` compares UTF-16 code units, which orders astral characters before U+E000..U+FFFF.
 */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca >= 0xd800 && cb >= 0xd800) {
      // Surrogates (astral code points) must sort after U+E000..U+FFFF.
      ca = ca >= 0xe000 ? ca - 0x800 : ca + 0x2000;
      cb = cb >= 0xe000 ? cb - 0x800 : cb + 0x2000;
    }
    return ca - cb;
  }
  return a.length - b.length;
}

/** pandas `isna` for a cell: missing values and NaN. */
export function isNa(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value)) ||
    (value instanceof Date && Number.isNaN(value.getTime()))
  );
}

/** Python `str(value)` for the cell types a spreadsheet can produce. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value instanceof Date) {
    return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  }
  return String(value);
}

/** The reference's `_norm_email`: missing → "", otherwise stripped and lowercased. */
export function normEmail(value: unknown): string {
  return isNa(value) ? "" : pyLower(pyStrip(pyStr(value)));
}

/** The reference's `_norm_name`: missing → "", otherwise stripped. */
export function normName(value: unknown): string {
  return isNa(value) ? "" : pyStrip(pyStr(value));
}

// Python float()/int() accept digits grouped with single underscores.
const PY_FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const PY_INT_RE = /^[+-]?\d+(?:_\d+)*$/;

/** The reference's `parse_tariff`: `int(float(v))`, anything unparsable → null. */
export function parseTariff(value: unknown): number | null {
  if (isNa(value)) return null;
  let f: number;
  if (typeof value === "number") {
    f = value;
  } else if (typeof value === "boolean") {
    f = value ? 1 : 0;
  } else if (typeof value === "string") {
    const text = pyStrip(value);
    if (!PY_FLOAT_RE.test(text)) return null;
    f = Number(text.replaceAll("_", ""));
  } else {
    return null;
  }
  if (!Number.isFinite(f)) return null;
  return Math.trunc(f);
}

/** Python `int(value)`; throws where Python raises. */
export function pyInt(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot convert ${value} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (!PY_INT_RE.test(text)) throw new Error(`invalid literal for int(): '${value}'`);
    return Number(text.replaceAll("_", ""));
  }
  throw new Error(`int() argument must be a string or a number, not '${typeof value}'`);
}

/** Python truthiness for JSON-ish values. */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** `value in (None, "")` */
export function isNoneOrEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** `value in (None, "", 0)` — Python equality, so `False` and `0.0` count as 0 too. */
export function isNoneEmptyOrZero(value: unknown): boolean {
  return isNoneOrEmpty(value) || value === 0 || value === false;
}

/** `cap not in (None, 0)` on an already-normalised cap. */
export function hasEffectiveCap(cap: number | null | undefined): cap is number {
  return cap !== null && cap !== undefined && cap !== 0;
}
