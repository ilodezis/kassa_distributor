// Reading the export and writing the result workbook.
// The `universal` builds of both libraries run in the Tauri webview and in Node (tests, scripts).

import { readSheet } from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";

import type { DistributionResult, MoveRow, SummaryRow } from "./distribute.ts";
import type { Cell } from "./pystr.ts";
import { type Table, tableFromSheet } from "./table.ts";

/** Reads the first sheet of an .xlsx. The ИНН column is kept as text so leading zeros survive. */
export async function readInputTable(data: ArrayBuffer | Blob): Promise<Table> {
  // trim: false — the export is read as is, like pandas does; names and emails are trimmed later.
  const sheet = await readSheet(data, 1, { trim: false });
  return tableFromSheet(sheet as unknown as Cell[][]);
}

const DATE_FORMAT = "yyyy-mm-dd hh:mm:ss";

export const SUMMARY_COLUMNS: readonly (keyof SummaryRow)[] = [
  "name",
  "manager",
  "has_cap",
  "cap_value",
  "locked_paid",
  "target_total",
  "fact_total",
  "delta_total",
  "target_1",
  "fact_1",
  "delta_1",
  "target_3",
  "fact_3",
  "delta_3",
  "target_12",
  "fact_12",
  "delta_12",
];

export const MOVES_COLUMNS = ["inn", "old_manager", "new_manager", "tariff", "paid"] as const;

function sheetCell(value: Cell | undefined): Cell {
  // An empty string and a missing value are both an empty cell in the output.
  return value === undefined || value === "" ? null : value;
}

/** Sheets `result`, `summary`, `moves`, `checks` — the same workbook the Python version wrote. */
export async function buildResultWorkbook(result: DistributionResult): Promise<Blob> {
  const resultSheet = [result.output.columns as Cell[], ...result.output.rows.map((r) => r.map(sheetCell))];
  const summarySheet = [
    SUMMARY_COLUMNS as readonly Cell[] as Cell[],
    ...result.summary.map((row) => SUMMARY_COLUMNS.map((column) => sheetCell(row[column]))),
  ];
  const movesSheet = [
    MOVES_COLUMNS as readonly Cell[] as Cell[],
    ...result.moves.map((row) => MOVES_COLUMNS.map((column) => sheetCell(row[column]))),
  ];
  const checksSheet = [["checks"], ...result.checks.map((line) => [line])];

  return writeXlsxFile([
    { data: resultSheet, sheet: "result", dateFormat: DATE_FORMAT, stickyRowsCount: 1 },
    { data: summarySheet, sheet: "summary", stickyRowsCount: 1 },
    { data: movesSheet, sheet: "moves", stickyRowsCount: 1 },
    { data: checksSheet, sheet: "checks", stickyRowsCount: 1 },
  ]).toBlob();
}

/** Headers of the transfer file, exactly as in the template the receiving side sent. */
export const TRANSFER_COLUMNS = ["ИНН", "почта целевого менеджера", "дата переноса"] as const;

const TRANSFER_DATE_FORMAT = "yyyy-mm-dd";

/**
 * Parses a calendar date from `<input type="date">` (`YYYY-MM-DD`) into midnight UTC.
 * write-excel-file turns a Date into an Excel serial from its UTC time, so a local midnight
 * would land on the previous day east of Greenwich.
 */
export function parseTransferDate(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) throw new Error(`Некорректная дата переноса: '${text}'`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Некорректная дата переноса: '${text}'`);
  }
  return date;
}

/**
 * The transfer file: one row per register that changes hands — ИНН, the new manager's email,
 * and the transfer date chosen by whoever runs the distribution. ИНН is written as text so
 * leading zeros survive the import on the other side.
 */
export async function buildTransferWorkbook(moves: readonly MoveRow[], transferDate: Date): Promise<Blob> {
  const header = TRANSFER_COLUMNS.map((value) => ({ value, type: String }));
  const rows = moves.map((move) => [
    move.inn === null || move.inn === "" ? null : { value: String(move.inn), type: String, format: "@" },
    { value: move.new_manager_email, type: String },
    { value: transferDate, type: Date, format: TRANSFER_DATE_FORMAT },
  ]);
  return writeXlsxFile([header, ...rows], {
    sheet: "Лист1",
    columns: [{ width: 25 }, { width: 32 }, { width: 14 }],
    stickyRowsCount: 1,
  }).toBlob();
}
