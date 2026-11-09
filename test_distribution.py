"""Проверка инвариантов распределения. Запуск: python test_distribution.py"""

import random

import pandas as pd

import logic
from logic import (
    COL_INN,
    COL_MANAGER,
    COL_MANAGER_NAME,
    COL_NEW_MANAGER,
    COL_NEW_MANAGER_NAME,
    COL_STATUS,
    COL_TARIFF,
    COL_TERMINATION,
    VALID_TARIFFS,
)


def make_case(seed, rows=1200, support=10, external=3, caps=None, paid_share=0.4):
    """Выгрузка с перекошенной нагрузкой — её и должно выровнять."""
    rnd = random.Random(seed)
    caps = caps or {}
    support_names = [f"support{i:02d}@cp.ru" for i in range(support)]
    external_names = [f"sales{i:02d}@cp.ru" for i in range(external)]
    weights = [6.0 ** rnd.random() for _ in support_names]
    weights += [sum(weights) * 0.25 / max(external, 1)] * external

    rows_data = []
    for i in range(rows):
        email = rnd.choices(support_names + external_names, weights=weights)[0]
        rows_data.append(
            {
                COL_MANAGER_NAME: email.split("@")[0].title(),
                COL_MANAGER: email,
                COL_INN: f"{i:012d}",
                COL_TARIFF: rnd.choices(VALID_TARIFFS, weights=[0.6, 0.25, 0.15])[0],
                COL_STATUS: "paid" if rnd.random() < paid_share else "topay",
                COL_TERMINATION: None,
            }
        )
    df = pd.DataFrame(rows_data)

    config = {"version": 2, "managers": []}
    for i, email in enumerate(support_names):
        cap = caps.get(i)
        config["managers"].append(
            {"email": email, "name": email, "is_support": True, "has_cap": cap is not None, "cap": cap}
        )
    for email in external_names:
        config["managers"].append(
            {"email": email, "name": email, "is_support": False, "has_cap": False, "cap": None}
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
    config = logic.ensure_managers_present(config, logic.managers_from_df(work))
    cap_map = logic.get_cap_map(config)

    locked = work.loc[work[COL_MANAGER].isin(support_names) & (work[logic.COL_PAID] == 1)]
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

    was_paid_on_support = result[COL_MANAGER].isin(support_names) & (result[COL_STATUS] == "paid")
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


def test_frozen_rows_stay_and_skip_balancing():
    """Terminated or unknown-status rows stay put and do not count towards the load."""
    df, config, support_names = make_case(6)
    df.loc[0, COL_MANAGER] = "sales00@cp.ru"
    df.loc[0, COL_TERMINATION] = "15.11.2026"
    df.loc[1, COL_STATUS] = "refund"
    df.loc[1, COL_TERMINATION] = None

    res = logic.distribute_cash_registers(df, config)
    out = res.output_df

    assert len(out) == len(df), "потеряны или задвоены строки"
    for i in (0, 1):
        assert out.loc[i, COL_NEW_MANAGER] == out.loc[i, COL_MANAGER], f"строка {i} сдвинута"
    assert int(res.summary_df["fact_total"].sum()) == len(df) - 2, "замороженные посчитаны в нагрузке"
    assert int(res.summary_df["delta_total"].abs().max()) == 0
    assert any("refund" in c for c in res.checks), "незнакомый статус не попал в checks"
    assert any("расторжение" in c for c in res.checks), "расторжение не попало в checks"
    assert "_paid" not in out.columns and "_frozen_reason" not in out.columns
    assert out[COL_NEW_MANAGER_NAME].notna().all()


def test_legacy_config_gets_email_by_exact_name():
    legacy = {"version": 1, "managers": [
        {"name": "Иванов Иван", "is_support": True, "has_cap": True, "cap": 150},
        {"name": "Ушедший Человек", "is_support": True, "has_cap": False, "cap": None},
    ]}
    merged = logic.ensure_managers_present(
        legacy, [("I.Ivanov@cp.ru", "Иванов Иван"), ("p.petrov@cp.ru", "Петров Пётр")]
    )
    by_name = {m["name"]: m for m in merged["managers"]}
    assert by_name["Иванов Иван"]["email"] == "i.ivanov@cp.ru"
    assert by_name["Иванов Иван"]["cap"] == 150
    assert by_name["Петров Пётр"]["is_support"] is False
    assert logic.get_support_managers(merged) == ["i.ivanov@cp.ru"]
    assert logic.get_support_without_email(merged) == ["Ушедший Человек"]


def test_inn_keeps_leading_zero():
    import os
    import tempfile

    df, _, _ = make_case(8, rows=5)
    df.loc[0, COL_INN] = "071303241361"
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "in.xlsx")
        df.to_excel(path, index=False)
        back = logic.read_input_excel(path)
    assert back.loc[0, COL_INN] == "071303241361"


if __name__ == "__main__":
    for name, case in sorted(globals().items()):
        if name.startswith("test_"):
            case()
            print(f"ok  {name}")
    print("\nвсе проверки пройдены")
