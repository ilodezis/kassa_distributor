// Managers config and Python-compatible string helpers.

import { describe, expect, it } from "vitest";

import {
  type ManagerInput,
  ensureManagersPresent,
  getCapMap,
  getNameMap,
  getSupportManagers,
  getSupportWithoutEmail,
  normalizeManagers,
  parseManagersConfig,
  serializeManagersConfig,
} from "../src/core/config.ts";
import { largestRemainder } from "../src/core/distribute.ts";
import { cmpStr, normEmail, normName, parseTariff, pyBool, pyInt, pyStrip } from "../src/core/pystr.ts";
import { mangleHeader, tableFromSheet } from "../src/core/table.ts";

const ch = String.fromCharCode;

describe("legacy config", () => {
  it("gets an email by exact full name; unmatched support entries are reported", () => {
    const legacy = {
      version: 1,
      managers: [
        { name: "Иванов Иван", is_support: true, has_cap: true, cap: 150 },
        { name: "Ушедший Человек", is_support: true, has_cap: false, cap: null },
      ] as ManagerInput[],
    };
    const merged = ensureManagersPresent(legacy, [
      ["I.Ivanov@cp.ru", "Иванов Иван"],
      ["p.petrov@cp.ru", "Петров Пётр"],
    ]);

    const byName = new Map(merged.managers.map((m) => [m.name, m]));
    expect(byName.get("Иванов Иван")!.email).toBe("i.ivanov@cp.ru");
    expect(byName.get("Иванов Иван")!.cap).toBe(150);
    expect(byName.get("Петров Пётр")!.is_support).toBe(false);
    expect(getSupportManagers(merged)).toEqual(["i.ivanov@cp.ru"]);
    expect(getSupportWithoutEmail(merged)).toEqual(["Ушедший Человек"]);
  });

  it("matches a legacy entry only once", () => {
    const merged = ensureManagersPresent({ managers: [{ name: "Иванов Иван", is_support: true }] }, [
      ["a@cp.ru", "Иванов Иван"],
      ["b@cp.ru", "Иванов Иван"],
    ]);
    expect(merged.managers.map((m) => [m.email, m.name])).toEqual([
      ["a@cp.ru", "Иванов Иван"],
      ["b@cp.ru", "Иванов Иван"],
    ]);
    expect(getSupportManagers(merged)).toEqual(["a@cp.ru"]);
  });

  it("keeps managers sorted by lowercased name", () => {
    const merged = ensureManagersPresent({ managers: [] }, [
      ["z@cp.ru", "борис"],
      ["a@cp.ru", "Яков"],
      ["m@cp.ru", "Анна"],
    ]);
    expect(merged.managers.map((m) => m.name)).toEqual(["Анна", "борис", "Яков"]);
  });
});

describe("normalizeManagers", () => {
  it("trims and lowercases emails, drops duplicates and empty entries", () => {
    const out = normalizeManagers(
      [
        { email: " A@CP.ru ", name: "Анна", is_support: true },
        { email: "a@cp.ru", name: "Дубль" },
        { name: "", email: "" },
        "not an object",
        { name: "Без почты" },
        { name: "без почты" },
      ],
      false,
    );
    expect(out.map((m) => [m.email, m.name])).toEqual([
      ["a@cp.ru", "Анна"],
      ["", "Без почты"],
    ]);
  });

  it("infers has_cap from cap when the flag is missing; zero and empty mean no cap", () => {
    const out = normalizeManagers(
      [
        { email: "a@cp.ru", cap: 40 },
        { email: "b@cp.ru", cap: 0 },
        { email: "c@cp.ru", cap: "" },
        { email: "d@cp.ru", has_cap: true, cap: " 25 " },
        { email: "e@cp.ru", has_cap: false, cap: 99 },
      ],
      false,
    );
    expect(out.map((m) => [m.has_cap, m.cap])).toEqual([
      [true, 40],
      [false, null],
      [false, null],
      [true, 25],
      [false, null],
    ]);
  });

  it("drops an unparsable cap on load but refuses it on save", () => {
    const items = [{ email: "a@cp.ru", has_cap: true, cap: "many" }];
    expect(normalizeManagers(items, false)[0]!.cap).toBeNull();
    expect(() => normalizeManagers(items, true)).toThrow();
    expect(() => serializeManagersConfig({ managers: items })).toThrow();
  });

  it("uses the email as the name when the name is empty", () => {
    expect(normalizeManagers([{ email: "a@cp.ru" }], false)[0]!.name).toBe("a@cp.ru");
  });
});

