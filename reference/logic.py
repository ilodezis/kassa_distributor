import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import pandas as pd


# Columns of the renewal-distribution export. A manager is identified by email:
# the full name drifts between exports (word order, login instead of name), email does not.
COL_MANAGER = "Почта текущего менеджера"
COL_MANAGER_NAME = "ФИО текущего менеджера"
COL_INN = "ИНН"
COL_TARIFF = "Тариф"
COL_STATUS = "Статус оплаты"
COL_TERMINATION = "Дата расторжения"

# Added to the result
COL_NEW_MANAGER = "Почта нового менеджера"
COL_NEW_MANAGER_NAME = "Новый менеджер"

# Internal columns, dropped from the result
COL_PAID = "_paid"
COL_FROZEN = "_frozen_reason"

STATUS_PAID = "paid"
KNOWN_STATUSES = ("paid", "topay")

VALID_TARIFFS = (1, 3, 12)

# Допуски — это пороги отчёта в логе проверок и запас сверх cap при расчёте таргетов.
# В саму раскладку они не входят: этап 1 даёт точное попадание по total,
# этап 2 минимизирует отклонение по тарифам без «мёртвой зоны».
TOTAL_TOLERANCE = 5
PERIOD_TOLERANCE = 3
BIG_CAP = 10**9

MAX_SWAP_PASSES = 200


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


APP_DIR_NAME = "KassaDistributor"


def user_data_dir() -> str:
    """Writable per-user folder that survives replacing the app with a new build."""
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, APP_DIR_NAME)


def default_config_path() -> str:
    # From source the config sits next to the code. A built app keeps it in the
    # user data folder: the bundle may be read-only (macOS app translocation)
    # and is wiped whenever the app is replaced with a new build.
    if not getattr(sys, "frozen", False):
        return resource_path("managers.json")
    return os.path.join(user_data_dir(), "managers.json")


def _default_config() -> Dict:
    return {"version": 2, "managers": []}


def _norm_email(value) -> str:
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    return str(value).strip().lower()


def _norm_name(value) -> str:
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return ""
    return str(value).strip()


def manager_key(item: Dict) -> str:
    """Config entry key: email, or name for legacy entries without email."""
    return _norm_email(item.get("email")) or _norm_name(item.get("name")).lower()


def _normalize_managers(items, strict_cap: bool) -> List[Dict]:
    normalized = []
    seen = set()

    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue

        email = _norm_email(item.get("email"))
        name = _norm_name(item.get("name"))
        key = email or name.lower()
        if not key or key in seen:
            continue

        has_cap = bool(item.get("has_cap", item.get("cap") not in (None, "", 0)))
        cap = None
        if has_cap and item.get("cap") not in (None, ""):
            try:
                cap = int(item["cap"])
            except Exception:
                if strict_cap:
                    raise
                cap = None

        normalized.append(
            {
                "email": email,
                "name": name or email,
                "is_support": bool(item.get("is_support", False)),
                "has_cap": cap is not None,
                "cap": cap,
            }
        )
        seen.add(key)

    return normalized


def load_managers_config(path: Optional[str] = None) -> Dict:
    path = path or default_config_path()
    if not os.path.exists(path):
        data = _default_config()
        save_managers_config(data, path)
        return data

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    items = raw.get("managers", []) if isinstance(raw, dict) else []
    return {"version": 2, "managers": _normalize_managers(items, strict_cap=False)}


def save_managers_config(data: Dict, path: Optional[str] = None) -> None:
    path = path or default_config_path()
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    out = {"version": 2, "managers": _normalize_managers(data.get("managers", []), strict_cap=True)}

    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def managers_from_df(df: pd.DataFrame) -> List[Tuple[str, str]]:
    """(email, full name) pairs from the export, one per email."""
    if COL_MANAGER not in df.columns:
        return []
    names = df[COL_MANAGER_NAME] if COL_MANAGER_NAME in df.columns else pd.Series("", index=df.index)
    pairs = {}
    for email, name in zip(df[COL_MANAGER], names):
        email = _norm_email(email)
        if email and email not in pairs:
            pairs[email] = _norm_name(name)
    return sorted(pairs.items())


