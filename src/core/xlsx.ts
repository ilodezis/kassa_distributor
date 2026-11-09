// Reading the export and writing the result workbook.
// The `universal` builds of both libraries run in the Tauri webview and in Node (tests, scripts).

import { readSheet } from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";

import type { DistributionResult, SummaryRow } from "./distribute.ts";
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
