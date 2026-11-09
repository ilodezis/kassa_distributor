// Runs the Python reference and the TypeScript port on the same export and checks that
// `Почта нового менеджера` matches row by row (plus the summary, the move count and the checks log).
//
//   npm run compare -- <export.xlsx> [--config managers.json] [--stress] [--ref <git rev>]
//
// The export is real data: keep it out of git (`*.xlsx` is ignored) and pass its path here.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import writeXlsxFile from "write-excel-file/universal";

import { type ManagersConfigInput } from "../src/core/config.ts";
import { COL_MANAGER, COL_NEW_MANAGER, COL_STATUS, COL_TERMINATION } from "../src/core/constants.ts";
import { distribute } from "../src/core/distribute.ts";
import { type Cell } from "../src/core/pystr.ts";
import { type Table, managersFromTable } from "../src/core/table.ts";
import { readInputTable } from "../src/core/xlsx.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    stress: { type: "boolean", default: false },
    ref: { type: "string" },
    python: { type: "string" },
    seed: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(`Usage: npm run compare -- <export.xlsx> [options]

  --config <file>   use this managers.json as the only config (default: generated scenarios)
  --stress          also run variants of the export with many paid, terminated and odd-status rows
  --ref <git rev>   take logic.py from this commit instead of reference/ (e.g. a72f0ae)
  --python <path>   Python with pandas and openpyxl (default: .venv in the repo, then PATH)
  --seed <n>        seed of the generated scenarios (default 1)
  --keep            keep the temporary directory`);
  process.exit(values.help ? 0 : 2);
}