def ensure_managers_present(config: Dict, managers: List[Tuple[str, str]]) -> Dict:
    """Adds managers from the export to the config (new ones are not support).

    Legacy entries without email get one when their name exactly matches
    a full name in the export. Everything else is up to the person running
    the distribution, in the UI.
    """
    result = {"version": 2, "managers": [dict(x) for x in config.get("managers", [])]}
    by_email = {_norm_email(x.get("email")): x for x in result["managers"] if _norm_email(x.get("email"))}
    legacy_by_name = {
        _norm_name(x.get("name")).lower(): x
        for x in result["managers"]
        if not _norm_email(x.get("email"))
    }

    for email, name in managers:
        email = _norm_email(email)
        name = _norm_name(name)
        if not email or email in by_email:
            continue

        legacy = legacy_by_name.pop(name.lower(), None) if name else None
        if legacy is not None:
            legacy["email"] = email
            by_email[email] = legacy
            continue

        entry = {"email": email, "name": name or email, "is_support": False, "has_cap": False, "cap": None}
        result["managers"].append(entry)
        by_email[email] = entry

    result["managers"] = sorted(result["managers"], key=lambda x: str(x.get("name", "")).lower())
    return result


def get_support_managers(config: Dict) -> List[str]:
    """Emails of support managers. An entry without email cannot take part."""
    return [
        _norm_email(x.get("email"))
        for x in config.get("managers", [])
        if x.get("is_support") and _norm_email(x.get("email"))
    ]


def get_support_without_email(config: Dict) -> List[str]:
    return [
        _norm_name(x.get("name"))
        for x in config.get("managers", [])
        if x.get("is_support") and not _norm_email(x.get("email"))
    ]


def get_cap_map(config: Dict) -> Dict[str, Optional[int]]:
    out = {}
    for item in config.get("managers", []):
        email = _norm_email(item.get("email"))
        if not email:
            continue
        if item.get("has_cap") and item.get("cap") not in (None, ""):
            out[email] = int(item["cap"])
        else:
            out[email] = None
    return out


def get_name_map(config: Dict, df: Optional[pd.DataFrame] = None) -> Dict[str, str]:
    """Email -> display name: from the config, else from the export."""
    out = {}
    if df is not None:
        for email, name in managers_from_df(df):
            out[email] = name or email
    for item in config.get("managers", []):
        email = _norm_email(item.get("email"))
        if email and _norm_name(item.get("name")):
            out[email] = _norm_name(item.get("name"))
    return out


def read_input_excel(path: str) -> pd.DataFrame:
    """Read the INN as text, otherwise pandas turns 071303241361 into 71303241361."""
    return pd.read_excel(path, sheet_name=0, dtype={COL_INN: str})


def _validate_and_prepare_df(df: pd.DataFrame) -> pd.DataFrame:
    """Normalizes the export and marks frozen rows.

    Frozen rows stay on their current manager and are excluded from balancing:
    - rows with a termination date;
    - rows with an unknown payment status (not paid/topay).
    """
    required = (COL_MANAGER, COL_MANAGER_NAME, COL_TARIFF, COL_STATUS)
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"В файле нет обязательных колонок: {', '.join(missing)}")

    out = df.copy()
    out[COL_MANAGER] = out[COL_MANAGER].map(_norm_email)
    out[COL_MANAGER_NAME] = out[COL_MANAGER_NAME].map(_norm_name)

    def parse_tariff(v):
        if pd.isna(v):
            return None
        try:
            return int(float(v))
        except Exception:
            return None

    out[COL_TARIFF] = out[COL_TARIFF].apply(parse_tariff)

    status = out[COL_STATUS].map(_norm_name).str.lower()
    out[COL_PAID] = (status == STATUS_PAID).astype(int)

    reason = pd.Series("", index=out.index, dtype=object)
    if COL_TERMINATION in out.columns:
        terminated = out[COL_TERMINATION].map(_norm_name) != ""
        reason[terminated] = "расторжение"
    unknown = ~status.isin(KNOWN_STATUSES) & (reason == "")
    reason[unknown] = "неизвестный статус оплаты: '" + status[unknown] + "'"
    out[COL_FROZEN] = reason

    if (out[COL_MANAGER] == "").any():
        raise ValueError("Есть строки без почты менеджера.")

    active = out[COL_FROZEN] == ""
    bad = out[active & ~out[COL_TARIFF].isin(VALID_TARIFFS)]
    if not bad.empty:
        raise ValueError("Обнаружены строки с некорректным тарифом. Допустимы только 1, 3, 12.")

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