describe("config file", () => {
  it("round-trips through the version 2 format", () => {
    const text = serializeManagersConfig({
      managers: [
        { email: "i.ivanov@cp.ru", name: "Иванов Иван Иванович", is_support: true, has_cap: false, cap: null },
        { email: "p.petrov@cp.ru", name: "Петров Пётр Петрович", is_support: true, has_cap: true, cap: 150 },
      ],
    });
    expect(text).toContain('"version": 2');
    expect(text).toContain("Иванов Иван Иванович"); // not escaped to \uXXXX
    const parsed = parseManagersConfig(text);
    expect(parsed.version).toBe(2);
    expect(parsed.managers[1]).toEqual({
      email: "p.petrov@cp.ru",
      name: "Петров Пётр Петрович",
      is_support: true,
      has_cap: true,
      cap: 150,
    });
  });

  it("reads a version 1 file (names only) and ignores junk", () => {
    const parsed = parseManagersConfig(
      JSON.stringify({ version: 1, managers: [{ name: "Иванов Иван", is_support: true, has_cap: true, cap: 7 }] }),
    );
    expect(parsed.managers).toEqual([
      { email: "", name: "Иванов Иван", is_support: true, has_cap: true, cap: 7 },
    ]);
    expect(parseManagersConfig("[]").managers).toEqual([]);
    expect(parseManagersConfig('{"managers": null}').managers).toEqual([]);
    expect(() => parseManagersConfig("{broken")).toThrow();
  });

  it("builds the cap and name maps", () => {
    const config = {
      managers: [
        { email: "a@cp.ru", name: "Анна", is_support: true, has_cap: true, cap: 12 },
        { email: "b@cp.ru", name: "", is_support: false, has_cap: false, cap: null },
      ],
    };
    expect(getCapMap(config)).toEqual(
      new Map([
        ["a@cp.ru", 12],
        ["b@cp.ru", null],
      ]),
    );
    const names = getNameMap(config, [
      ["a@cp.ru", "Anna A."],
      ["b@cp.ru", "Boris B."],
      ["c@cp.ru", ""],
    ]);
    expect(names.get("a@cp.ru")).toBe("Анна"); // the config wins
    expect(names.get("b@cp.ru")).toBe("Boris B."); // empty config name falls back to the export
    expect(names.get("c@cp.ru")).toBe("c@cp.ru");
  });
});

describe("Python-compatible helpers", () => {
  it("strip removes what Python removes, and nothing else", () => {
    expect(pyStrip(` \t\n${ch(0xa0)}${ch(0x2003)}x y${ch(0x3000)}${ch(0x1c)}`)).toBe("x y");
    expect(pyStrip(`${ch(0xfeff)}x`)).toBe(`${ch(0xfeff)}x`); // JS trim() would remove the BOM, Python does not
    expect(normEmail("  Ivan.Ivanov@CP.ru ")).toBe("ivan.ivanov@cp.ru");
    expect(normName(null)).toBe("");
    expect(normName(Number.NaN)).toBe("");
    expect(normName(" Иванов Иван ")).toBe("Иванов Иван");
  });

  it("compares strings by code point", () => {
    expect(cmpStr("a", "b")).toBeLessThan(0);
    expect(cmpStr("b", "a")).toBeGreaterThan(0);
    expect(cmpStr("ab", "abc")).toBeLessThan(0);
    expect(cmpStr("same", "same")).toBe(0);
    expect(cmpStr("Z", "a")).toBeLessThan(0); // uppercase before lowercase
    expect(cmpStr("z", "я")).toBeLessThan(0); // Latin before Cyrillic
    const astral = String.fromCodePoint(0x1f600);
    expect(cmpStr(astral, ch(0xfffd))).toBeGreaterThan(0); // JS < would say the opposite
  });

  it("parses tariffs like int(float(v))", () => {
    expect(parseTariff("12")).toBe(12);
    expect(parseTariff(" 3 ")).toBe(3);
    expect(parseTariff(1)).toBe(1);
    expect(parseTariff("12.9")).toBe(12);
    expect(parseTariff("1e1")).toBe(10);
    expect(parseTariff(true)).toBe(1);
    for (const bad of ["", "abc", "0x10", "nan", "inf", null, undefined, Number.NaN, "1 2", "--1"]) {
      expect(parseTariff(bad), String(bad)).toBeNull();
    }
  });

  it("converts to int like Python int()", () => {
    expect(pyInt("25")).toBe(25);
    expect(pyInt(" 25 ")).toBe(25);
    expect(pyInt(7.9)).toBe(7);
    expect(pyInt(true)).toBe(1);
    expect(() => pyInt("7.5")).toThrow();
    expect(() => pyInt("abc")).toThrow();
    expect(() => pyInt(null)).toThrow();
    expect(() => pyInt(Number.NaN)).toThrow();
  });

  it("has Python truthiness", () => {
    expect([pyBool(0), pyBool(""), pyBool(null), pyBool([]), pyBool({})]).toEqual([false, false, false, false, false]);
    expect([pyBool(1), pyBool("0"), pyBool([0]), pyBool(true)]).toEqual([true, true, true, true]);
  });
});

describe("table helpers", () => {
  it("names columns the way pandas does", () => {
    expect(mangleHeader(["a", "a", null, "a", "b", "a.1"])).toEqual(["a", "a.1", "Unnamed: 2", "a.2", "b", "a.1.1"]);
  });

  it("reads the INN as text, pads short rows, keeps empty cells empty", () => {
    const table = tableFromSheet([
      ["ИНН", "x"],
      [71303241361, "a"],
      ["071303241361"],
      [null, null],
    ]);
    expect(table.rows).toEqual([
      ["71303241361", "a"],
      ["071303241361", null],
      [null, null],
    ]);
    expect(tableFromSheet([])).toEqual({ columns: [], rows: [] });
  });
});

describe("largest remainder", () => {
  it("rounds to the target sum and breaks ties by insertion order", () => {
    const out = largestRemainder(
      new Map([
        ["a", 3.5],
        ["b", 3.5],
        ["c", 3.5],
        ["d", 3.5],
      ]),
      16,
    );
    expect([...out.entries()]).toEqual([
      ["a", 4],
      ["b", 4],
      ["c", 4],
      ["d", 4],
    ]);

    const two = largestRemainder(
      new Map([
        ["x", 1.5],
        ["y", 1.5],
      ]),
      3,
    );
    expect(two.get("x")).toBe(2);
    expect(two.get("y")).toBe(1);
  });

  it("prefers the larger fractional part", () => {
    const out = largestRemainder(
      new Map([
        ["a", 1.2],
        ["b", 1.7],
        ["c", 1.1],
      ]),
      4,
    );
    expect([out.get("a"), out.get("b"), out.get("c")]).toEqual([1, 2, 1]);
  });
});
