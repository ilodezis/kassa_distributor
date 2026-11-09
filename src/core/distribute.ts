// The two-stage allocation of cash registers between support managers.
//
// This is a line-by-line port of the reference implementation (`reference/logic.py`).
// The result must match it row by row, so the traversal order of rows and managers and every
// tie-breaker (largest remainder, stage 1 choice of the receiver, stage 2 pair order) are kept
// exactly as they are there. Do not "improve" an ordering here without re-running
// `npm run compare` against the reference.

import {
  type ManagersConfigInput,
  type ManagersConfig,
  ensureManagersPresent,
  getCapMap,
  getNameMap,
  getSupportManagers,
  getSupportWithoutEmail,
} from "./config.ts";
import {
  BIG_CAP,
  COL_INN,
  COL_NEW_MANAGER,
  COL_NEW_MANAGER_NAME,
  MAX_SWAP_PASSES,
  PERIOD_TOLERANCE,
  TOTAL_TOLERANCE,
  VALID_TARIFFS,
  type Tariff,
  isTariff,
} from "./constants.ts";
import { type Cell, cmpStr, hasEffectiveCap } from "./pystr.ts";
import {
  type PreparedRow,
  type PreparedTable,
  type Table,
  managersFromTable,
  validateAndPrepare,
} from "./table.ts";

export type PerTariff = Record<Tariff, number>;
export type Shares = Record<Tariff, number>;

export interface SummaryRow {
  name: string;
  manager: string;
  has_cap: boolean;
  cap_value: number | "";
  locked_paid: number;
  target_total: number;
  fact_total: number;
  delta_total: number;
  target_1: number;
  fact_1: number;
  delta_1: number;
  target_3: number;
  fact_3: number;
  delta_3: number;
  target_12: number;
  fact_12: number;
  delta_12: number;
}

export interface MoveRow {
  inn: Cell;
  old_manager: string;
  new_manager: string;
  tariff: number | null;
  paid: number;
}

export interface ChartPoint {
  manager: string;
  fact_total: number;
  target_total: number;
}

export interface DistributionResult {
  /** The export with `Почта нового менеджера` and `Новый менеджер` added, in the original row order. */
  output: Table;
  /** `Почта нового менеджера` per input row, in the original row order. */
  newManagerEmails: string[];
  summary: SummaryRow[];
  moves: MoveRow[];
  checks: string[];
  chart: ChartPoint[];
  managersConfig: ManagersConfig;
}

const zeroTariffs = (): PerTariff => ({ 1: 0, 3: 0, 12: 0 });

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal error: missing map entry");
  return value;
}

/** Rows grouped by (manager, tariff): {total per manager, per-tariff counts per manager}. */
export function countFromAssignment(
  pairs: Iterable<readonly [string, number | null]>,
  supportManagers: readonly string[],
): { total: Map<string, number>; periods: Map<string, PerTariff> } {
  const total = new Map<string, number>(supportManagers.map((m) => [m, 0]));
  const periods = new Map<string, PerTariff>(supportManagers.map((m) => [m, zeroTariffs()]));
  for (const [manager, tariff] of pairs) {
    const byTariff = periods.get(manager);
    if (byTariff === undefined || !isTariff(tariff)) continue;
    total.set(manager, required(total.get(manager)) + 1);
    byTariff[tariff] += 1;
  }
  return { total, periods };
}

/** Rounds fractional values to integers so that they sum to `targetSum` (largest remainder). */
export function largestRemainder(values: Map<string, number>, targetSum: number): Map<string, number> {
  const floors = new Map<string, number>();
  let floorSum = 0;
  for (const [key, value] of values) {
    const floor = Math.floor(value);
    floors.set(key, floor);
    floorSum += floor;
  }
  let remainder = targetSum - floorSum;

  // Stable, descending by the fractional part: ties keep insertion order, as Python's sorted().
  const order = [...values.keys()].sort(
    (a, b) =>
      values.get(b)! - required(floors.get(b)) - (values.get(a)! - required(floors.get(a))),
  );
  const result = new Map(floors);
  for (const key of order) {
    if (remainder <= 0) break;
    result.set(key, required(result.get(key)) + 1);
    remainder -= 1;
  }
  return result;
}