def _period_penalty(actual: int, target: int) -> float:
    diff = actual - target
    return float(diff * diff)


def _exact_total_fill(
    work_df: pd.DataFrame,
    support_managers: List[str],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
) -> pd.DataFrame:
    """Этап 1: каждый support-менеджер получает ровно total_targets[m] касс.

    Свободный пул по построению равен суммарной нехватке, поэтому раскладка
    всегда сходится и разброс по total выходит нулевым — это арифметика, а не
    оптимизация. Тариф здесь работает только тайбрейком, его правит этап 2.
    """
    result = work_df.copy()
    result[COL_NEW_MANAGER] = result[COL_MANAGER]

    is_support_now = result[COL_MANAGER].isin(support_managers)
    locked_mask = is_support_now & (result[COL_PAID] == 1)

    counts = {m: 0 for m in support_managers}
    per_tariff = {m: {t: 0 for t in VALID_TARIFFS} for m in support_managers}
    for idx in result.index[locked_mask]:
        manager = result.at[idx, COL_NEW_MANAGER]
        counts[manager] += 1
        per_tariff[manager][int(result.at[idx, COL_TARIFF])] += 1

    # минимум миграций: кто уже на support и влезает в таргет — остаётся на месте
    pool = []
    for idx in result.index[~locked_mask]:
        current = result.at[idx, COL_NEW_MANAGER]
        if current in counts and counts[current] < total_targets[current]:
            counts[current] += 1
            per_tariff[current][int(result.at[idx, COL_TARIFF])] += 1
        else:
            pool.append(idx)

    by_tariff = {t: [] for t in VALID_TARIFFS}
    for idx in pool:
        by_tariff[int(result.at[idx, COL_TARIFF])].append(idx)

    deficit = {m: total_targets[m] - counts[m] for m in support_managers}

    # сначала редкие тарифы, иначе под конец выбирать будет не из чего
    for tariff in sorted(VALID_TARIFFS, key=lambda t: len(by_tariff[t])):
        for idx in by_tariff[tariff]:
            candidates = [m for m in support_managers if deficit[m] > 0]
            if candidates:
                # кому этот тариф нужнее; при равенстве — у кого больше общая нехватка
                best = max(
                    candidates,
                    key=lambda m: (
                        period_targets[m][tariff] - per_tariff[m][tariff],
                        deficit[m],
                        m,
                    ),
                )
            else:
                # таргеты не вместили всё (cap у всех слишком низкий) — кассу всё
                # равно не теряем, кладём наименее загруженному. Лог проверок это поймает.
                best = min(support_managers, key=lambda m: (counts[m], m))

            result.at[idx, COL_NEW_MANAGER] = best
            counts[best] += 1
            per_tariff[best][tariff] += 1
            deficit[best] -= 1

    return result


