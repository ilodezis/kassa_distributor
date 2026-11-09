// Regenerates tests/golden/*.json: small synthetic exports plus what the Python reference makes of
// them. tests/golden.test.ts checks the port against these files, so a change to a tie-breaker
// is caught in CI, where Python is not available.
//
//   node scripts/make-golden.ts [--python <path>]
//
// Only synthetic data goes in here (see tests/helpers.ts). Never put a real export into git.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import writeXlsxFile from "write-excel-file/universal";

import { COL_MANAGER, COL_STATUS, COL_TERMINATION } from "../src/core/constants.ts";
import type { Cell } from "../src/core/pystr.ts";
import type { Table } from "../src/core/table.ts";
import { type Case, col, makeCase, rng } from "../tests/helpers.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const { values } = parseArgs({ options: { python: { type: "string" } } });

function python(): string {
  const candidates = [values.python, join(ROOT, ".venv", "Scripts", "python.exe"), join(ROOT, ".venv", "bin", "python"), "python3", "python"].filter(
    (c): c is string => typeof c === "string",
  );
  for (const candidate of candidates) {
    if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-c", "import pandas, openpyxl"]);
    if (probe.status === 0) return candidate;
  }
  throw new Error("No Python with pandas and openpyxl found (see reference/requirements.txt)");
}

interface Spec {
  name: string;
  build: () => Case;
}

/** Terminated, unknown-status, odd-case rows and a mixed-case email on top of a plain case. */
function withOddRows(base: Case, seed: number): Case {
  const rnd = rng(seed);
  const rows: Cell[][] = base.table.rows.map((row) => row.slice());
  const iStatus = col(base.table, COL_STATUS);
  const iTermination = col(base.table, COL_TERMINATION);
  const iManager = col(base.table, COL_MANAGER);
  for (const row of rows) {
    const roll = rnd();
    if (roll < 0.03) row[iTermination] = "15.11.2026";
    else if (roll < 0.05) row[iStatus] = "refund";
    else if (roll < 0.08) row[iStatus] = " PAID ";
    else if (roll < 0.1) row[iManager] = ` ${String(row[iManager]).toUpperCase()} `;
  }
  return { ...base, table: { columns: base.table.columns, rows } };
}

const specs: Spec[] = [
  { name: "plain", build: () => makeCase(101, { rows: 500, support: 8, external: 3 }) },
  { name: "caps", build: () => makeCase(102, { rows: 500, support: 8, external: 3, caps: { 0: 40, 3: 55 } }) },
  { name: "paid-heavy", build: () => makeCase(103, { rows: 500, support: 6, external: 2, paidShare: 0.7 }) },
  { name: "frozen-and-odd-rows", build: () => withOddRows(makeCase(104, { rows: 500, support: 7, external: 3, caps: { 1: 50 } }), 9) },
];

async function main(): Promise<void> {
  const py = python();
  const work = mkdtempSync(join(tmpdir(), "kassa-golden-"));
  const outDir = join(ROOT, "tests", "golden");
  mkdirSync(outDir, { recursive: true });

  for (const spec of specs) {
    const { table, config } = spec.build();
    const xlsx = join(work, `${spec.name}.xlsx`);
    const blob = await writeXlsxFile([table.columns as Cell[], ...table.rows]).toBlob();
    writeFileSync(xlsx, Buffer.from(await blob.arrayBuffer()));

    const scenarios = join(work, `${spec.name}-scenarios.json`);
    const out = join(work, `${spec.name}-out.json`);
    writeFileSync(scenarios, JSON.stringify([{ name: spec.name, config }]), "utf-8");
    const run = spawnSync(py, ["-I", join(ROOT, "scripts", "reference_run.py"), join(ROOT, "reference"), xlsx, scenarios, out], {
      encoding: "utf-8",
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    const [reference] = JSON.parse(readFileSync(out, "utf-8")) as Record<string, unknown>[];

    const golden = { name: spec.name, table: table satisfies Table, config, expected: reference };
    writeFileSync(join(outDir, `${spec.name}.json`), `${JSON.stringify(golden)}\n`, "utf-8");
    console.log(`wrote tests/golden/${spec.name}.json (${table.rows.length} rows)`);
  }
  rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