/** Tariff shares across all rows that take part in the distribution. */
export function globalTariffShares(work: readonly PreparedRow[]): Shares {
  const total = work.length;
  if (total === 0) return { 1: 1 / 3, 3: 1 / 3, 12: 1 / 3 };
  const counts = zeroTariffs();
  for (const row of work) if (isTariff(row.tariff)) counts[row.tariff] += 1;
  return { 1: counts[1] / total, 3: counts[3] / total, 12: counts[12] / total };
}

/** How many registers each support manager should end up with. */
export function computeTotalTargets(
  totalRows: number,
  supportManagers: readonly string[],
  capMap: ReadonlyMap<string, number | null>,
  lockedTotal: ReadonlyMap<string, number>,
): Map<string, number> {
  const n = supportManagers.length;
  if (n === 0) return new Map();

  const fairShare = totalRows / n;
  const rawTarget = new Map<string, number>();
  for (const manager of supportManagers) {
    const cap = capMap.get(manager) ?? null;
    let base = fairShare;
    if (hasEffectiveCap(cap)) base = Math.min(base, cap);
    base = Math.max(base, lockedTotal.get(manager) ?? 0);
    rawTarget.set(manager, base);
  }

  // Fit the rounded targets to totalRows.
  const targets = largestRemainder(rawTarget, totalRows);

  let currentSum = 0;
  for (const value of targets.values()) currentSum += value;

  if (currentSum < totalRows) {
    let diff = totalRows - currentSum;
    const capped = (m: string) => (hasEffectiveCap(capMap.get(m) ?? null) ? 1 : 0);
    const ordered = [...supportManagers].sort(
      (a, b) =>
        capped(a) - capped(b) ||
        required(targets.get(a)) - required(targets.get(b)) ||
        cmpStr(a, b),
    );
    let changed = true;
    while (diff > 0 && changed) {
      changed = false;
      for (const manager of ordered) {
        if (diff <= 0) break;
        const cap = capMap.get(manager) ?? null;
        const hardLimit = hasEffectiveCap(cap) ? cap + TOTAL_TOLERANCE : BIG_CAP;
        if (required(targets.get(manager)) < hardLimit) {
          targets.set(manager, required(targets.get(manager)) + 1);
          diff -= 1;
          changed = true;
        }
      }
    }
  } else if (currentSum > totalRows) {
    let diff = currentSum - totalRows;
    const ordered = [...supportManagers].sort(
      (a, b) => required(targets.get(b)) - required(targets.get(a)) || cmpStr(b, a),
    );
    let changed = true;
    while (diff > 0 && changed) {
      changed = false;
      for (const manager of ordered) {
        if (diff <= 0) break;
        const floor = lockedTotal.get(manager) ?? 0;
        if (required(targets.get(manager)) > floor) {
          targets.set(manager, required(targets.get(manager)) - 1);
          diff -= 1;
          changed = true;
        }
      }
    }
  }

  return targets;
}

/** Per-tariff targets of each manager: their total split by the global tariff shares. */
export function computeTargetPeriods(
  totalTargets: ReadonlyMap<string, number>,
  shares: Shares,
): Map<string, PerTariff> {
  const result = new Map<string, PerTariff>();
  for (const [manager, totalTarget] of totalTargets) {
    const raw: PerTariff = {
      1: totalTarget * shares[1],
      3: totalTarget * shares[3],
      12: totalTarget * shares[12],
    };
    const floors: PerTariff = {
      1: Math.floor(raw[1]),
      3: Math.floor(raw[3]),
      12: Math.floor(raw[12]),
    };
    let rem = totalTarget - (floors[1] + floors[3] + floors[12]);
    const order: Tariff[] = [...VALID_TARIFFS].sort(
      (a, b) => raw[b] - floors[b] - (raw[a] - floors[a]),
    );

    const final: PerTariff = { ...floors };
    for (const tariff of order) {
      if (rem <= 0) break;
      final[tariff] += 1;
      rem -= 1;
    }
    result.set(manager, final);
  }
  return result;
}

