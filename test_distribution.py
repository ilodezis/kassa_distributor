"""Проверка инвариантов распределения. Запуск: python test_distribution.py"""

import random

import pandas as pd

import logic
from logic import COL_MANAGER, COL_NEW_MANAGER, COL_PAID, COL_TARIFF, VALID_TARIFFS


def make_case(seed, rows=1200, support=10, external=3, caps=None, paid_share=0.4):
    """Выгрузка с перекошенной нагрузкой — её и должно выровнять."""
    rnd = random.Random(seed)
    caps = caps or {}
    support_names = [f"Support {i:02d}" for i in range(support)]
    external_names = [f"Sales {i:02d}" for i in range(external)]
    weights = [6.0 ** rnd.random() for _ in support_names]
    weights += [sum(weights) * 0.25 / max(external, 1)] * external

    df = pd.DataFrame([
        {
            COL_MANAGER: rnd.choices(support_names + external_names, weights=weights)[0],
            COL_TARIFF: rnd.choices(VALID_TARIFFS, weights=[0.6, 0.25, 0.15])[0],
            COL_PAID: 1 if rnd.random() < paid_share else 0,
        }
        for _ in range(rows)
    ])

    config = {"version": 1, "managers": []}
    for i, name in enumerate(support_names):
        cap = caps.get(i)
        config["managers"].append(
            {"name": name, "is_support": True, "has_cap": cap is not None, "cap": cap}
        )
    for name in external_names:
        config["managers"].append(
            {"name": name, "is_support": False, "has_cap": False, "cap": None}
        )
    return df, config, support_names


def test_total_spread_is_zero():
    """Этап 1 обязан попадать в таргет точно: разброс по количеству нулевой."""
    for seed in (1, 2, 3):
        df, config, _ = make_case(seed)
        summary = logic.distribute_cash_registers(df, config).summary_df
        worst = int(summary["delta_total"].abs().max())
        assert worst == 0, f"seed {seed}: разброс по total {worst}, ожидался 0"


def test_tariff_spread_within_tolerance():
    for seed in (1, 2, 3):
        df, config, _ = make_case(seed)
        summary = logic.distribute_cash_registers(df, config).summary_df
        for tariff in VALID_TARIFFS:
            worst = int(summary[f"delta_{tariff}"].abs().max())
            assert worst <= logic.PERIOD_TOLERANCE, (
                f"seed {seed}: тариф {tariff} отклонился на {worst}"
            )


def test_swaps_never_change_totals():
    """Обмены этапа 2 сохраняют количество касс у каждого — иначе этап 1 напрасен."""
    df, config, support_names = make_case(7)
    work = logic._validate_and_prepare_df(df)
    config = logic.ensure_managers_present(config, work[COL_MANAGER].tolist())
    cap_map = logic.get_cap_map(config)

    locked = work.loc[work[COL_MANAGER].isin(support_names) & (work[COL_PAID] == 1)]
    targets = logic._compute_total_targets(
        len(work),
        support_names,
        cap_map,
        logic._count_from_assignment(locked, COL_MANAGER, support_names)[0],
    )
    period_targets = logic._compute_target_periods(targets, logic._global_tariff_shares(work))

    filled = logic._exact_total_fill(work, support_names, targets, period_targets)
    swapped = logic._tariff_swaps(filled, support_names, period_targets)

    before = filled[COL_NEW_MANAGER].value_counts().to_dict()
    after = swapped[COL_NEW_MANAGER].value_counts().to_dict()
    assert before == after, "обмен изменил количество касс у менеджера"


def test_paid_frozen_and_nothing_lost():
    df, config, support_names = make_case(4)
    result = logic.distribute_cash_registers(df, config).output_df

    assert len(result) == len(df), "потеряны или задвоены строки"
    assert result[COL_NEW_MANAGER].isin(support_names).all(), "касса осталась вне сопровождения"

    was_paid_on_support = result[COL_MANAGER].isin(support_names) & (result[COL_PAID] == 1)
    moved = result.loc[was_paid_on_support, COL_MANAGER] != result.loc[was_paid_on_support, COL_NEW_MANAGER]
    assert not moved.any(), "оплаченная касса сдвинута с менеджера сопровождения"


def test_caps_respected():
    df, config, support_names = make_case(5, caps={0: 80, 3: 110})
    summary = logic.distribute_cash_registers(df, config).summary_df
    facts = dict(zip(summary["manager"], summary["fact_total"]))
    for index, cap in ((0, 80), (3, 110)):
        fact = facts[support_names[index]]
        assert fact <= cap + logic.TOTAL_TOLERANCE, (
            f"{support_names[index]}: факт {fact} против cap {cap}"
        )


if __name__ == "__main__":
    for name, case in sorted(globals().items()):
        if name.startswith("test_"):
            case()
            print(f"ok  {name}")
    print("\nвсе проверки пройдены")
