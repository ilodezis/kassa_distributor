import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import pandas as pd


COL_MANAGER = "Менеджер"
COL_TARIFF = "Тариф"
COL_PAID = "Оплачен ИНН"
COL_NEW_MANAGER = "Новый менеджер"

VALID_TARIFFS = (1, 3, 12)

TOTAL_TOLERANCE = 5
PERIOD_TOLERANCE = 3
BIG_CAP = 10**9

EXTERNAL_PERIOD_WEIGHT = 4.0
EXTERNAL_TOTAL_WEIGHT = 2.0
INTERNAL_PERIOD_WEIGHT = 3.0
INTERNAL_TOTAL_WEIGHT = 2.5
CAPPED_PERIOD_FACTOR = 2.5

MAX_INTERNAL_ITERATIONS = 5000


@dataclass
class DistributionResult:
    output_df: pd.DataFrame
    summary_df: pd.DataFrame
    moves_df: pd.DataFrame
    checks: List[str]
    chart_df: pd.DataFrame
    managers_config: Dict


def resource_path(filename: str) -> str:
    if getattr(sys, "frozen", False):
        base_dir = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, filename)


def default_config_path() -> str:
    return resource_path("managers.json")


def _default_config() -> Dict:
    return {"version": 1, "managers": []}


def load_managers_config(path: Optional[str] = None) -> Dict:
    path = path or default_config_path()
    if not os.path.exists(path):
        data = _default_config()
        save_managers_config(data, path)
        return data

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if not isinstance(raw, dict):
        raw = _default_config()

    items = raw.get("managers", [])
    if not isinstance(items, list):
        items = []

    normalized = []
    seen = set()

    for item in items:
        if not isinstance(item, dict):
            continue

        name = str(item.get("name", "")).strip()
        if not name or name.lower() in seen:
            continue

        is_support = bool(item.get("is_support", False))
        has_cap = bool(item.get("has_cap", item.get("cap") not in (None, "", 0)))

        cap = None
        if has_cap and item.get("cap") not in (None, ""):
            try:
                cap = int(item["cap"])
            except Exception:
                cap = None

        normalized.append(
            {
                "name": name,
                "is_support": is_support,
                "has_cap": bool(cap is not None) if has_cap else False,
                "cap": cap if has_cap and cap is not None else None,
            }
        )
        seen.add(name.lower())

    return {"version": 1, "managers": normalized}


def save_managers_config(data: Dict, path: Optional[str] = None) -> None:
    path = path or default_config_path()
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    out = {"version": 1, "managers": []}
    seen = set()

    for item in data.get("managers", []):
        name = str(item.get("name", "")).strip()
        if not name or name.lower() in seen:
            continue

        is_support = bool(item.get("is_support", False))
        has_cap = bool(item.get("has_cap", item.get("cap") not in (None, "", 0)))

        cap = None
        if has_cap and item.get("cap") not in (None, ""):
            cap = int(item["cap"])

        out["managers"].append(
            {
                "name": name,
                "is_support": is_support,
                "has_cap": bool(cap is not None) if has_cap else False,
                "cap": cap if has_cap and cap is not None else None,
            }
        )
        seen.add(name.lower())

    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def ensure_managers_present(config: Dict, managers_from_df: List[str]) -> Dict:
    result = {"version": 1, "managers": [dict(x) for x in config.get("managers", [])]}
    existing = {str(x.get("name", "")).strip().lower() for x in result["managers"]}

    for name in sorted({str(x).strip() for x in managers_from_df if str(x).strip()}):
        if name.lower() not in existing:
            result["managers"].append(
                {
                    "name": name,
                    "is_support": False,
                    "has_cap": False,
                    "cap": None,
                }
            )

    result["managers"] = sorted(result["managers"], key=lambda x: x["name"].lower())
    return result


def get_support_managers(config: Dict) -> List[str]:
    return [x["name"] for x in config.get("managers", []) if x.get("is_support")]


def get_cap_map(config: Dict) -> Dict[str, Optional[int]]:
    out = {}
    for item in config.get("managers", []):
        name = item.get("name")
        if not name:
            continue
        if item.get("has_cap") and item.get("cap") not in (None, ""):
            out[name] = int(item["cap"])
        else:
            out[name] = None
    return out


