// Reading the export and writing the result workbook.

import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";

import { COL_INN, COL_MANAGER, COL_NEW_MANAGER } from "../src/core/constants.ts";
import { distribute } from "../src/core/distribute.ts";
import type { Cell } from "../src/core/pystr.ts";
import {
  MOVES_COLUMNS,
  SUMMARY_COLUMNS,
  TRANSFER_COLUMNS,
  buildResultWorkbook,
  buildTransferWorkbook,
  parseTransferDate,
  readInputTable,
} from "../src/core/xlsx.ts";
import { todayIso } from "../src/ui/dialogs.ts";
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

describe("transfer file", () => {
  it("lists every move as ИНН, new manager email and the chosen date", async () => {
    const { table, config } = makeCase(21, { rows: 150, support: 4, external: 2 });
    const result = distribute(table, config);
    expect(result.moves.length).toBeGreaterThan(0);

    const blob = await buildTransferWorkbook(result.moves, parseTransferDate("2026-12-01"));
    const sheets = await readXlsxFile(await blob.arrayBuffer());
    expect(sheets.map((s) => s.sheet)).toEqual(["Лист1"]);

    const [header, ...rows] = sheets[0]!.data;
    expect(header).toEqual([...TRANSFER_COLUMNS]);
    expect(rows.length).toBe(result.moves.length);
    const supportEmails = new Set(config.managers.filter((m) => m.is_support).map((m) => m.email));
    rows.forEach((row, i) => {
      const move = result.moves[i]!;
      expect(row[0]).toBe(String(move.inn));
      expect(row[1]).toBe(move.new_manager_email);
      expect(supportEmails.has(row[1] as string)).toBe(true);
      expect((row[2] as Date).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    });
  });

  it("keeps the INN as text with its leading zero", async () => {
    const blob = await buildTransferWorkbook(
      [{ inn: "071303241361", old_manager: "Анна", new_manager: "Борис", new_manager_email: "boris@cp.ru", tariff: 12, paid: 0 }],
      parseTransferDate("2026-01-31"),
    );
    const [, row] = (await readXlsxFile(await blob.arrayBuffer()))[0]!.data;
    expect(row).toEqual(["071303241361", "boris@cp.ru", new Date(Date.UTC(2026, 0, 31))]);
  });

  it("rejects dates that are not a real YYYY-MM-DD day", () => {
    expect(() => parseTransferDate("")).toThrow();
    expect(() => parseTransferDate("01.12.2026")).toThrow();
    expect(() => parseTransferDate("2026-02-30")).toThrow();
  });

  it("defaults the picker to today in the local calendar", () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("register count wording", () => {
  it("picks the Russian noun form", async () => {
    const { pluralRu } = await import("../src/ui/app.ts");
    const form = (n: number) => pluralRu(n, "касса", "кассы", "касс");
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 104].map(form)).toEqual([
      "касса", "кассы", "касс", "касс", "касс", "касса", "кассы", "касс", "касс", "кассы",
    ]);
  });
});
