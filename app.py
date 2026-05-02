import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

from logic import (
    COL_MANAGER,
    DistributionResult,
    default_config_path,
    distribute_cash_registers,
    ensure_managers_present,
    load_managers_config,
    save_managers_config,
)


class KassaDistributionApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Kassa Distribution Tool")
        self.geometry("1600x920")
        self.minsize(1280, 760)

        self.config_path = default_config_path()
        self.managers_config = load_managers_config(self.config_path)

        self.input_df = None
        self.input_path = None
        self.result = None

        self._configure_style()
        self._build_ui()
        self._refresh_managers_tree()

    def _configure_style(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure("Treeview", rowheight=28, font=("Arial", 11))
        style.configure("Treeview.Heading", font=("Arial", 11, "bold"))
        style.configure("TNotebook.Tab", padding=(14, 8))
        style.configure("TButton", padding=(10, 6))
        style.configure("Header.TLabel", font=("Arial", 12, "bold"))

    def _build_ui(self):
        self._build_toolbar()
        self._build_main_area()

    def _build_toolbar(self):
        top = ttk.Frame(self, padding=(12, 10))
        top.pack(fill="x")

        left = ttk.Frame(top)
        left.pack(side="left")

        ttk.Button(left, text="Загрузить Excel", command=self.load_excel).pack(side="left", padx=(0, 8))
        ttk.Button(left, text="Подтянуть менеджеров из Excel", command=self.merge_managers_from_excel).pack(side="left", padx=(0, 8))
        ttk.Button(left, text="Запустить распределение", command=self.run_distribution).pack(side="left", padx=(0, 8))
        ttk.Button(left, text="Сохранить результат", command=self.save_result).pack(side="left", padx=(0, 8))
        ttk.Button(left, text="Сохранить managers.json", command=self.save_managers).pack(side="left")

        right = ttk.Frame(top)
        right.pack(side="right")

        self.file_var = tk.StringVar(value="Файл не загружен")
        self.status_var = tk.StringVar(value="Готово")

        ttk.Label(right, textvariable=self.file_var).pack(anchor="e")
        ttk.Label(right, textvariable=self.status_var, style="Header.TLabel").pack(anchor="e", pady=(4, 0))

    def _build_main_area(self):
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=12, pady=(0, 12))

        self.summary_tab = ttk.Frame(self.notebook, padding=8)
        self.moves_tab = ttk.Frame(self.notebook, padding=8)
        self.checks_tab = ttk.Frame(self.notebook, padding=8)
        self.chart_tab = ttk.Frame(self.notebook, padding=8)
        self.managers_tab = ttk.Frame(self.notebook, padding=8)

        self.notebook.add(self.summary_tab, text="Summary")
        self.notebook.add(self.moves_tab, text="Moves")
        self.notebook.add(self.checks_tab, text="Checks")
        self.notebook.add(self.chart_tab, text="Chart")
        self.notebook.add(self.managers_tab, text="Менеджеры")

        self._build_summary_tab()
        self._build_moves_tab()
        self._build_checks_tab()
        self._build_chart_tab()
        self._build_managers_tab()

    def _build_summary_tab(self):
        columns = [
            "manager", "has_cap", "cap_value", "locked_paid",
            "target_total", "fact_total", "delta_total",
            "target_1", "fact_1", "delta_1",
            "target_3", "fact_3", "delta_3",
            "target_12", "fact_12", "delta_12",
        ]
        self.summary_tree = self._create_tree(self.summary_tab, columns)

    def _build_moves_tab(self):
        columns = ["old_manager", "new_manager", "tariff", "paid"]
        self.moves_tree = self._create_tree(self.moves_tab, columns)

    def _build_checks_tab(self):
        self.checks_text = tk.Text(
            self.checks_tab,
            wrap="word",
            font=("Consolas", 11),
            relief="solid",
            borderwidth=1,
        )
        self.checks_text.pack(fill="both", expand=True)

    def _build_chart_tab(self):
        self.chart_container = ttk.Frame(self.chart_tab)
        self.chart_container.pack(fill="both", expand=True)

    def _build_managers_tab(self):
        paned = ttk.Panedwindow(self.managers_tab, orient="horizontal")
        paned.pack(fill="both", expand=True)

        left = ttk.Frame(paned)
        right = ttk.Frame(paned, padding=(12, 0, 0, 0))
        paned.add(left, weight=4)
        paned.add(right, weight=2)

        self.managers_tree = self._create_tree(left, ["name", "is_support", "has_cap", "cap"], selectmode="extended")
        self.managers_tree.bind("<<TreeviewSelect>>", self.on_manager_select)

        editor = ttk.LabelFrame(right, text="Редактор менеджера", padding=12)
        editor.pack(fill="x", pady=(0, 12))

        self.name_var = tk.StringVar()
        self.is_support_var = tk.BooleanVar(value=False)
        self.has_cap_var = tk.BooleanVar(value=False)
        self.cap_var = tk.StringVar()

        ttk.Label(editor, text="Имя").pack(anchor="w")
        self.name_entry = ttk.Entry(editor, textvariable=self.name_var)
        self.name_entry.pack(fill="x", pady=(4, 10))

        ttk.Checkbutton(
            editor,
            text="Участвует в сопровождении",
            variable=self.is_support_var,
        ).pack(anchor="w", pady=(0, 8))

        ttk.Checkbutton(
            editor,
            text="Есть cap",
            variable=self.has_cap_var,
            command=self._toggle_cap_state,
        ).pack(anchor="w")

        ttk.Label(editor, text="Значение cap").pack(anchor="w", pady=(10, 0))
        self.cap_entry = ttk.Entry(editor, textvariable=self.cap_var)
        self.cap_entry.pack(fill="x", pady=(4, 10))

        btns = ttk.Frame(editor)
        btns.pack(fill="x", pady=(4, 0))
        ttk.Button(btns, text="Новый", command=self.clear_manager_form).pack(fill="x", pady=3)
        ttk.Button(btns, text="Добавить / обновить", command=self.add_or_update_manager).pack(fill="x", pady=3)
        ttk.Button(btns, text="Удалить выбранного", command=self.delete_selected_manager).pack(fill="x", pady=3)

        actions = ttk.LabelFrame(right, text="Действия", padding=12)
        actions.pack(fill="x")

        ttk.Button(actions, text="Подтянуть из Excel", command=self.merge_managers_from_excel).pack(fill="x", pady=3)
        ttk.Button(actions, text="Сохранить managers.json", command=self.save_managers).pack(fill="x", pady=3)
        ttk.Button(actions, text="Перезагрузить managers.json", command=self.reload_managers).pack(fill="x", pady=3)

        hint = (
            "Логика:\n"
            "• paid на support не двигаются\n"
            "• paid/unpaid с non-support уходят на support\n"
            "• unpaid внутри support двигаются минимально\n"
            f"• допуски: total ±5, тарифы ±3"
        )
        ttk.Label(right, text=hint, justify="left").pack(anchor="w", pady=(12, 0))

        self._toggle_cap_state()

    def _create_tree(self, parent, columns, selectmode="browse"):
        frame = ttk.Frame(parent)
        frame.pack(fill="both", expand=True)

        tree = ttk.Treeview(frame, columns=columns, show="headings", selectmode=selectmode)
        y_scroll = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        x_scroll = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)

        tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

        tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")

        for col in columns:
            tree.heading(col, text=col)
            tree.column(col, width=120, anchor="center")

        wide_cols = {"manager", "name", "old_manager", "new_manager"}
        for col in columns:
            if col in wide_cols:
                tree.column(col, width=280, anchor="w")

        return tree

    def load_excel(self):
        path = filedialog.askopenfilename(
            title="Выбери Excel-файл",
            filetypes=[("Excel files", "*.xlsx *.xls")],
        )
        if not path:
            return

        try:
            df = pd.read_excel(path)
            self.input_df = df
            self.input_path = path
            self.file_var.set(os.path.basename(path))
            self.status_var.set("Excel загружен")

            if COL_MANAGER in df.columns:
                self.managers_config = ensure_managers_present(
                    self.managers_config,
                    df[COL_MANAGER].dropna().astype(str).str.strip().tolist(),
                )
                self._refresh_managers_tree()

        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось прочитать Excel:\n{e}")

    def merge_managers_from_excel(self):
        if self.input_df is None:
            messagebox.showwarning("Внимание", "Сначала загрузи Excel.")
            return

        if COL_MANAGER not in self.input_df.columns:
            messagebox.showerror("Ошибка", f"В Excel нет колонки '{COL_MANAGER}'.")
            return

        self.managers_config = ensure_managers_present(
            self.managers_config,
            self.input_df[COL_MANAGER].dropna().astype(str).str.strip().tolist(),
        )
        self._refresh_managers_tree()
        self.status_var.set("Менеджеры подтянуты из Excel")

    def save_managers(self):
        try:
            save_managers_config(self.managers_config, self.config_path)
            self.status_var.set("managers.json сохранён")
            messagebox.showinfo("Готово", "Конфиг менеджеров сохранён.")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось сохранить managers.json:\n{e}")

    def reload_managers(self):
        try:
            self.managers_config = load_managers_config(self.config_path)
            if self.input_df is not None and COL_MANAGER in self.input_df.columns:
                self.managers_config = ensure_managers_present(
                    self.managers_config,
                    self.input_df[COL_MANAGER].dropna().astype(str).str.strip().tolist(),
                )
            self._refresh_managers_tree()
            self.status_var.set("managers.json перезагружен")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось перезагрузить managers.json:\n{e}")

    def run_distribution(self):
        if self.input_df is None:
            messagebox.showwarning("Внимание", "Сначала загрузи Excel.")
            return

        try:
            self.result = distribute_cash_registers(self.input_df, self.managers_config)
            self._render_result(self.result)
            self.status_var.set("Распределение завершено")
            self.notebook.select(self.summary_tab)
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось выполнить распределение:\n{e}")

    def save_result(self):
        if not self.result:
            messagebox.showwarning("Внимание", "Сначала запусти распределение.")
            return

        path = filedialog.asksaveasfilename(
            title="Сохранить результат",
            defaultextension=".xlsx",
            filetypes=[("Excel files", "*.xlsx")],
        )
        if not path:
            return

        try:
            with pd.ExcelWriter(path, engine="openpyxl") as writer:
                self.result.output_df.to_excel(writer, index=False, sheet_name="result")
                self.result.summary_df.to_excel(writer, index=False, sheet_name="summary")
                self.result.moves_df.to_excel(writer, index=False, sheet_name="moves")
                pd.DataFrame({"checks": self.result.checks}).to_excel(
                    writer, index=False, sheet_name="checks"
                )
            self.status_var.set("Результат сохранён")
            messagebox.showinfo("Готово", f"Результат сохранён:\n{path}")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Не удалось сохранить результат:\n{e}")

    def _refresh_tree_data(self, tree, df: pd.DataFrame):
        for item in tree.get_children():
            tree.delete(item)

        if df is None or df.empty:
            return

        cols = list(df.columns)
        tree["columns"] = cols

        for col in cols:
            tree.heading(col, text=col)
            width = 120
            anchor = "center"
            if col in {"manager", "name", "old_manager", "new_manager"}:
                width = 280
                anchor = "w"
            tree.column(col, width=width, anchor=anchor)

        for _, row in df.iterrows():
            values = []
            for c in cols:
                val = row[c]
                if pd.isna(val):
                    val = ""
                values.append(val)
            tree.insert("", "end", values=values)

    def _render_result(self, result: DistributionResult):
        self._refresh_tree_data(self.summary_tree, result.summary_df)
        self._refresh_tree_data(self.moves_tree, result.moves_df)

        self.checks_text.delete("1.0", tk.END)
        self.checks_text.insert("1.0", "\n".join(result.checks))

        self._render_chart(result.chart_df)

    def _render_chart(self, chart_df: pd.DataFrame):
        for widget in self.chart_container.winfo_children():
            widget.destroy()

        if chart_df is None or chart_df.empty:
            return

        fig, ax = plt.subplots(figsize=(12, 5))
        x = list(range(len(chart_df)))

        ax.bar(x, chart_df["fact_total"], label="fact_total")
        ax.plot(x, chart_df["target_total"], marker="o", linewidth=2, label="target_total")

        ax.set_xticks(x)
        ax.set_xticklabels(chart_df["manager"], rotation=45, ha="right")
        ax.set_ylabel("Кассы")
        ax.set_title("Факт vs target")
        ax.legend()
        fig.tight_layout()

        canvas = FigureCanvasTkAgg(fig, master=self.chart_container)
        canvas.draw()
        canvas.get_tk_widget().pack(fill="both", expand=True)

    def _refresh_managers_tree(self):
        rows = []
        for item in self.managers_config.get("managers", []):
            rows.append(
                {
                    "name": item.get("name", ""),
                    "is_support": "Да" if item.get("is_support") else "Нет",
                    "has_cap": "Да" if item.get("has_cap") else "Нет",
                    "cap": item.get("cap", "") if item.get("has_cap") else "",
                }
            )
        df = pd.DataFrame(rows, columns=["name", "is_support", "has_cap", "cap"])
        self._refresh_tree_data(self.managers_tree, df)

    def on_manager_select(self, _event=None):
        selected = self.managers_tree.selection()
        if not selected:
            return

        if len(selected) == 1:
            values = self.managers_tree.item(selected[0], "values")
            if not values:
                return
            name, is_support, has_cap, cap = values
            self.name_var.set(str(name))
            self.name_entry.configure(state="normal")
            self.is_support_var.set(str(is_support) == "Да")
            self.has_cap_var.set(str(has_cap) == "Да")
            self.cap_var.set("" if cap in (None, "", "nan") else str(cap))
        else:
            self.name_var.set(f"(выбрано {len(selected)})")
            self.name_entry.configure(state="disabled")

            is_support_vals, has_cap_vals, cap_vals = set(), set(), set()
            for item_id in selected:
                values = self.managers_tree.item(item_id, "values")
                if values:
                    _, is_support, has_cap, cap = values
                    is_support_vals.add(str(is_support) == "Да")
                    has_cap_vals.add(str(has_cap) == "Да")
                    cap_vals.add("" if cap in (None, "", "nan") else str(cap))

            self.is_support_var.set(is_support_vals == {True})
            self.has_cap_var.set(has_cap_vals == {True})
            self.cap_var.set(cap_vals.pop() if len(cap_vals) == 1 else "")

        self._toggle_cap_state()

    def _toggle_cap_state(self):
        if self.has_cap_var.get():
            self.cap_entry.configure(state="normal")
        else:
            self.cap_entry.configure(state="disabled")
            self.cap_var.set("")

    def clear_manager_form(self):
        self.name_var.set("")
        self.name_entry.configure(state="normal")
        self.is_support_var.set(False)
        self.has_cap_var.set(False)
        self.cap_var.set("")
        self._toggle_cap_state()

    def add_or_update_manager(self):
        selected = self.managers_tree.selection()
        has_cap = self.has_cap_var.get()
        cap = None

        if has_cap:
            raw_cap = self.cap_var.get().strip()
            if not raw_cap:
                messagebox.showwarning("Внимание", "Укажи значение cap.")
                return
            try:
                cap = int(raw_cap)
                if cap <= 0:
                    raise ValueError
            except Exception:
                messagebox.showwarning("Внимание", "Cap должен быть положительным целым числом.")
                return

        if len(selected) > 1:
            names = [
                str(self.managers_tree.item(iid, "values")[0])
                for iid in selected
                if self.managers_tree.item(iid, "values")
            ]
            for manager_name in names:
                for item in self.managers_config.get("managers", []):
                    if str(item.get("name", "")).strip().lower() == manager_name.lower():
                        item["is_support"] = self.is_support_var.get()
                        item["has_cap"] = has_cap
                        item["cap"] = cap if has_cap else None
                        break
            self.managers_config["managers"] = sorted(
                self.managers_config["managers"],
                key=lambda x: str(x.get("name", "")).lower(),
            )
            self._refresh_managers_tree()
            self.status_var.set(f"Обновлено {len(names)} менеджеров")
            return

        name = self.name_var.get().strip()
        if not name:
            messagebox.showwarning("Внимание", "Укажи имя менеджера.")
            return

        payload = {
            "name": name,
            "is_support": self.is_support_var.get(),
            "has_cap": has_cap,
            "cap": cap if has_cap else None,
        }

        existing = None
        for item in self.managers_config.get("managers", []):
            if str(item.get("name", "")).strip().lower() == name.lower():
                existing = item
                break

        if existing is not None:
            existing.update(payload)
        else:
            self.managers_config.setdefault("managers", []).append(payload)

        self.managers_config["managers"] = sorted(
            self.managers_config["managers"],
            key=lambda x: str(x.get("name", "")).lower(),
        )
        self._refresh_managers_tree()
        self.status_var.set("Менеджер сохранён")

    def delete_selected_manager(self):
        selected = self.managers_tree.selection()
        if not selected:
            messagebox.showwarning("Внимание", "Выбери менеджера.")
            return

        names = [
            str(self.managers_tree.item(iid, "values")[0])
            for iid in selected
            if self.managers_tree.item(iid, "values")
        ]
        if not names:
            return

        if len(names) == 1:
            confirm = messagebox.askyesno("Подтверждение", f"Удалить менеджера '{names[0]}'?")
        else:
            preview = "\n".join(f"• {n}" for n in names)
            confirm = messagebox.askyesno(
                "Подтверждение",
                f"Удалить {len(names)} менеджеров?\n{preview}",
            )
        if not confirm:
            return

        names_lower = {n.lower() for n in names}
        self.managers_config["managers"] = [
            x for x in self.managers_config.get("managers", [])
            if str(x.get("name", "")).strip().lower() not in names_lower
        ]
        self._refresh_managers_tree()
        self.clear_manager_form()
        self.status_var.set(f"Удалено менеджеров: {len(names)}")


if __name__ == "__main__":
    app = KassaDistributionApp()
    app.mainloop()