function periodPenalty(actual: number, target: number): number {
  const diff = actual - target;
  return diff * diff;
}

/**
 * Stage 1: every support manager gets exactly `totalTargets[m]` registers.
 *
 * The free pool equals the total shortfall by construction, so the allocation always
 * converges and the spread of totals is zero. This is arithmetic, not optimisation.
 * The tariff only works as a tie-breaker here; stage 2 fixes the mix.
 *
 * Returns the new manager of every row of `work` (same order).
 */
export function exactTotalFill(
  work: readonly PreparedRow[],
  supportManagers: readonly string[],
  totalTargets: ReadonlyMap<string, number>,
  periodTargets: ReadonlyMap<string, PerTariff>,
): string[] {
  const assigned = work.map((row) => row.manager);
  const supportSet = new Set(supportManagers);
  const locked = work.map((row) => supportSet.has(row.manager) && row.paid === 1);

  const counts = new Map<string, number>(supportManagers.map((m) => [m, 0]));
  const perTariff = new Map<string, PerTariff>(supportManagers.map((m) => [m, zeroTariffs()]));

  for (let i = 0; i < work.length; i++) {
    if (!locked[i]) continue;
    const manager = assigned[i]!;
    counts.set(manager, required(counts.get(manager)) + 1);
    required(perTariff.get(manager))[work[i]!.tariff as Tariff] += 1;
  }

  // Minimum migrations: whoever already sits on a support manager and fits the target stays.
  const pool: number[] = [];
  for (let i = 0; i < work.length; i++) {
    if (locked[i]) continue;
    const current = assigned[i]!;
    if (counts.has(current) && required(counts.get(current)) < required(totalTargets.get(current))) {
      counts.set(current, required(counts.get(current)) + 1);
      required(perTariff.get(current))[work[i]!.tariff as Tariff] += 1;
    } else {
      pool.push(i);
    }
  }

  const byTariff: Record<Tariff, number[]> = { 1: [], 3: [], 12: [] };
  for (const i of pool) byTariff[work[i]!.tariff as Tariff].push(i);

  const deficit = new Map<string, number>(
    supportManagers.map((m) => [m, required(totalTargets.get(m)) - required(counts.get(m))]),
  );

  // Rare tariffs first, otherwise there is nothing to choose from at the end.
  const tariffOrder = [...VALID_TARIFFS].sort((a, b) => byTariff[a].length - byTariff[b].length);

  for (const tariff of tariffOrder) {
    for (const i of byTariff[tariff]) {
      const candidates = supportManagers.filter((m) => required(deficit.get(m)) > 0);
      let best: string;
      if (candidates.length > 0) {
        // Who needs this tariff more; on a tie, whose overall shortfall is larger; then the larger email.
        const key = (m: string): [number, number] => [
          required(periodTargets.get(m))[tariff] - required(perTariff.get(m))[tariff],
          required(deficit.get(m)),
        ];
        best = candidates[0]!;
        let bestKey = key(best);
        for (let c = 1; c < candidates.length; c++) {
          const m = candidates[c]!;
          const k = key(m);
          if (k[0] > bestKey[0] || (k[0] === bestKey[0] && (k[1] > bestKey[1] || (k[1] === bestKey[1] && cmpStr(m, best) > 0)))) {
            best = m;
            bestKey = k;
          }
        }
      } else {
        // The targets did not hold everything (every cap is too low). The register is not lost:
        // it goes to the least loaded manager. The checks log will show it.
        best = supportManagers[0]!;
        for (let c = 1; c < supportManagers.length; c++) {
          const m = supportManagers[c]!;
          const a = required(counts.get(m));
          const b = required(counts.get(best));
          if (a < b || (a === b && cmpStr(m, best) < 0)) best = m;
        }
      }

      assigned[i] = best;
      counts.set(best, required(counts.get(best)) + 1);
      required(perTariff.get(best))[tariff] += 1;
      deficit.set(best, required(deficit.get(best)) - 1);
    }
  }

  return assigned;
}