const exportPath = resolve(positionals[0]!);
if (!existsSync(exportPath)) {
  console.error(`Export not found: ${exportPath}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Reference setup

const work = mkdtempSync(join(tmpdir(), "kassa-compare-"));

function sh(command: string, args: string[], options: { cwd?: string } = {}) {
  return spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    ...options,
  });
}

function findPython(): string {
  const candidates = [
    values.python,
    join(ROOT, ".venv", "Scripts", "python.exe"),
    join(ROOT, ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (!existsSync(candidate)) continue;
    }
    const probe = sh(candidate, ["-c", "import pandas, openpyxl"]);
    if (probe.status === 0) return candidate;
  }
  console.error(
    "No Python with pandas and openpyxl found. Create one:\n" +
      "  python -m venv .venv && .venv/bin/pip install -r reference/requirements.txt   (Windows: .venv\\Scripts\\pip)",
  );
  process.exit(2);
}

function referenceDir(): string {
  if (!values.ref) return join(ROOT, "reference");
  const dir = join(work, "reference-at-rev");
  mkdirSync(dir);
  for (const path of ["logic.py", "reference/logic.py"]) {
    const shown = sh("git", ["show", `${values.ref}:${path}`], { cwd: ROOT });
    if (shown.status === 0) {
      writeFileSync(join(dir, "logic.py"), shown.stdout, "utf-8");
      return dir;
    }
  }
  console.error(`Cannot find logic.py at git revision ${values.ref}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Scenarios

/** Small seeded PRNG so a failing scenario can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scenario {
  name: string;
  config: ManagersConfigInput;
}

const entry = (email: string, name: string, isSupport: boolean, cap: number | null = null) => ({
  email,
  name,
  is_support: isSupport,
  has_cap: cap !== null,
  cap,
});

function buildScenarios(table: Table, seed: number): Scenario[] {
  const rnd = mulberry32(seed);
  const managers = managersFromTable(table); // [email, name]
  const rows = table.rows.length;
  const n = managers.length;
  const pick = (p: number) => managers.map(() => rnd() < p);
  const ensureTwo = (flags: boolean[]) => {
    while (flags.filter(Boolean).length < 2) flags[Math.floor(rnd() * flags.length)] = true;
    return flags;
  };

  const scenarios: Scenario[] = [];

  scenarios.push({
    name: "all-support",
    config: { managers: managers.map(([e, nm]) => entry(e, nm, true)) },
  });

  const half = ensureTwo(pick(0.5));
  scenarios.push({
    name: "random-half",
    config: { managers: managers.map(([e, nm], i) => entry(e, nm, half[i]!)) },
  });

  const most = ensureTwo(pick(0.75));
  const nMost = most.filter(Boolean).length;
  const fairMost = rows / nMost;
  scenarios.push({
    name: "caps-mixed",
    config: {
      managers: managers.map(([e, nm], i) =>
        entry(e, nm, most[i]!, most[i] && rnd() < 0.35 ? Math.max(1, Math.round(fairMost * (0.6 + rnd() * 0.55))) : null),
      ),
    },
  });

  scenarios.push({
    name: "caps-tight",
    config: { managers: managers.map(([e, nm]) => entry(e, nm, true, Math.max(1, Math.floor((rows / n) * 0.7)))) },
  });

  const few = new Set<number>();
  while (few.size < Math.min(3, n)) few.add(Math.floor(rnd() * n));
  const fewList = [...few];
  scenarios.push({
    name: "few-support",
    config: {
      managers: managers.map(([e, nm], i) =>
        entry(e, nm, few.has(i), i === fewList[0] ? Math.round(rows / 3.5) : null),
      ),
    },
  });

  // Legacy config: name-keyed entries, matched to emails by exact full name, plus one leaver.
  const legacyFlags = ensureTwo(pick(0.5));
  scenarios.push({
    name: "legacy-names",
    config: {
      version: 1,
      managers: [
        ...managers
          .map(([, nm], i) => ({ name: nm, is_support: legacyFlags[i]!, has_cap: i % 5 === 0, cap: i % 5 === 0 ? Math.round(rows / (n * 0.8)) : null }))
          .filter((_, i) => i % 7 !== 6),
        { name: "Ушедший Сотрудник", is_support: true, has_cap: false, cap: null },
      ],
    },
  });

  scenarios.push({
    name: "no-support",
    config: { managers: managers.map(([e, nm]) => entry(e, nm, false)) },
  });

  return scenarios;
}

/** Variants of the export that exercise the paid lock and the frozen rows, which a fresh export barely has. */
function stressVariants(table: Table, seed: number): { name: string; table: Table }[] {
  const rnd = mulberry32(seed + 1000);
  const iStatus = table.columns.indexOf(COL_STATUS);
  const iTermination = table.columns.indexOf(COL_TERMINATION);
  const iManager = table.columns.indexOf(COL_MANAGER);
  if (iStatus < 0) return [];

  const paid40: Table = {
    columns: table.columns,
    rows: table.rows.map((row) => {
      const copy = row.slice();
      copy[iStatus] = rnd() < 0.4 ? "paid" : "topay";
      return copy;
    }),
  };

  const mixed: Table = {
    columns: table.columns,
    rows: table.rows.map((row) => {
      const copy = row.slice();
      const roll = rnd();
      if (roll < 0.35) copy[iStatus] = rnd() < 0.5 ? "paid" : " PAID ";
      else if (roll < 0.365) copy[iStatus] = "refund";
      else if (roll < 0.375) copy[iStatus] = null;
      else copy[iStatus] = rnd() < 0.5 ? "topay" : " ToPay";
      if (iTermination >= 0 && rnd() < 0.02) copy[iTermination] = "15.11.2026";
      if (rnd() < 0.03 && typeof copy[iManager] === "string") copy[iManager] = ` ${String(copy[iManager]).toUpperCase()} `;
      return copy;
    }),
  };

  return [
    { name: "stress paid-40%", table: paid40 },
    { name: "stress mixed (paid, frozen, odd emails)", table: mixed },
  ];
}

// ---------------------------------------------------------------------------------------------
// Running

interface ReferenceResult {
  name: string;
  emails?: string[];
  summary?: Record<string, unknown>[];
  moves?: number;
  checks?: string[];
  error?: string;
}

function runReference(python: string, refDir: string, xlsxPath: string, scenarios: Scenario[], tag: string) {
  const scenariosPath = join(work, `${tag}-scenarios.json`);
  const outPath = join(work, `${tag}-reference.json`);
  writeFileSync(scenariosPath, JSON.stringify(scenarios), "utf-8");
  const started = performance.now();
  const run = sh(python, ["-I", join(ROOT, "scripts", "reference_run.py"), refDir, xlsxPath, scenariosPath, outPath]);
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    throw new Error("the Python reference failed to run");
  }
  const results = JSON.parse(readFileSync(outPath, "utf-8")) as ReferenceResult[];
  return { results, ms: performance.now() - started };
}

let totalEmailMismatches = 0;
let totalOtherMismatches = 0;
let totalScenarios = 0;

function compareScenario(label: string, table: Table, scenario: Scenario, ref: ReferenceResult) {
  totalScenarios += 1;
  const config = JSON.parse(JSON.stringify(scenario.config)) as ManagersConfigInput;

  let tsError: string | undefined;
  let ts: ReturnType<typeof distribute> | undefined;
  try {
    ts = distribute(table, config);
  } catch (error) {
    tsError = error instanceof Error ? error.message : String(error);
  }

  if (ref.error !== undefined || tsError !== undefined) {
    const same = ref.error === tsError;
    if (!same) totalOtherMismatches += 1;
    console.log(
      `${same ? "ok  " : "FAIL"} ${label} / ${scenario.name}: reference ${ref.error ? `raised "${ref.error}"` : "succeeded"}, ` +
        `port ${tsError ? `raised "${tsError}"` : "succeeded"}`,
    );
    return;
  }

  const refEmails = ref.emails!;
  const tsEmails = ts!.newManagerEmails;
  const mismatches: number[] = [];
  const length = Math.max(refEmails.length, tsEmails.length);
  for (let i = 0; i < length; i++) if (refEmails[i] !== tsEmails[i]) mismatches.push(i);

  const summaryKeys = Object.keys(ref.summary![0] ?? {});
  const summaryOk =
    ref.summary!.length === ts!.summary.length &&
    ref.summary!.every((refRow, i) =>
      summaryKeys.every((key) => (refRow[key] as unknown) === (ts!.summary[i] as unknown as Record<string, unknown>)[key]),
    );
  const checksOk = JSON.stringify(ref.checks) === JSON.stringify(ts!.checks);
  const movesOk = ref.moves === ts!.moves.length;

  totalEmailMismatches += mismatches.length;
  if (!summaryOk || !checksOk || !movesOk) totalOtherMismatches += 1;

  const ok = mismatches.length === 0 && summaryOk && checksOk && movesOk;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} / ${scenario.name}: rows=${tsEmails.length} moves=${ts!.moves.length} ` +
      `email mismatches=${mismatches.length} summary=${summaryOk ? "same" : "DIFFERENT"} ` +
      `checks=${checksOk ? "same" : "DIFFERENT"} moves=${movesOk ? "same" : `DIFFERENT (reference ${ref.moves})`}`,
  );
  for (const i of mismatches.slice(0, 8)) {
    console.log(`       row ${i + 2}: reference ${refEmails[i]} | port ${tsEmails[i]}   (${COL_NEW_MANAGER}, sheet row number)`);
  }
  if (!checksOk) {
    const a = ref.checks!;
    const b = ts!.checks;
    const at = a.findIndex((line, i) => line !== b[i]);
    console.log(`       first differing check line ${at}: reference ${JSON.stringify(a[at])} | port ${JSON.stringify(b[at])}`);
  }
}

async function main() {
  const python = findPython();
  const refDir = referenceDir();
  console.log(`export:    ${exportPath}`);
  console.log(`reference: ${values.ref ? `git ${values.ref}` : "reference/"} (${python})`);

  const bytes = readFileSync(exportPath);
  const table = await readInputTable(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  console.log(`rows:      ${table.rows.length}, managers: ${managersFromTable(table).length}\n`);

  const seed = Number(values.seed);
  let scenarios: Scenario[];
  if (values.config) {
    scenarios = [{ name: "config-file", config: JSON.parse(readFileSync(resolve(values.config), "utf-8")) as ManagersConfigInput }];
  } else {
    scenarios = buildScenarios(table, seed);
  }

  const jobs: { label: string; table: Table; xlsxPath: string }[] = [{ label: "export", table, xlsxPath: exportPath }];
  if (values.stress) {
    for (const variant of stressVariants(table, seed)) {
      const path = join(work, `${variant.name.replace(/\W+/g, "-")}.xlsx`);
      const blob = await writeXlsxFile([variant.table.columns as Cell[], ...variant.table.rows]).toBlob();
      writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
      // Read the variant back through the port's reader so both sides see the same file.
      const reread = await readInputTable(await blob.arrayBuffer());
      jobs.push({ label: variant.name, table: reread, xlsxPath: path });
    }
  }

  for (const [index, job] of jobs.entries()) {
    const { results, ms } = runReference(python, refDir, job.xlsxPath, scenarios, `job${index}`);
    console.log(`${job.label}: reference ran ${scenarios.length} scenarios in ${(ms / 1000).toFixed(1)}s`);
    const started = performance.now();
    scenarios.forEach((scenario, i) => compareScenario(job.label, job.table, scenario, results[i]!));
    console.log(`  (port: ${((performance.now() - started) / 1000).toFixed(1)}s)\n`);
  }

  console.log(
    `${totalScenarios} runs: ${totalEmailMismatches} row mismatches in "${COL_NEW_MANAGER}", ` +
      `${totalOtherMismatches} other differences (summary / checks / moves / errors).`,
  );
  if (values.keep) console.log(`kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
  process.exit(totalEmailMismatches === 0 && totalOtherMismatches === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
