// Invariants of the distribution. Mirrors reference/test_distribution.py.

import { describe, expect, it } from "vitest";

import { ensureManagersPresent, getCapMap } from "../src/core/config.ts";
import {
  COL_INN,
  COL_MANAGER,
  COL_NEW_MANAGER,
  COL_NEW_MANAGER_NAME,
  COL_STATUS,
  COL_TERMINATION,
  PERIOD_TOLERANCE,
  TOTAL_TOLERANCE,
  VALID_TARIFFS,
} from "../src/core/constants.ts";
import {
  computeTargetPeriods,
  computeTotalTargets,
  countFromAssignment,
  distribute,
  exactTotalFill,
  globalTariffShares,
  tariffSwaps,
} from "../src/core/distribute.ts";
import { managersFromTable, validateAndPrepare } from "../src/core/table.ts";
import { col, makeCase } from "./helpers.ts";

const worst = (values: number[]) => Math.max(...values.map(Math.abs));

describe("distribution invariants", () => {
  it("stage 1 hits every total exactly: the spread of totals is zero", () => {
    for (const seed of [1, 2, 3]) {
      const { table, config } = makeCase(seed);
      const { summary } = distribute(table, config);
      expect(worst(summary.map((r) => r.delta_total)), `seed ${seed}`).toBe(0);
    }
  });

  it("tariff spread stays within tolerance", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { table, config } = makeCase(seed);
      const { summary } = distribute(table, config);
      for (const tariff of VALID_TARIFFS) {
        const deltas = summary.map((r) => r[`delta_${tariff}` as "delta_1" | "delta_3" | "delta_12"]);
        expect(worst(deltas), `seed ${seed}, tariff ${tariff}`).toBeLessThanOrEqual(PERIOD_TOLERANCE);
      }
    }
  });

  it("stage 2 swaps never change the number of registers of a manager", () => {
    const { table, config, supportNames } = makeCase(7);
    const prepared = validateAndPrepare(table);
    const merged = ensureManagersPresent(
      config,
      managersFromTable({ columns: prepared.columns, rows: prepared.rows.map((r) => r.cells) }),
    );
    const capMap = getCapMap(merged);

    const work = prepared.rows;
    const supportSet = new Set(supportNames);
    const locked = countFromAssignment(
      work.filter((r) => supportSet.has(r.manager) && r.paid === 1).map((r) => [r.manager, r.tariff] as const),
      supportNames,
    ).total;
    const targets = computeTotalTargets(work.length, supportNames, capMap, locked);
    const periodTargets = computeTargetPeriods(targets, globalTariffShares(work));

    const filled = exactTotalFill(work, supportNames, targets, periodTargets);
    const swapped = tariffSwaps(work, filled, supportNames, periodTargets);

    const tally = (assigned: string[]) => {
      const counts = new Map<string, number>();
      for (const m of assigned) counts.set(m, (counts.get(m) ?? 0) + 1);
      return counts;
    };
    expect(tally(swapped)).toEqual(tally(filled));
  });

  it("paid registers on support do not move, nothing is lost or duplicated", () => {
    const { table, config, supportNames } = makeCase(4);
    const { output } = distribute(table, config);

    expect(output.rows.length).toBe(table.rows.length);
    const iNew = col(output, COL_NEW_MANAGER);
    const iOld = col(output, COL_MANAGER);
    const iStatus = col(output, COL_STATUS);
    const support = new Set(supportNames);

    for (const row of output.rows) {
      expect(support.has(row[iNew] as string), "register left outside support").toBe(true);
      if (support.has(row[iOld] as string) && row[iStatus] === "paid") {
        expect(row[iNew], "paid register moved off a support manager").toBe(row[iOld]);
      }
    }
  });

  it("caps are respected within the tolerance", () => {
    const { table, config, supportNames } = makeCase(5, { caps: { 0: 80, 3: 110 } });
    const { summary } = distribute(table, config);
    const facts = new Map(summary.map((r) => [r.manager, r.fact_total]));
    for (const [index, cap] of [
      [0, 80],
      [3, 110],
    ] as const) {
      expect(facts.get(supportNames[index]!)!).toBeLessThanOrEqual(cap + TOTAL_TOLERANCE);
    }
  });

  it("frozen rows (terminated, unknown status) stay put and do not count towards the load", () => {
    const { table, config } = makeCase(6);
    const iManager = col(table, COL_MANAGER);
    const iStatus = col(table, COL_STATUS);
    const iTermination = col(table, COL_TERMINATION);
    table.rows[0]![iManager] = "sales00@cp.ru";
    table.rows[0]![iTermination] = "15.11.2026";
    table.rows[1]![iStatus] = "refund";
    table.rows[1]![iTermination] = null;

    const result = distribute(table, config);
    const { output } = result;

    expect(output.rows.length).toBe(table.rows.length);
    const iNew = col(output, COL_NEW_MANAGER);
    const iOld = col(output, COL_MANAGER);
    for (const i of [0, 1]) expect(output.rows[i]![iNew], `row ${i} moved`).toBe(output.rows[i]![iOld]);

    expect(result.summary.reduce((sum, r) => sum + r.fact_total, 0)).toBe(table.rows.length - 2);
    expect(worst(result.summary.map((r) => r.delta_total))).toBe(0);
    expect(result.checks.some((c) => c.includes("refund"))).toBe(true);
    expect(result.checks.some((c) => c.includes("расторжение"))).toBe(true);
    expect(output.columns).not.toContain("_paid");
    expect(output.columns).not.toContain("_frozen_reason");
    const iName = col(output, COL_NEW_MANAGER_NAME);
    expect(output.rows.every((row) => typeof row[iName] === "string" && row[iName] !== "")).toBe(true);
  });
});