/**
 * Stage 2: fixes the tariff mix with pairwise swaps only.
 *
 * Manager A gives a register of tariff X, B gives one of tariff Y. Both keep their number
 * of registers, so stage 2 cannot spoil the totals set by stage 1. Only unpaid registers move.
 *
 * Returns the new manager of every row of `work` (same order).
 */
export function tariffSwaps(
  work: readonly PreparedRow[],
  assignedIn: readonly string[],
  supportManagers: readonly string[],
  periodTargets: ReadonlyMap<string, PerTariff>,
  maxPasses: number = MAX_SWAP_PASSES,
): string[] {
  const assigned = assignedIn.slice();
  const supportSet = new Set(supportManagers);

  const rows = new Map<string, Record<Tariff, number[]>>(
    supportManagers.map((m) => [m, { 1: [], 3: [], 12: [] }]),
  );
  const counts = new Map<string, PerTariff>(supportManagers.map((m) => [m, zeroTariffs()]));
  for (let i = 0; i < work.length; i++) {
    const manager = assigned[i]!;
    if (!supportSet.has(manager)) continue;
    const tariff = work[i]!.tariff as Tariff;
    required(counts.get(manager))[tariff] += 1;
    if (work[i]!.paid === 0) required(rows.get(manager))[tariff].push(i);
  }

  const penalty = (manager: string, tariff: Tariff, delta = 0): number =>
    periodPenalty(
      required(counts.get(manager))[tariff] + delta,
      required(periodTargets.get(manager))[tariff],
    );

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (const donor of supportManagers) {
      for (const taker of supportManagers) {
        if (taker === donor) continue;

        for (const give of VALID_TARIFFS) {
          for (const take of VALID_TARIFFS) {
            if (take === give) continue;

            const donorGive = required(rows.get(donor))[give];
            const takerTake = required(rows.get(taker))[take];
            while (donorGive.length > 0 && takerTake.length > 0) {
              const before =
                penalty(donor, give) + penalty(donor, take) + penalty(taker, give) + penalty(taker, take);
              const after =
                penalty(donor, give, -1) +
                penalty(donor, take, +1) +
                penalty(taker, give, +1) +
                penalty(taker, take, -1);
              if (after >= before) break;

              const given = donorGive.pop()!;
              const taken = takerTake.pop()!;
              assigned[given] = taker;
              assigned[taken] = donor;
              required(rows.get(taker))[give].push(given);
              required(rows.get(donor))[take].push(taken);

              required(counts.get(donor))[give] -= 1;
              required(counts.get(donor))[take] += 1;
              required(counts.get(taker))[give] += 1;
              required(counts.get(taker))[take] -= 1;
              improved = true;
            }
          }
        }
      }
    }

    if (!improved) break;
  }

  return assigned;
}

function buildSummary(
  work: readonly PreparedRow[],
  assigned: readonly string[],
  supportManagers: readonly string[],
  capMap: ReadonlyMap<string, number | null>,
  totalTargets: ReadonlyMap<string, number>,
  periodTargets: ReadonlyMap<string, PerTariff>,
  nameMap: ReadonlyMap<string, string>,
): SummaryRow[] {
  const { total, periods } = countFromAssignment(
    work.map((row, i) => [assigned[i]!, row.tariff] as const),
    supportManagers,
  );
  const supportSet = new Set(supportManagers);
  const { total: lockedTotal } = countFromAssignment(
    work.flatMap((row, i) =>
      supportSet.has(assigned[i]!) && row.paid === 1 ? [[assigned[i]!, row.tariff] as const] : [],
    ),
    supportManagers,
  );

  const rows: SummaryRow[] = supportManagers.map((manager) => {
    const cap = capMap.get(manager) ?? null;
    const target = required(periodTargets.get(manager));
    const fact = required(periods.get(manager));
    const factTotal = required(total.get(manager));
    const targetTotal = required(totalTargets.get(manager));
    return {
      name: nameMap.get(manager) ?? manager,
      manager,
      has_cap: hasEffectiveCap(cap),
      cap_value: hasEffectiveCap(cap) ? cap : "",
      locked_paid: lockedTotal.get(manager) ?? 0,
      target_total: targetTotal,
      fact_total: factTotal,
      delta_total: factTotal - targetTotal,
      target_1: target[1],
      fact_1: fact[1],
      delta_1: fact[1] - target[1],
      target_3: target[3],
      fact_3: fact[3],
      delta_3: fact[3] - target[3],
      target_12: target[12],
      fact_12: fact[12],
      delta_12: fact[12] - target[12],
    };
  });

  // has_cap descending, then name ascending; a stable sort keeps the manager order on ties.
  return rows.sort((a, b) => Number(b.has_cap) - Number(a.has_cap) || cmpStr(a.name, b.name));
}

