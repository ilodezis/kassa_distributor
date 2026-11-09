"""Runs the reference (Python) distribution on one export for several configs.

Usage: python -I reference_run.py <reference dir> <export.xlsx> <scenarios.json> <out.json>

Used by scripts/compare-with-reference.ts; not meant to be run by hand.
scenarios.json is a list of {"name": str, "config": {...}}. out.json gets one entry per
scenario with the new manager of every row, the summary table, the number of moves and the
checks log, or the error message if the reference refused the input.
"""

import json
import sys


def main() -> None:
    ref_dir, xlsx_path, scenarios_path, out_path = sys.argv[1:5]
    sys.path.insert(0, ref_dir)
    import logic  # the reference implementation

    df = logic.read_input_excel(xlsx_path)
    with open(scenarios_path, encoding="utf-8") as f:
        scenarios = json.load(f)

    results = []
    for scenario in scenarios:
        entry = {"name": scenario["name"]}
        try:
            res = logic.distribute_cash_registers(df, scenario["config"])
            entry["emails"] = res.output_df[logic.COL_NEW_MANAGER].tolist()
            entry["summary"] = json.loads(res.summary_df.to_json(orient="records"))
            entry["moves"] = len(res.moves_df)
            entry["checks"] = res.checks
        except Exception as error:  # the TS side must refuse the same inputs with the same message
            entry["error"] = str(error)
        results.append(entry)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