def _validate_and_prepare_df(df: pd.DataFrame) -> pd.DataFrame:
    missing = [c for c in (COL_MANAGER, COL_TARIFF, COL_PAID) if c not in df.columns]
    if missing:
        raise ValueError(f"В файле нет обязательных колонок: {', '.join(missing)}")

    out = df.copy()
    out[COL_MANAGER] = out[COL_MANAGER].astype(str).str.strip()

    def parse_tariff(v):
        if pd.isna(v):
            return None
        try:
            return int(float(v))
        except Exception:
            return None

    def parse_paid(v):
        if pd.isna(v):
            return 0
        try:
            return 1 if int(float(v)) == 1 else 0
        except Exception:
            return 0

    out[COL_TARIFF] = out[COL_TARIFF].apply(parse_tariff)
    out[COL_PAID] = out[COL_PAID].apply(parse_paid)

    bad = out[~out[COL_TARIFF].isin(VALID_TARIFFS)]
    if not bad.empty:
        raise ValueError("Обнаружены строки с некорректным тарифом. Допустимы только 1, 3, 12.")

    if (out[COL_MANAGER] == "").any():
        raise ValueError("Есть строки с пустым менеджером.")

    return out


def _count_from_assignment(
    df: pd.DataFrame,
    manager_col: str,
    support_managers: List[str],
) -> Tuple[Dict[str, int], Dict[str, Dict[int, int]]]:
    total = {m: 0 for m in support_managers}
    periods = {m: {1: 0, 3: 0, 12: 0} for m in support_managers}

    if df.empty:
        return total, periods

    grouped = df.groupby([manager_col, COL_TARIFF]).size()
    for (manager, tariff), count in grouped.items():
        if manager in total and int(tariff) in VALID_TARIFFS:
            total[manager] += int(count)
            periods[manager][int(tariff)] += int(count)
    return total, periods


def _largest_remainder(values: Dict[str, float], target_sum: int) -> Dict[str, int]:
    floors = {k: int(math.floor(v)) for k, v in values.items()}
    remainder = target_sum - sum(floors.values())

    order = sorted(values.keys(), key=lambda k: values[k] - floors[k], reverse=True)
    result = dict(floors)
    for k in order:
        if remainder <= 0:
            break
        result[k] += 1
        remainder -= 1
    return result


def _global_tariff_shares(df: pd.DataFrame) -> Dict[int, float]:
    total = len(df)
    if total == 0:
        return {1: 1 / 3, 3: 1 / 3, 12: 1 / 3}

    counts = df[COL_TARIFF].value_counts().to_dict()
    return {
        1: counts.get(1, 0) / total,
        3: counts.get(3, 0) / total,
        12: counts.get(12, 0) / total,
    }


def _compute_total_targets(
    total_rows: int,
    support_managers: List[str],
    cap_map: Dict[str, Optional[int]],
    locked_total: Dict[str, int],
) -> Dict[str, int]:
    # capped целимся в min(справедливую долю, cap), но допускаем потом ребаланс в пределах +5.
    n = len(support_managers)
    if n == 0:
        return {}

    fair_share = total_rows / n
    raw_target = {}

    for manager in support_managers:
        cap = cap_map.get(manager)
        base = fair_share
        if cap not in (None, 0):
            base = min(base, int(cap))
        base = max(base, locked_total.get(manager, 0))
        raw_target[manager] = base

    # подгоняем до total_rows
    targets = _largest_remainder(raw_target, total_rows)

    current_sum = sum(targets.values())
    if current_sum < total_rows:
        diff = total_rows - current_sum
        ordered = sorted(
            support_managers,
            key=lambda m: (cap_map.get(m) not in (None, 0), targets[m], m)
        )
        changed = True
        while diff > 0 and changed:
            changed = False
            for m in ordered:
                if diff <= 0:
                    break
                cap = cap_map.get(m)
                hard_limit = BIG_CAP if cap in (None, 0) else int(cap) + TOTAL_TOLERANCE
                if targets[m] < hard_limit:
                    targets[m] += 1
                    diff -= 1
                    changed = True

    elif current_sum > total_rows:
        diff = current_sum - total_rows
        ordered = sorted(support_managers, key=lambda m: (targets[m], m), reverse=True)
        changed = True
        while diff > 0 and changed:
            changed = False
            for m in ordered:
                if diff <= 0:
                    break
                floor = locked_total.get(m, 0)
                if targets[m] > floor:
                    targets[m] -= 1
                    diff -= 1
                    changed = True

    return targets