function buildChecks(
  work: readonly PreparedRow[],
  assigned: readonly string[],
  summary: readonly SummaryRow[],
  supportManagers: readonly string[],
  capMap: ReadonlyMap<string, number | null>,
): string[] {
  const checks: string[] = [];
  const supportSet = new Set(supportManagers);
  const yesNo = (ok: boolean) => (ok ? "ДА" : "НЕТ");

  checks.push(`Всего строк: ${work.length}`);
  checks.push(`Всего support-менеджеров: ${supportManagers.length}`);

  checks.push(`Все строки в итоге на support: ${yesNo(assigned.every((m) => supportSet.has(m)))}`);

  const untouched = work.every(
    (row, i) => !(supportSet.has(row.manager) && row.paid === 1) || assigned[i] === row.manager,
  );
  checks.push(`Paid на support не тронуты: ${yesNo(untouched)}`);

  const movedOk = work.every(
    (row, i) => supportSet.has(row.manager) || row.paid !== 1 || supportSet.has(assigned[i]!),
  );
  checks.push(`Paid с non-support перенесены на support: ${yesNo(movedOk)}`);

  let capOk = true;
  for (const row of summary) {
    const cap = capMap.get(row.manager) ?? null;
    if (hasEffectiveCap(cap) && row.fact_total > cap + TOTAL_TOLERANCE) {
      capOk = false;
      checks.push(`ПРЕВЫШЕН CAP+${TOTAL_TOLERANCE}: ${row.name} -> факт ${row.fact_total}, cap ${cap}`);
    }
  }
  if (capOk) checks.push(`Все cap соблюдены с допуском +${TOTAL_TOLERANCE}: ДА`);

  const worstTotal = Math.max(...summary.map((row) => Math.abs(row.delta_total)));
  checks.push(
    `Все total в допуске ±${TOTAL_TOLERANCE}: ${yesNo(worstTotal <= TOTAL_TOLERANCE)} ` +
      `(макс. отклонение ${worstTotal})`,
  );

  const worstPeriod = Math.max(
    ...summary.flatMap((row) => [
      Math.abs(row.delta_1),
      Math.abs(row.delta_3),
      Math.abs(row.delta_12),
    ]),
  );
  checks.push(
    `Все тарифы в допуске ±${PERIOD_TOLERANCE}: ${yesNo(worstPeriod <= PERIOD_TOLERANCE)} ` +
      `(макс. отклонение ${worstPeriod})`,
  );

  return checks;
}

function frozenChecks(frozen: readonly PreparedRow[], innIndex: number): string[] {
  if (frozen.length === 0) return ["Замороженных касс (расторжение / неизвестный статус): 0"];

  const lines = [
    `Замороженных касс (расторжение / неизвестный статус), не распределены: ${frozen.length}`,
  ];
  for (const row of frozen) {
    let inn = "";
    if (innIndex >= 0) {
      const cell = row.cells[innIndex];
      inn = cell === null || cell === undefined ? "nan" : String(cell);
    }
    lines.push(`  ИНН ${inn} — ${row.managerName}: ${row.frozen}`);
  }
  return lines;
}

