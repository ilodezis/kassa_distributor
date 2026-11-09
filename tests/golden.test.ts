// Frozen expectations for small synthetic exports, originally produced by the Python
// implementation this app was ported from. Update them by hand only when the distribution
// rules change on purpose.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ManagersConfigInput } from "../src/core/config.ts";
import { distribute } from "../src/core/distribute.ts";
import type { Table } from "../src/core/table.ts";

interface Golden {
  name: string;
  table: Table;
  config: ManagersConfigInput;
  expected: {
    emails: string[];
    summary: Record<string, unknown>[];
    moves: number;
    checks: string[];
  };
}

const dir = fileURLToPath(new URL("./golden/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("golden files", () => {
  it("are present", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of files) {
    const golden = JSON.parse(readFileSync(dir + file, "utf-8")) as Golden;

    it(`${golden.name}: same new manager for every row, same summary, moves and checks`, () => {
      const result = distribute(golden.table, golden.config);

      expect(result.newManagerEmails).toEqual(golden.expected.emails);
      expect(result.summary.map((row) => ({ ...row }))).toEqual(golden.expected.summary);
      expect(result.moves.length).toBe(golden.expected.moves);
      expect(result.checks).toEqual(golden.expected.checks);
    });
  }
});