def _compute_target_periods(
    total_targets: Dict[str, int],
    shares: Dict[int, float],
) -> Dict[str, Dict[int, int]]:
    result = {}
    for manager, total_target in total_targets.items():
        raw = {
            1: total_target * shares[1],
            3: total_target * shares[3],
            12: total_target * shares[12],
        }
        floors = {k: int(math.floor(v)) for k, v in raw.items()}
        rem = total_target - sum(floors.values())
        order = sorted(raw.keys(), key=lambda k: raw[k] - floors[k], reverse=True)

        final = dict(floors)
        for tariff in order:
            if rem <= 0:
                break
            final[tariff] += 1
            rem -= 1

        result[manager] = final
    return result


def _total_penalty(actual: int, target: int, cap: Optional[int]) -> float:
    diff = abs(actual - target)
    excess = max(0, diff - TOTAL_TOLERANCE)
    penalty = float(excess * excess)

    if cap not in (None, 0):
        hard_excess = max(0, actual - (int(cap) + TOTAL_TOLERANCE))
        if hard_excess > 0:
            penalty += 1_000_000.0 * hard_excess
    return penalty


def _period_penalty(actual: int, target: int) -> float:
    diff = abs(actual - target)
    excess = max(0, diff - PERIOD_TOLERANCE)
    return float(excess * excess)


def _manager_violation_score(
    manager: str,
    totals: Dict[str, int],
    periods: Dict[str, Dict[int, int]],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    cap_map: Dict[str, Optional[int]],
    total_weight: float,
    period_weight: float,
) -> float:
    cap = cap_map.get(manager)
    has_cap = cap not in (None, 0)

    score = total_weight * _total_penalty(totals[manager], total_targets[manager], cap)

    pw = period_weight * (CAPPED_PERIOD_FACTOR if has_cap else 1.0)
    for tariff in VALID_TARIFFS:
        score += pw * _period_penalty(periods[manager][tariff], period_targets[manager][tariff])

    return score


def _pair_score_after_external_add(
    manager: str,
    tariff: int,
    totals: Dict[str, int],
    periods: Dict[str, Dict[int, int]],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    cap_map: Dict[str, Optional[int]],
) -> float:
    new_totals = {manager: totals[manager] + 1}
    new_periods = {
        manager: {
            1: periods[manager][1],
            3: periods[manager][3],
            12: periods[manager][12],
        }
    }
    new_periods[manager][tariff] += 1

    cap = cap_map.get(manager)
    has_cap = cap not in (None, 0)

    total_part = EXTERNAL_TOTAL_WEIGHT * _total_penalty(new_totals[manager], total_targets[manager], cap)
    period_part = 0.0
    pw = EXTERNAL_PERIOD_WEIGHT * (CAPPED_PERIOD_FACTOR if has_cap else 1.0)
    for t in VALID_TARIFFS:
        period_part += pw * _period_penalty(new_periods[manager][t], period_targets[manager][t])

    # Лёгкое предпочтение тем, у кого total сейчас меньше
    return total_part + period_part + (totals[manager] * 0.01)


def _assign_external_rows(
    work_df: pd.DataFrame,
    support_managers: List[str],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    cap_map: Dict[str, Optional[int]],
) -> pd.DataFrame:
    # locked: paid на support не двигаем
    is_support_now = work_df[COL_MANAGER].isin(support_managers)
    locked_mask = is_support_now & (work_df[COL_PAID] == 1)

    result = work_df.copy()
    result[COL_NEW_MANAGER] = result[COL_MANAGER]

    current_df = result.loc[locked_mask, [COL_NEW_MANAGER, COL_TARIFF]].copy()
    totals, periods = _count_from_assignment(current_df, COL_NEW_MANAGER, support_managers)

    # external: всё с non-support
    external_mask = ~is_support_now
    external_df = result.loc[external_mask].copy()

    # сначала распределяем более редкие тарифы, потом массовые не так критично
    tariff_freq = result[COL_TARIFF].value_counts().to_dict()
    external_df["_tariff_freq"] = external_df[COL_TARIFF].map(lambda x: tariff_freq.get(x, 0))
    external_df = external_df.sort_values(
        by=["_tariff_freq", COL_TARIFF],
        ascending=[True, True],
        kind="stable",
    )

    assignments = {}
    for idx, row in external_df.iterrows():
        tariff = int(row[COL_TARIFF])

        candidates = []
        for manager in support_managers:
            score = _pair_score_after_external_add(
                manager=manager,
                tariff=tariff,
                totals=totals,
                periods=periods,
                total_targets=total_targets,
                period_targets=period_targets,
                cap_map=cap_map,
            )
            candidates.append((score, totals[manager], manager))

        candidates.sort(key=lambda x: (x[0], x[1], x[2]))
        chosen = candidates[0][2]
        assignments[idx] = chosen
        totals[chosen] += 1
        periods[chosen][tariff] += 1

    if assignments:
        result.loc[list(assignments.keys()), COL_NEW_MANAGER] = pd.Series(assignments)

    return result


