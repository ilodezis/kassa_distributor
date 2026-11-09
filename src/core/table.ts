// Tabular data as it comes out of the first sheet of an export, and its validation.

import { sortPairs } from "./config.ts";
import {
  COL_FROZEN,
  COL_INN,
  COL_MANAGER,
  COL_MANAGER_NAME,
  COL_PAID,
  COL_STATUS,
  COL_TARIFF,
  COL_TERMINATION,
  FROZEN_TERMINATED,
  KNOWN_STATUSES,
  STATUS_PAID,
  isTariff,
} from "./constants.ts";
import { type Cell, isNa, normEmail, normName, parseTariff, pyLower, pyStr } from "./pystr.ts";

export interface Table {
  columns: string[];
  rows: Cell[][];
}

/** An export row after validation. */
export interface PreparedRow {
  /** Current manager's email, normalised. */
  manager: string;
  /** Current manager's full name, trimmed. */
  managerName: string;
  tariff: number | null;
  paid: 0 | 1;
  /** Why the row is frozen ("" when it takes part in the distribution). */
  frozen: string;
  /** The row's cells with the manager columns and the tariff normalised. */
  cells: Cell[];
}

export interface PreparedTable {
  columns: string[];
  rows: PreparedRow[];
}

/**
 * Column titles the way pandas names them: empty titles become "Unnamed: <n>",
 * repeated titles get ".1", ".2" suffixes.
 */
export function mangleHeader(header: readonly Cell[]): string[] {
  const seen = new Map<string, number>();
  return header.map((cell, index) => {
    const base = isNa(cell) ? `Unnamed: ${index}` : pyStr(cell);
    const count = seen.get(base);
    if (count === undefined) {
      seen.set(base, 0);
      return base;
    }
    let candidate = `${base}.${count + 1}`;
    let next = count + 1;
    while (seen.has(candidate)) {
      next += 1;
      candidate = `${base}.${next}`;
    }
    seen.set(base, next);
    seen.set(candidate, 0);
    return candidate;
  });
}

/** Rows of a sheet (header first) → Table. The ИНН column is converted to text. */
export function tableFromSheet(sheet: readonly (readonly Cell[])[]): Table {
  if (sheet.length === 0) return { columns: [], rows: [] };
  const columns = mangleHeader(sheet[0]!);
  const width = columns.length;
  const innIndex = columns.indexOf(COL_INN);

  const rows = sheet.slice(1).map((raw) => {
    const row: Cell[] = [];
    for (let i = 0; i < width; i++) {
      const value = raw[i] ?? null;
      // pandas reads the INN as text so that a leading zero survives (dtype=str).
      row.push(i === innIndex && !isNa(value) ? pyStr(value) : value);
    }
    return row;
  });
  return { columns, rows };
}

/** (email, full name) pairs from the manager columns: one per email, ordered by email. */
export function managersFromColumns(
  emails: Iterable<unknown>,
  names: Iterable<unknown> | null,
): [string, string][] {
  const pairs = new Map<string, string>();
  const nameIter = names === null ? null : names[Symbol.iterator]();
  for (const rawEmail of emails) {
    const rawName = nameIter === null ? "" : nameIter.next().value;
    const email = normEmail(rawEmail);
    if (email && !pairs.has(email)) pairs.set(email, normName(rawName));
  }
  return sortPairs(pairs);
}

/** (email, full name) pairs from an export (raw or prepared), one per email. */
export function managersFromTable(table: Table): [string, string][] {
  const emailIndex = table.columns.indexOf(COL_MANAGER);
  if (emailIndex < 0) return [];
  const nameIndex = table.columns.indexOf(COL_MANAGER_NAME);
  return managersFromColumns(
    table.rows.map((row) => row[emailIndex]),
    nameIndex < 0 ? null : table.rows.map((row) => row[nameIndex]),
  );
}

/**
 * Normalises the export and marks frozen rows.
 *
 * Frozen rows stay on their current manager and are excluded from balancing:
 * - rows with a termination date;
 * - rows with an unknown payment status (not paid/topay).
 */
export function validateAndPrepare(table: Table): PreparedTable {
  const required = [COL_MANAGER, COL_MANAGER_NAME, COL_TARIFF, COL_STATUS];
  const missing = required.filter((column) => !table.columns.includes(column));
  if (missing.length > 0) {
    throw new Error(`В файле нет обязательных колонок: ${missing.join(", ")}`);
  }

  const iManager = table.columns.indexOf(COL_MANAGER);
  const iName = table.columns.indexOf(COL_MANAGER_NAME);
  const iTariff = table.columns.indexOf(COL_TARIFF);
  const iStatus = table.columns.indexOf(COL_STATUS);
  const iTermination = table.columns.indexOf(COL_TERMINATION);

  const rows: PreparedRow[] = table.rows.map((raw) => {
    const manager = normEmail(raw[iManager]);
    const managerName = normName(raw[iName]);
    const tariff = parseTariff(raw[iTariff]);
    const status = pyLower(normName(raw[iStatus]));

    let frozen = "";
    if (iTermination >= 0 && normName(raw[iTermination]) !== "") {
      frozen = FROZEN_TERMINATED;
    } else if (!KNOWN_STATUSES.includes(status)) {
      frozen = `неизвестный статус оплаты: '${status}'`;
    }

    const cells = raw.slice();
    cells[iManager] = manager;
    cells[iName] = managerName;
    cells[iTariff] = tariff;
    return { manager, managerName, tariff, paid: status === STATUS_PAID ? 1 : 0, frozen, cells };
  });

  if (rows.some((row) => row.manager === "")) {
    throw new Error("Есть строки без почты менеджера.");
  }
  if (rows.some((row) => row.frozen === "" && !isTariff(row.tariff))) {
    throw new Error("Обнаружены строки с некорректным тарифом. Допустимы только 1, 3, 12.");
  }

  // Internal columns of the reference never reach the result, even if the input had them.
  const keep = table.columns.map((column) => column !== COL_PAID && column !== COL_FROZEN);
  return {
    columns: table.columns.filter((_, i) => keep[i]),
    rows: rows.map((row) => ({ ...row, cells: row.cells.filter((_, i) => keep[i]) })),
  };
}