describe("distribution details", () => {
  it("keeps the original row order and columns, and appends the two new columns", () => {
    const { table, config } = makeCase(8, { rows: 60, support: 4, external: 2 });
    const { output, newManagerEmails } = distribute(table, config);

    expect(output.columns.slice(0, table.columns.length)).toEqual(table.columns);
    expect(output.columns.slice(table.columns.length)).toEqual([COL_NEW_MANAGER, COL_NEW_MANAGER_NAME]);
    const iInn = col(output, COL_INN);
    expect(output.rows.map((r) => r[iInn])).toEqual(table.rows.map((r) => r[iInn]));
    expect(output.rows.map((r) => r[col(output, COL_NEW_MANAGER)])).toEqual(newManagerEmails);
  });

  it("overwrites same-named result columns in place when an earlier result is loaded again", () => {
    const { table, config } = makeCase(9, { rows: 40, support: 3, external: 1 });
    table.columns.push(COL_NEW_MANAGER, COL_NEW_MANAGER_NAME);
    for (const row of table.rows) row.push("stale@cp.ru", "Stale");

    const { output } = distribute(table, config);
    expect(output.columns.filter((c) => c === COL_NEW_MANAGER).length).toBe(1);
    expect(output.columns.length).toBe(table.columns.length);
    expect(output.rows.every((r) => r[col(output, COL_NEW_MANAGER)] !== "stale@cp.ru")).toBe(true);
  });

  it("works from the manager emails regardless of case and spaces", () => {
    const { table, config, supportNames } = makeCase(10, { rows: 80, support: 3, external: 1 });
    const iManager = col(table, COL_MANAGER);
    table.rows[0]![iManager] = `  ${String(table.rows[0]![iManager]).toUpperCase()} `;
    const { newManagerEmails } = distribute(table, config);
    expect(newManagerEmails.every((m) => supportNames.includes(m))).toBe(true);
  });

  it("refuses an export without the required columns", () => {
    expect(() => distribute({ columns: ["x"], rows: [] }, { managers: [] })).toThrow(
      "В файле нет обязательных колонок: Почта текущего менеджера, ФИО текущего менеджера, Тариф, Статус оплаты",
    );
  });

  it("refuses rows without a manager email and active rows with a bad tariff", () => {
    const noEmail = makeCase(11, { rows: 10, support: 2, external: 1 });
    noEmail.table.rows[3]![col(noEmail.table, COL_MANAGER)] = "  ";
    expect(() => distribute(noEmail.table, noEmail.config)).toThrow("Есть строки без почты менеджера.");

    const badTariff = makeCase(12, { rows: 10, support: 2, external: 1 });
    badTariff.table.rows[2]![col(badTariff.table, "Тариф")] = "6";
    expect(() => distribute(badTariff.table, badTariff.config)).toThrow(
      "Обнаружены строки с некорректным тарифом. Допустимы только 1, 3, 12.",
    );

    // A frozen row may carry any tariff: it does not take part.
    badTariff.table.rows[2]![col(badTariff.table, COL_TERMINATION)] = "01.11.2026";
    expect(() => distribute(badTariff.table, badTariff.config)).not.toThrow();
  });

  it("refuses a config without support managers", () => {
    const { table, config } = makeCase(13, { rows: 10, support: 2, external: 1 });
    for (const m of config.managers) m.is_support = false;
    expect(() => distribute(table, config)).toThrow("В конфиге нет ни одного support-менеджера с почтой.");
  });

  it("does not lose registers when every cap is too low; the checks log shows it", () => {
    const { table, config, supportNames } = makeCase(14, { rows: 300, support: 4, external: 1, caps: { 0: 10, 1: 10, 2: 10, 3: 10 } });
    const { output, checks } = distribute(table, config);
    const iNew = col(output, COL_NEW_MANAGER);
    expect(output.rows.every((r) => supportNames.includes(r[iNew] as string))).toBe(true);
    expect(checks.some((c) => c.startsWith("ПРЕВЫШЕН CAP+"))).toBe(true);
  });

  it("lists frozen registers in the checks, with 'nan' for a missing INN like the reference", () => {
    const { table, config } = makeCase(15, { rows: 30, support: 3, external: 1 });
    table.rows[4]![col(table, COL_STATUS)] = "Refund";
    table.rows[5]![col(table, COL_TERMINATION)] = "2026-10-01";
    table.rows[5]![col(table, COL_INN)] = null;
    const { checks } = distribute(table, config);

    const header = checks.find((c) => c.startsWith("Замороженных касс"));
    expect(header).toBe("Замороженных касс (расторжение / неизвестный статус), не распределены: 2");
    expect(checks.some((c) => c.includes("неизвестный статус оплаты: 'refund'"))).toBe(true);
    expect(checks.some((c) => c.startsWith("  ИНН nan — ") && c.endsWith(": расторжение"))).toBe(true);
  });

  it("reports zero frozen registers when there are none", () => {
    const { table, config } = makeCase(16, { rows: 30, support: 3, external: 1 });
    const { checks } = distribute(table, config);
    expect(checks).toContain("Замороженных касс (расторжение / неизвестный статус): 0");
    expect(checks.filter((c) => c.includes("ДА") || c.includes("НЕТ")).length).toBeGreaterThanOrEqual(4);
  });

  it("mentions support entries without an email in the checks and skips them", () => {
    const { table, config } = makeCase(17, { rows: 30, support: 3, external: 1 });
    config.managers.push({ name: "Ушедший Человек", is_support: true, has_cap: false, cap: null });
    const { checks, summary } = distribute(table, config);
    expect(checks.at(-1)).toBe("Support без почты, в раскладке не участвуют: Ушедший Человек");
    expect(summary.length).toBe(3);
  });

  it("adds managers found in the export to the returned config as non-support", () => {
    const { table, config } = makeCase(18, { rows: 50, support: 2, external: 2 });
    config.managers = config.managers.filter((m) => m.is_support);
    const { managersConfig } = distribute(table, config);
    const added = managersConfig.managers.filter((m) => String(m.email).startsWith("sales"));
    expect(added.length).toBe(2);
    expect(added.every((m) => m.is_support === false)).toBe(true);
  });

  it("sorts the summary by cap first, then by name", () => {
    const { table, config } = makeCase(19, { rows: 200, support: 4, external: 1, caps: { 2: 80 } });
    const { summary, chart } = distribute(table, config);
    expect(summary[0]!.manager).toBe("support02@cp.ru");
    expect(summary[0]!.has_cap).toBe(true);
    expect(summary[0]!.cap_value).toBe(80);
    expect(summary.slice(1).map((r) => r.name)).toEqual(summary.slice(1).map((r) => r.name).sort());
    expect(chart.map((p) => p.manager)).toEqual(summary.map((r) => r.name));
  });

  it("logs a move for every register that changed manager, with the INN", () => {
    const { table, config } = makeCase(20, { rows: 120, support: 3, external: 2 });
    const { moves, output } = distribute(table, config);
    const iOld = col(output, COL_MANAGER);
    const iNew = col(output, COL_NEW_MANAGER);
    const expected = output.rows.filter((r) => r[iOld] !== r[iNew]);
    expect(moves.length).toBe(expected.length);
    expect(moves.every((m) => /^\d{12}$/.test(String(m.inn)))).toBe(true);
  });
});