def _compute_state_from_result(
    result_df: pd.DataFrame,
    support_managers: List[str],
) -> Tuple[Dict[str, int], Dict[str, Dict[int, int]]]:
    return _count_from_assignment(result_df, COL_NEW_MANAGER, support_managers)


def _global_state_score(
    totals: Dict[str, int],
    periods: Dict[str, Dict[int, int]],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    cap_map: Dict[str, Optional[int]],
) -> float:
    score = 0.0
    for manager in totals.keys():
        score += _manager_violation_score(
            manager=manager,
            totals=totals,
            periods=periods,
            total_targets=total_targets,
            period_targets=period_targets,
            cap_map=cap_map,
            total_weight=INTERNAL_TOTAL_WEIGHT,
            period_weight=INTERNAL_PERIOD_WEIGHT,
        )
    return score


def _manager_needs_total(manager: str, totals: Dict[str, int], total_targets: Dict[str, int]) -> int:
    return total_targets[manager] - totals[manager]


def _manager_needs_tariff(
    manager: str,
    tariff: int,
    periods: Dict[str, Dict[int, int]],
    period_targets: Dict[str, Dict[int, int]],
) -> int:
    return period_targets[manager][tariff] - periods[manager][tariff]


def _conservative_internal_rebalance(
    result_df: pd.DataFrame,
    support_managers: List[str],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    cap_map: Dict[str, Optional[int]],
) -> pd.DataFrame:
    df = result_df.copy()
    donor_usage = {m: 0 for m in support_managers}

    unpaid_pool_mask = (df[COL_NEW_MANAGER].isin(support_managers)) & (df[COL_PAID] == 0)

    for _ in range(MAX_INTERNAL_ITERATIONS):
        totals, periods = _compute_state_from_result(df, support_managers)
        before_score = _global_state_score(totals, periods, total_targets, period_targets, cap_map)

        best_move = None
        best_gain = 0.0

        # receiver: кто реально в дефиците
        receivers = []
        for manager in support_managers:
            total_need = _manager_needs_total(manager, totals, total_targets)
            tariff_needs = {t: _manager_needs_tariff(manager, t, periods, period_targets) for t in VALID_TARIFFS}
            receivers.append((manager, total_need, tariff_needs))

        # перебираем дефициты по тарифам в первую очередь, потом по total
        for receiver, total_need, tariff_needs in receivers:
            needed_tariffs = [
                t for t in VALID_TARIFFS
                if tariff_needs[t] > PERIOD_TOLERANCE or (tariff_needs[t] > 0 and total_need > 0)
            ]
            if not needed_tariffs and total_need <= TOTAL_TOLERANCE:
                continue

            candidate_tariffs = needed_tariffs if needed_tariffs else list(VALID_TARIFFS)

            for tariff in candidate_tariffs:
                donors = []
                for donor in support_managers:
                    if donor == receiver:
                        continue

                    donor_total_excess = totals[donor] - total_targets[donor]
                    donor_tariff_excess = periods[donor][tariff] - period_targets[donor][tariff]

                    if donor_total_excess <= 0 and donor_tariff_excess <= 0:
                        continue

                    donor_rows = df.index[
                        unpaid_pool_mask
                        & (df[COL_NEW_MANAGER] == donor)
                        & (df[COL_TARIFF] == tariff)
                    ].tolist()

                    if not donor_rows:
                        continue

                    donors.append(
                        (
                            donor,
                            donor_total_excess,
                            donor_tariff_excess,
                            donor_usage[donor],
                            donor_rows[0],  # двигаем по одной
                        )
                    )

                # забираем не у одного, а у тех, кого меньше уже трогали
                donors.sort(
                    key=lambda x: (
                        -max(x[2], 0),
                        -max(x[1], 0),
                        x[3],
                        x[0],
                    )
                )

                for donor, _, _, usage_count, row_idx in donors:
                    # симуляция одного переноса donor -> receiver
                    new_totals = {m: totals[m] for m in support_managers}
                    new_periods = {
                        m: {1: periods[m][1], 3: periods[m][3], 12: periods[m][12]}
                        for m in support_managers
                    }

                    new_totals[donor] -= 1
                    new_totals[receiver] += 1
                    new_periods[donor][tariff] -= 1
                    new_periods[receiver][tariff] += 1

                    after_score = _global_state_score(
                        new_totals,
                        new_periods,
                        total_targets,
                        period_targets,
                        cap_map,
                    )

                    # штраф за дёргание одного и того же донора
                    fairness_penalty = usage_count * 0.1
                    gain = before_score - (after_score + fairness_penalty)

                    if gain > best_gain:
                        best_gain = gain
                        best_move = (row_idx, donor, receiver, tariff)

        if not best_move or best_gain <= 0:
            break

        row_idx, donor, receiver, tariff = best_move
        df.at[row_idx, COL_NEW_MANAGER] = receiver
        donor_usage[donor] += 1

        unpaid_pool_mask = (df[COL_NEW_MANAGER].isin(support_managers)) & (df[COL_PAID] == 0)

    return df