def _tariff_swaps(
    result_df: pd.DataFrame,
    support_managers: List[str],
    period_targets: Dict[str, Dict[int, int]],
    max_passes: int = MAX_SWAP_PASSES,
) -> pd.DataFrame:
    """Этап 2: правим тарифный микс только парными обменами.

    Менеджер A отдаёт кассу тарифа X, B отдаёт кассу тарифа Y. Количество касс
    у обоих сохраняется, поэтому этап 2 физически не может испортить итоги,
    выставленные этапом 1. Двигаем только неоплаченные кассы.
    """
    df = result_df.copy()
    on_support = df[COL_NEW_MANAGER].isin(support_managers)
    movable = on_support & (df[COL_PAID] == 0)

    rows = {(m, t): [] for m in support_managers for t in VALID_TARIFFS}
    counts = {m: {t: 0 for t in VALID_TARIFFS} for m in support_managers}
    for idx in df.index[on_support]:
        manager = df.at[idx, COL_NEW_MANAGER]
        tariff = int(df.at[idx, COL_TARIFF])
        counts[manager][tariff] += 1
        if movable.at[idx]:
            rows[(manager, tariff)].append(idx)

    def penalty(manager: str, tariff: int, delta: int = 0) -> float:
        return _period_penalty(counts[manager][tariff] + delta, period_targets[manager][tariff])

    for _ in range(max_passes):
        improved = False

        for donor in support_managers:
            for taker in support_managers:
                if taker == donor:
                    continue

                for give in VALID_TARIFFS:
                    for take in VALID_TARIFFS:
                        if take == give:
                            continue

                        while rows[(donor, give)] and rows[(taker, take)]:
                            before = (
                                penalty(donor, give) + penalty(donor, take)
                                + penalty(taker, give) + penalty(taker, take)
                            )
                            after = (
                                penalty(donor, give, -1) + penalty(donor, take, +1)
                                + penalty(taker, give, +1) + penalty(taker, take, -1)
                            )
                            if after >= before:
                                break

                            given = rows[(donor, give)].pop()
                            taken = rows[(taker, take)].pop()
                            df.at[given, COL_NEW_MANAGER] = taker
                            df.at[taken, COL_NEW_MANAGER] = donor
                            rows[(taker, give)].append(given)
                            rows[(donor, take)].append(taken)

                            counts[donor][give] -= 1
                            counts[donor][take] += 1
                            counts[taker][give] += 1
                            counts[taker][take] -= 1
                            improved = True

        if not improved:
            break

    return df