/** Everything the app needs from a distribution run. */
export function distribute(table: Table, config: ManagersConfigInput): DistributionResult {
  const prepared: PreparedTable = validateAndPrepare(table);
  const preparedAsTable: Table = {
    columns: prepared.columns,
    rows: prepared.rows.map((row) => row.cells),
  };

  const pairs = managersFromTable(preparedAsTable);
  const managersConfig = ensureManagersPresent(config, pairs);

  const supportManagers = getSupportManagers(managersConfig);
  if (supportManagers.length === 0) {
    throw new Error("В конфиге нет ни одного support-менеджера с почтой.");
  }

  const capMap = getCapMap(managersConfig);
  const nameMap = getNameMap(managersConfig, pairs);
  const nameOf = (email: string) => nameMap.get(email) ?? email;

  // Frozen rows (terminated, unknown status) stay where they are and skip balancing.
  const workIndexes: number[] = [];
  prepared.rows.forEach((row, i) => {
    if (row.frozen === "") workIndexes.push(i);
  });
  const work = workIndexes.map((i) => prepared.rows[i]!);
  const frozen = prepared.rows.filter((row) => row.frozen !== "");

  const supportSet = new Set(supportManagers);
  const { total: lockedTotal } = countFromAssignment(
    work.filter((row) => supportSet.has(row.manager) && row.paid === 1).map((row) => [row.manager, row.tariff] as const),
    supportManagers,
  );

  const totalTargets = computeTotalTargets(work.length, supportManagers, capMap, lockedTotal);
  const shares = globalTariffShares(work);
  const periodTargets = computeTargetPeriods(totalTargets, shares);

  // Stage 1: hit the target exactly on the number of registers.
  const filled = exactTotalFill(work, supportManagers, totalTargets, periodTargets);
  // Stage 2: fix the tariff mix with swaps; the totals do not change.
  const assigned = tariffSwaps(work, filled, supportManagers, periodTargets);

  const summary = buildSummary(work, assigned, supportManagers, capMap, totalTargets, periodTargets, nameMap);

  const innIndex = prepared.columns.indexOf(COL_INN);
  const moves: MoveRow[] = [];
  work.forEach((row, i) => {
    if (row.manager === assigned[i]) return;
    moves.push({
      inn: innIndex >= 0 ? (row.cells[innIndex] ?? null) : "",
      old_manager: row.managerName,
      new_manager: nameOf(assigned[i]!),
      tariff: row.tariff,
      paid: row.paid,
    });
  });

  const checks = buildChecks(work, assigned, summary, supportManagers, capMap);
  checks.push(...frozenChecks(frozen, innIndex));
  const withoutEmail = getSupportWithoutEmail(managersConfig);
  if (withoutEmail.length > 0) {
    checks.push("Support без почты, в раскладке не участвуют: " + withoutEmail.join(", "));
  }

  // Back to the original row order: frozen rows keep their manager.
  const newManagerEmails = prepared.rows.map((row) => row.manager);
  workIndexes.forEach((originalIndex, k) => {
    newManagerEmails[originalIndex] = assigned[k]!;
  });

  // The new columns overwrite same-named input columns in place, otherwise they are appended.
  const columns = prepared.columns.slice();
  let emailColumn = columns.indexOf(COL_NEW_MANAGER);
  if (emailColumn < 0) emailColumn = columns.push(COL_NEW_MANAGER) - 1;
  let nameColumn = columns.indexOf(COL_NEW_MANAGER_NAME);
  if (nameColumn < 0) nameColumn = columns.push(COL_NEW_MANAGER_NAME) - 1;
  const outputRows = prepared.rows.map((row, i) => {
    const cells: Cell[] = columns.map((_, c) => row.cells[c] ?? null);
    cells[emailColumn] = newManagerEmails[i]!;
    cells[nameColumn] = nameOf(newManagerEmails[i]!);
    return cells;
  });

  return {
    output: { columns, rows: outputRows },
    newManagerEmails,
    summary,
    moves,
    checks,
    chart: summary.map((row) => ({
      manager: row.name,
      fact_total: row.fact_total,
      target_total: row.target_total,
    })),
    managersConfig,
  };
}