def _build_summary(
    result_df: pd.DataFrame,
    support_managers: List[str],
    cap_map: Dict[str, Optional[int]],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
) -> pd.DataFrame:
    totals, periods = _count_from_assignment(result_df, COL_NEW_MANAGER, support_managers)

    locked_paid_mask = (result_df[COL_NEW_MANAGER].isin(support_managers)) & (result_df[COL_PAID] == 1)
    locked_df = result_df.loc[locked_paid_mask, [COL_NEW_MANAGER, COL_TARIFF]].copy()
    locked_total, _ = _count_from_assignment(locked_df, COL_NEW_MANAGER, support_managers)

    rows = []
    for manager in support_managers:
        cap = cap_map.get(manager)
        rows.append(
            {
                "manager": manager,
                "has_cap": cap not in (None, 0),
                "cap_value": "" if cap in (None, 0) else int(cap),
                "locked_paid": locked_total.get(manager, 0),
                "target_total": total_targets[manager],
                "fact_total": totals[manager],
                "delta_total": totals[manager] - total_targets[manager],
                "target_1": period_targets[manager][1],
                "fact_1": periods[manager][1],
                "delta_1": periods[manager][1] - period_targets[manager][1],
                "target_3": period_targets[manager][3],
                "fact_3": periods[manager][3],
                "delta_3": periods[manager][3] - period_targets[manager][3],
                "target_12": period_targets[manager][12],
                "fact_12": periods[manager][12],
                "delta_12": periods[manager][12] - period_targets[manager][12],
            }
        )

    return pd.DataFrame(rows).sort_values(by=["has_cap", "manager"], ascending=[False, True])


