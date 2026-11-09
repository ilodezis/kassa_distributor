// Reading the export and writing the result workbook.

import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";

import { COL_INN, COL_MANAGER, COL_NEW_MANAGER } from "../src/core/constants.ts";
import { distribute } from "../src/core/distribute.ts";
import type { Cell } from "../src/core/pystr.ts";
import { MOVES_COLUMNS, SUMMARY_COLUMNS, buildResultWorkbook, readInputTable } from "../src/core/xlsx.ts";
import { COLUMNS, col, makeCase } from "./helpers.ts";

async function toXlsx(rows: Cell[][]): Promise<ArrayBuffer> {
  const blob = await writeXlsxFile(rows).toBlob();
  return blob.arrayBuffer();
}

describe("xlsx input", () => {
  it("keeps the leading zero of the INN", async () => {
    const { table } = makeCase(8, { rows: 5 });
    table.rows[0]![col(table, COL_INN)] = "071303241361";
    const back = await readInputTable(await toXlsx([table.columns, ...table.rows]));
    expect(back.rows[0]![col(back, COL_INN)]).toBe("071303241361");
    expect(back.columns).toEqual(table.columns);
    expect(back.rows.length).toBe(5);
  });

  it("turns a numeric INN into text and keeps empty cells empty", async () => {
    const back = await readInputTable(
      await toXlsx([
        [COL_INN, "Тариф", "Заметка"],
        [3508123456, 12, null],
        ["0012345678", 3, " с пробелами "],
      ]),
    );
    expect(back.rows[0]).toEqual(["3508123456", 12, null]);
    expect(back.rows[1]).toEqual(["0012345678", 3, " с пробелами "]); // not trimmed, like pandas
  });

  it("reads only the first sheet", async () => {
    const blob = await writeXlsxFile([
      { data: [["a"], ["first"]], sheet: "one" },
      { data: [["a"], ["second"]], sheet: "two" },
    ]).toBlob();
    const back = await readInputTable(await blob.arrayBuffer());
    expect(back.rows).toEqual([["first"]]);
  });
});

describe("result workbook", () => {
  it("has the four sheets of the Python version with their headers", async () => {
    const { table, config } = makeCase(21, { rows: 150, support: 4, external: 2 });
    const result = distribute(table, config);
    const sheets = await readXlsxFile(await (await buildResultWorkbook(result)).arrayBuffer());

    expect(sheets.map((s) => s.sheet)).toEqual(["result", "summary", "moves", "checks"]);
    const byName = new Map(sheets.map((s) => [s.sheet, s.data]));

    const resultSheet = byName.get("result")!;
    expect(resultSheet[0]).toEqual(result.output.columns);
    expect(resultSheet.length).toBe(table.rows.length + 1);
    const iNew = result.output.columns.indexOf(COL_NEW_MANAGER);
    expect(resultSheet.slice(1).map((r) => r[iNew])).toEqual(result.newManagerEmails);
    expect(resultSheet[1]![result.output.columns.indexOf(COL_INN)]).toBe(String(table.rows[0]![col(table, COL_INN)]));

    const summarySheet = byName.get("summary")!;
    expect(summarySheet[0]).toEqual([...SUMMARY_COLUMNS]);
    expect(summarySheet.length).toBe(result.summary.length + 1);
    expect(summarySheet[1]![SUMMARY_COLUMNS.indexOf("has_cap")]).toBe(false);

    const movesSheet = byName.get("moves")!;
    expect(movesSheet[0]).toEqual([...MOVES_COLUMNS]);
    expect(movesSheet.length).toBe(result.moves.length + 1);

    expect(byName.get("checks")).toEqual([["checks"], ...result.checks.map((c) => [c])]);
  });

  it("writes a header-only moves sheet when nothing moves", async () => {
    // One support manager that already holds everything.
    const columns = COLUMNS.slice();
    const rows: Cell[][] = [
      ["Анна", "anna@cp.ru", "100000000001", 1, "topay", null],
      ["Анна", "anna@cp.ru", "100000000002", 3, "topay", null],
    ];
    const result = distribute(
      { columns, rows },
      { managers: [{ email: "anna@cp.ru", name: "Анна", is_support: true, has_cap: false, cap: null }] },
    );
    expect(result.moves).toEqual([]);

    const sheets = await readXlsxFile(await (await buildResultWorkbook(result)).arrayBuffer());
    const moves = sheets.find((s) => s.sheet === "moves")!.data;
    expect(moves).toEqual([[...MOVES_COLUMNS]]);
    expect(sheets[0]!.data[1]![columns.indexOf(COL_MANAGER)]).toBe("anna@cp.ru");
  });
});
