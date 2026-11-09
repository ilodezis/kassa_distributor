// Columns of the renewal-distribution export. A manager is identified by email:
// the full name drifts between exports (word order, login instead of name), email does not.
export const COL_MANAGER = "Почта текущего менеджера";
export const COL_MANAGER_NAME = "ФИО текущего менеджера";
export const COL_INN = "ИНН";
export const COL_TARIFF = "Тариф";
export const COL_STATUS = "Статус оплаты";
export const COL_TERMINATION = "Дата расторжения";

// Added to the result
export const COL_NEW_MANAGER = "Почта нового менеджера";
export const COL_NEW_MANAGER_NAME = "Новый менеджер";

// Internal columns of the reference implementation, dropped from the result
export const COL_PAID = "_paid";
export const COL_FROZEN = "_frozen_reason";

export const STATUS_PAID = "paid";
export const KNOWN_STATUSES: readonly string[] = ["paid", "topay"];

export const VALID_TARIFFS = [1, 3, 12] as const;
export type Tariff = (typeof VALID_TARIFFS)[number];

// Tolerances are report thresholds in the checks log and headroom above a cap when targets
// are computed. They do not enter the allocation itself: stage 1 hits every total exactly,
// stage 2 minimises the tariff deviation without a dead zone.
export const TOTAL_TOLERANCE = 5;
export const PERIOD_TOLERANCE = 3;
export const BIG_CAP = 10 ** 9;

export const MAX_SWAP_PASSES = 200;

export const FROZEN_TERMINATED = "расторжение";

export function isTariff(value: number | null | undefined): value is Tariff {
  return value === 1 || value === 3 || value === 12;
}