def _build_summary(
    result_df: pd.DataFrame,
    support_managers: List[str],
    cap_map: Dict[str, Optional[int]],
    total_targets: Dict[str, int],
    period_targets: Dict[str, Dict[int, int]],
    name_map: Optional[Dict[str, str]] = None,
) -> pd.DataFrame:
    name_map = name_map or {}
    totals, periods = _count_from_assignment(result_df, COL_NEW_MANAGER, support_managers)

    locked_paid_mask = (result_df[COL_NEW_MANAGER].isin(support_managers)) & (result_df[COL_PAID] == 1)
    locked_df = result_df.loc[locked_paid_mask, [COL_NEW_MANAGER, COL_TARIFF]].copy()
    locked_total, _ = _count_from_assignment(locked_df, COL_NEW_MANAGER, support_managers)

    rows = []
    for manager in support_managers:
        cap = cap_map.get(manager)
        rows.append(
            {
                "name": name_map.get(manager, manager),
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

    return pd.DataFrame(rows).sort_values(by=["has_cap", "name"], ascending=[False, True])


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
                    f"ПРЕВЫШЕН CAP+{TOTAL_TOLERANCE}: {row['name']} -> факт {row['fact_total']}, cap {cap}"
                )
    if cap_ok:
        checks.append(f"Все cap соблюдены с допуском +{TOTAL_TOLERANCE}: ДА")

    worst_total = int(summary_df["delta_total"].abs().max())
    total_ok = worst_total <= TOTAL_TOLERANCE
    checks.append(
        f"Все total в допуске ±{TOTAL_TOLERANCE}: {'ДА' if total_ok else 'НЕТ'} "
        f"(макс. отклонение {worst_total})"
    )

    worst_period = int(
        max(summary_df[f"delta_{t}"].abs().max() for t in VALID_TARIFFS)
    )
    period_ok = worst_period <= PERIOD_TOLERANCE
    checks.append(
        f"Все тарифы в допуске ±{PERIOD_TOLERANCE}: {'ДА' if period_ok else 'НЕТ'} "
        f"(макс. отклонение {worst_period})"
    )

    return checks


def distribute_cash_registers(df: pd.DataFrame, managers_config: Dict) -> DistributionResult:
    prepared = _validate_and_prepare_df(df)

    managers_config = ensure_managers_present(managers_config, managers_from_df(prepared))

    support_managers = get_support_managers(managers_config)
    if not support_managers:
        raise ValueError("В конфиге нет ни одного support-менеджера с почтой.")

    cap_map = get_cap_map(managers_config)
    name_map = get_name_map(managers_config, prepared)

    # Frozen rows (terminated, unknown status) stay where they are and skip balancing
    frozen_mask = prepared[COL_FROZEN] != ""
    work = prepared.loc[~frozen_mask].copy()
    frozen = prepared.loc[frozen_mask].copy()
    frozen[COL_NEW_MANAGER] = frozen[COL_MANAGER]

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

    # Шаг 1: точное попадание в таргет по количеству касс
    assigned = _exact_total_fill(
        work_df=work,
        support_managers=support_managers,
        total_targets=total_targets,
        period_targets=period_targets,
    )

    # Шаг 2: тарифный микс обменами, итоги по количеству не меняются
    assigned = _tariff_swaps(
        result_df=assigned,
        support_managers=support_managers,
        period_targets=period_targets,
    )

    summary_df = _build_summary(
        result_df=assigned,
        support_managers=support_managers,
        cap_map=cap_map,
        total_targets=total_targets,
        period_targets=period_targets,
        name_map=name_map,
    )

    moved = assigned.loc[assigned[COL_MANAGER] != assigned[COL_NEW_MANAGER]]
    moves_df = pd.DataFrame(
        {
            "inn": moved[COL_INN] if COL_INN in moved.columns else "",
            "old_manager": moved[COL_MANAGER_NAME],
            "new_manager": moved[COL_NEW_MANAGER].map(lambda m: name_map.get(m, m)),
            "tariff": moved[COL_TARIFF],
            "paid": moved[COL_PAID],
        }
    )

    checks = _build_checks(
        original_df=work,
        result_df=assigned,
        summary_df=summary_df,
        support_managers=support_managers,
        cap_map=cap_map,
    )
    checks.extend(_frozen_checks(frozen))
    without_email = get_support_without_email(managers_config)
    if without_email:
        checks.append(
            "Support без почты, в раскладке не участвуют: " + ", ".join(without_email)
        )

    output_df = pd.concat([assigned, frozen]).sort_index()
    output_df[COL_NEW_MANAGER_NAME] = output_df[COL_NEW_MANAGER].map(lambda m: name_map.get(m, m))
    output_df = output_df.drop(columns=[COL_PAID, COL_FROZEN])

    chart_df = summary_df[["name", "fact_total", "target_total"]].rename(columns={"name": "manager"})

    return DistributionResult(
        output_df=output_df,
        summary_df=summary_df,
        moves_df=moves_df,
        checks=checks,
        chart_df=chart_df,
        managers_config=managers_config,
    )


def _frozen_checks(frozen: pd.DataFrame) -> List[str]:
    if frozen.empty:
        return ["Замороженных касс (расторжение / неизвестный статус): 0"]

    lines = [f"Замороженных касс (расторжение / неизвестный статус), не распределены: {len(frozen)}"]
    for _, row in frozen.iterrows():
        inn = row[COL_INN] if COL_INN in frozen.columns else ""
        lines.append(f"  ИНН {inn} — {row[COL_MANAGER_NAME]}: {row[COL_FROZEN]}")
    return lines
