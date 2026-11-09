// Rules of the managers editor (add / update / bulk edit / delete).

import { describe, expect, it } from "vitest";

import { type ManagerEntry, managerKey } from "../src/core/config.ts";
import { type EditorForm, deleteManagers, parseCapField, saveManager, sortManagers } from "../src/core/editor.ts";
import { niceTicks } from "../src/ui/chart.ts";

const entry = (email: string, name: string, isSupport = false, cap: number | null = null): ManagerEntry => ({
  email,
  name,
  is_support: isSupport,
  has_cap: cap !== null,
  cap,
});

const form = (overrides: Partial<EditorForm> = {}): EditorForm => ({
  name: "",
  email: "",
  isSupport: false,
  hasCap: false,
  capText: "",
  ...overrides,
});

const keys = (...values: string[]) => new Set(values);

describe("cap field", () => {
  it("is ignored without 'Есть cap'", () => {
    expect(parseCapField(false, "garbage")).toEqual({ ok: true, cap: null });
  });

  it("must be filled and a positive integer with 'Есть cap'", () => {
    expect(parseCapField(true, "  ")).toEqual({ ok: false, message: "Укажи значение cap." });
    for (const bad of ["0", "-3", "abc", "2.5", "1e3"]) {
      expect(parseCapField(true, bad), bad).toEqual({ ok: false, message: "Cap должен быть положительным целым числом." });
    }
    expect(parseCapField(true, " 120 ")).toEqual({ ok: true, cap: 120 });
  });
});

describe("saving a manager", () => {
  const base = [entry("anna@cp.ru", "Анна", true), entry("boris@cp.ru", "Борис")];

  it("adds a new manager, lowercasing the email and defaulting the name to it", () => {
    const result = saveManager(base, keys(), form({ email: " New@CP.ru ", isSupport: true, hasCap: true, capText: "50" }));
    // Sorted by name; the name defaults to the email, and Latin sorts before Cyrillic.
    expect(result.ok && result.managers.map((m) => m.email)).toEqual(["new@cp.ru", "anna@cp.ru", "boris@cp.ru"]);
    const added = result.ok && result.managers[0]!;
    expect(added).toEqual({ email: "new@cp.ru", name: "new@cp.ru", is_support: true, has_cap: true, cap: 50 });
    expect(result.ok && result.status).toBe("Менеджер сохранён");
  });

  it("requires an email", () => {
    expect(saveManager(base, keys(), form({ name: "Без почты" }))).toEqual({
      ok: false,
      message: "Укажи почту менеджера — по ней он ищется в выгрузке.",
    });
  });

  it("updates the selected entry, and lets a legacy entry get its email", () => {
    const legacy = [entry("", "Иванов Иван", true), ...base];
    const result = saveManager(legacy, keys(managerKey(legacy[0]!)), form({ name: "Иванов Иван", email: "ivanov@cp.ru", isSupport: true }));
    expect(result.ok && result.managers.find((m) => m.email === "ivanov@cp.ru")?.name).toBe("Иванов Иван");
    expect(result.ok && result.managers.length).toBe(3);
  });

  it("updates the entry with the same email when nothing is selected", () => {
    const result = saveManager(base, keys(), form({ name: "Анна Новая", email: "ANNA@cp.ru", isSupport: false }));
    expect(result.ok && result.managers.length).toBe(2);
    expect(result.ok && result.managers.find((m) => m.email === "anna@cp.ru")).toMatchObject({ name: "Анна Новая", is_support: false });
  });

  it("refuses an email that belongs to another manager", () => {
    const result = saveManager(base, keys(managerKey(base[1]!)), form({ name: "Борис", email: "anna@cp.ru" }));
    expect(result).toEqual({ ok: false, message: "Почта anna@cp.ru уже есть у другого менеджера." });
  });

  it("drops the cap when 'Есть cap' is off", () => {
    const capped = [entry("anna@cp.ru", "Анна", true, 30)];
    const result = saveManager(capped, keys(managerKey(capped[0]!)), form({ name: "Анна", email: "anna@cp.ru", isSupport: true, hasCap: false }));
    expect(result.ok && result.managers[0]).toMatchObject({ has_cap: false, cap: null });
  });

  it("keeps the list sorted by name, case-insensitively", () => {
    const result = saveManager(base, keys(), form({ name: "алексей", email: "a@cp.ru" }));
    expect(result.ok && result.managers.map((m) => m.name)).toEqual(["алексей", "Анна", "Борис"]);
    expect(sortManagers([entry("b@x", "b"), entry("a@x", "A")]).map((m) => m.name)).toEqual(["A", "b"]);
  });

  it("does not modify the list it was given", () => {
    const before = JSON.stringify(base);
    saveManager(base, keys(managerKey(base[0]!)), form({ name: "Другое", email: "anna@cp.ru", isSupport: false }));
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("bulk edit", () => {
  const list = [entry("a@cp.ru", "A"), entry("b@cp.ru", "B", true, 10), entry("c@cp.ru", "C")];

  it("applies support and cap to every selected manager and nothing else", () => {
    const result = saveManager(list, keys("a@cp.ru", "b@cp.ru"), form({ isSupport: true, hasCap: true, capText: "77", name: "ignored", email: "ignored@cp.ru" }));
    expect(result.ok && result.managers.map((m) => [m.email, m.is_support, m.cap])).toEqual([
      ["a@cp.ru", true, 77],
      ["b@cp.ru", true, 77],
      ["c@cp.ru", false, null],
    ]);
    expect(result.ok && result.status).toBe("Обновлено 2 менеджеров");
  });

  it("can clear caps for the whole selection", () => {
    const result = saveManager(list, keys("b@cp.ru", "c@cp.ru"), form({ isSupport: false, hasCap: false }));
    expect(result.ok && result.managers.map((m) => m.cap)).toEqual([null, null, null]);
  });

  it("validates the cap before touching anything", () => {
    expect(saveManager(list, keys("a@cp.ru", "b@cp.ru"), form({ hasCap: true, capText: "" }))).toEqual({ ok: false, message: "Укажи значение cap." });
  });
});

describe("deleting managers", () => {
  it("removes the selected keys, including legacy entries keyed by name", () => {
    const list = [entry("a@cp.ru", "A"), entry("", "Ушедший Человек", true), entry("c@cp.ru", "C")];
    const left = deleteManagers(list, keys("a@cp.ru", "ушедший человек"));
    expect(left.map((m) => m.email)).toEqual(["c@cp.ru"]);
  });
});

describe("chart axis", () => {
  it("picks round ticks covering the maximum", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(100)).toEqual([0, 20, 40, 60, 80, 100]);
    const ticks = niceTicks(162);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(162);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(niceTicks(7).at(-1)!).toBeGreaterThanOrEqual(7);
  });
});