def _build_checks(
    original_df: pd.DataFrame,
    result_df: pd.DataFrame,
    summary_df: pd.DataFrame,
    support_managers: List[str],
    cap_map: Dict[str, Optional[int]],
) -> List[str]:
    checks = []

    checks.append(f"Всего строк: {len(result_df)}")
    checks.append(f"Всего support-менеджеров: {len(support_managers)}")

    all_on_support = result_df[COL_NEW_MANAGER].isin(support_managers).all()
    checks.append(f"Все строки в итоге на support: {'ДА' if all_on_support else 'НЕТ'}")

    was_support = original_df[COL_MANAGER].isin(support_managers)
    was_paid = original_df[COL_PAID] == 1

    locked_mask = was_support & was_paid
    paid_on_support_untouched = (
        result_df.loc[locked_mask, COL_NEW_MANAGER].reset_index(drop=True)
        == original_df.loc[locked_mask, COL_MANAGER].reset_index(drop=True)
    ).all()
    checks.append(f"Paid на support не тронуты: {'ДА' if paid_on_support_untouched else 'НЕТ'}")

    external_paid_mask = (~was_support) & was_paid
    paid_sales_moved_ok = True
    if external_paid_mask.any():
        paid_sales_moved_ok = result_df.loc[external_paid_mask, COL_NEW_MANAGER].isin(support_managers).all()
    checks.append(f"Paid с non-support перенесены на support: {'ДА' if paid_sales_moved_ok else 'НЕТ'}")

    cap_ok = True
    for _, row in summary_df.iterrows():
        manager = row["manager"]
        cap = cap_map.get(manager)
        if cap not in (None, 0):
            if row["fact_total"] > int(cap) + TOTAL_TOLERANCE:
                cap_ok = False
                checks.append(
                    f"ПРЕВЫШЕН CAP+{TOTAL_TOLERANCE}: {manager} -> факт {row['fact_total']}, cap {cap}"
                )
    if cap_ok:
        checks.append(f"Все cap соблюдены с допуском +{TOTAL_TOLERANCE}: ДА")

    total_ok = (summary_df["delta_total"].abs() <= TOTAL_TOLERANCE).all()
    checks.append(f"Все total в допуске ±{TOTAL_TOLERANCE}: {'ДА' if total_ok else 'НЕТ'}")

    period_ok = (
        (summary_df["delta_1"].abs() <= PERIOD_TOLERANCE).all()
        and (summary_df["delta_3"].abs() <= PERIOD_TOLERANCE).all()
        and (summary_df["delta_12"].abs() <= PERIOD_TOLERANCE).all()
    )
    checks.append(f"Все тарифы в допуске ±{PERIOD_TOLERANCE}: {'ДА' if period_ok else 'НЕТ'}")

    return checks


def distribute_cash_registers(df: pd.DataFrame, managers_config: Dict) -> DistributionResult:
    work = _validate_and_prepare_df(df)

    managers_config = ensure_managers_present(
        managers_config,
        work[COL_MANAGER].dropna().astype(str).str.strip().tolist(),
    )

    support_managers = get_support_managers(managers_config)
    if not support_managers:
        raise ValueError("В конфиге нет ни одного support-менеджера.")

    cap_map = get_cap_map(managers_config)

    total_targets = _compute_total_targets(
        total_rows=len(work),
        support_managers=support_managers,
        cap_map=cap_map,
        locked_total=_count_from_assignment(
            work.loc[(work[COL_MANAGER].isin(support_managers)) & (work[COL_PAID] == 1), [COL_MANAGER, COL_TARIFF]],
            COL_MANAGER,
            support_managers,
        )[0],
    )

    shares = _global_tariff_shares(work)
    period_targets = _compute_target_periods(total_targets, shares)

    # Шаг 1: всё внешнее на support, paid на support остаются locked
    assigned = _assign_external_rows(
        work_df=work,
        support_managers=support_managers,
        total_targets=total_targets,
        period_targets=period_targets,
        cap_map=cap_map,
    )

    # unpaid внутри support изначально пока остаются на своих местах
    internal_unpaid_mask = (work[COL_MANAGER].isin(support_managers)) & (work[COL_PAID] == 0)
    assigned.loc[internal_unpaid_mask, COL_NEW_MANAGER] = assigned.loc[internal_unpaid_mask, COL_MANAGER]

    # Шаг 2: бережный внутренний ребаланс unpaid на support
    assigned = _conservative_internal_rebalance(
        result_df=assigned,
        support_managers=support_managers,
        total_targets=total_targets,
        period_targets=period_targets,
        cap_map=cap_map,
    )

    summary_df = _build_summary(
        result_df=assigned,
        support_managers=support_managers,
        cap_map=cap_map,
        total_targets=total_targets,
        period_targets=period_targets,
    )

    moves_df = assigned.loc[
        assigned[COL_MANAGER] != assigned[COL_NEW_MANAGER],
        [COL_MANAGER, COL_NEW_MANAGER, COL_TARIFF, COL_PAID],
    ].copy()
    moves_df = moves_df.rename(
        columns={
            COL_MANAGER: "old_manager",
            COL_NEW_MANAGER: "new_manager",
            COL_TARIFF: "tariff",
            COL_PAID: "paid",
        }
    )

    checks = _build_checks(
        original_df=work,
        result_df=assigned,
        summary_df=summary_df,
        support_managers=support_managers,
        cap_map=cap_map,
    )

    chart_df = summary_df[["manager", "fact_total", "target_total"]].copy()

    return DistributionResult(
        output_df=assigned,
        summary_df=summary_df,
        moves_df=moves_df,
        checks=checks,
        chart_df=chart_df,
        managers_config=managers_config,
    )