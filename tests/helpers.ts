// Synthetic exports for the tests. No real data: names and emails are generated.

import type { ManagersConfigInput } from "../src/core/config.ts";
import {
  COL_INN,
  COL_MANAGER,
  COL_MANAGER_NAME,
  COL_STATUS,
  COL_TARIFF,
  COL_TERMINATION,
  VALID_TARIFFS,
} from "../src/core/constants.ts";
import type { Cell } from "../src/core/pystr.ts";
import type { Table } from "../src/core/table.ts";

export const COLUMNS = [COL_MANAGER_NAME, COL_MANAGER, COL_INN, COL_TARIFF, COL_STATUS, COL_TERMINATION];

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choose<T>(rnd: () => number, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

export interface Case {
  table: Table;
  config: ManagersConfigInput;
  supportNames: string[];
  externalNames: string[];
}

/** An export with a skewed load, which is exactly what the distribution has to even out. */
export function makeCase(
  seed: number,
  options: { rows?: number; support?: number; external?: number; caps?: Record<number, number>; paidShare?: number } = {},
): Case {
  const { rows = 1200, support = 10, external = 3, caps = {}, paidShare = 0.4 } = options;
  const rnd = rng(seed);
  const supportNames = Array.from({ length: support }, (_, i) => `support${String(i).padStart(2, "0")}@cp.ru`);
  const externalNames = Array.from({ length: external }, (_, i) => `sales${String(i).padStart(2, "0")}@cp.ru`);

  const weights = supportNames.map(() => 6 ** rnd());
  const supportWeight = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < external; i++) weights.push((supportWeight * 0.25) / Math.max(external, 1));

  const everyone = [...supportNames, ...externalNames];
  const data: Cell[][] = [];
  for (let i = 0; i < rows; i++) {
    const email = choose(rnd, everyone, weights);
    const local = email.split("@")[0]!;
    data.push([
      local.charAt(0).toUpperCase() + local.slice(1),
      email,
      String(i).padStart(12, "0"),
      choose(rnd, VALID_TARIFFS, [0.6, 0.25, 0.15]),
      rnd() < paidShare ? "paid" : "topay",
      null,
    ]);
  }

  const config: ManagersConfigInput = {
    managers: [
      ...supportNames.map((email, i) => {
        const cap = caps[i];
        return { email, name: email, is_support: true, has_cap: cap !== undefined, cap: cap ?? null };
      }),
      ...externalNames.map((email) => ({ email, name: email, is_support: false, has_cap: false, cap: null })),
    ],
  };
  return { table: { columns: COLUMNS.slice(), rows: data }, config, supportNames, externalNames };
}

export function col(table: Table, name: string): number {
  const index = table.columns.indexOf(name);
  if (index < 0) throw new Error(`no column ${name}`);
  return index;
}
