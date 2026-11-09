// The application window: toolbar, tabs, and the actions behind the buttons.

import {
  type ManagerEntry,
  type ManagersConfig,
  defaultConfig,
  ensureManagersPresent,
  parseManagersConfig,
  serializeManagersConfig,
} from "../core/config.ts";
import { COL_MANAGER } from "../core/constants.ts";
import { type DistributionResult, type MoveRow, type SummaryRow, distribute } from "../core/distribute.ts";
import { type Table, managersFromTable } from "../core/table.ts";
import { buildResultWorkbook, readInputTable } from "../core/xlsx.ts";
import type { Platform } from "../platform/types.ts";
import { renderChart } from "./chart.ts";
import { type Column, dataTable } from "./datatable.ts";
import { confirmDialog, showMessage } from "./dialogs.ts";
import { clear, h } from "./dom.ts";
import { createManagersTab } from "./managers-tab.ts";

type TabId = "summary" | "moves" | "checks" | "chart" | "managers";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "moves", label: "Moves" },
  { id: "checks", label: "Checks" },
  { id: "chart", label: "Chart" },
  { id: "managers", label: "Менеджеры" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function deltaClass(value: number): string {
  return value === 0 ? "muted" : "delta";
}

const summaryColumns: Column<SummaryRow>[] = [
  { label: "Менеджер", value: (r) => r.name },
  { label: "Почта", value: (r) => r.manager, cellClass: () => "muted" },
  { label: "Cap", align: "right", value: (r) => (r.has_cap ? r.cap_value : "—"), cellClass: (r) => (r.has_cap ? undefined : "muted") },
  { label: "Оплачено", align: "right", value: (r) => r.locked_paid },
  { label: "Цель", group: "Всего", align: "right", value: (r) => r.target_total },
  { label: "Факт", group: "Всего", align: "right", value: (r) => r.fact_total, cellClass: () => "strong" },
  { label: "Δ", group: "Всего", align: "right", value: (r) => r.delta_total, cellClass: (r) => deltaClass(r.delta_total) },
  { label: "Цель", group: "1 мес", align: "right", value: (r) => r.target_1 },
  { label: "Факт", group: "1 мес", align: "right", value: (r) => r.fact_1 },
  { label: "Δ", group: "1 мес", align: "right", value: (r) => r.delta_1, cellClass: (r) => deltaClass(r.delta_1) },
  { label: "Цель", group: "3 мес", align: "right", value: (r) => r.target_3 },
  { label: "Факт", group: "3 мес", align: "right", value: (r) => r.fact_3 },
  { label: "Δ", group: "3 мес", align: "right", value: (r) => r.delta_3, cellClass: (r) => deltaClass(r.delta_3) },
  { label: "Цель", group: "12 мес", align: "right", value: (r) => r.target_12 },
  { label: "Факт", group: "12 мес", align: "right", value: (r) => r.fact_12 },
  { label: "Δ", group: "12 мес", align: "right", value: (r) => r.delta_12, cellClass: (r) => deltaClass(r.delta_12) },
];

const movesColumns: Column<MoveRow>[] = [
  { label: "ИНН", value: (r) => (r.inn === null ? "" : String(r.inn)), cellClass: () => "mono" },
  { label: "Был", value: (r) => r.old_manager },
  { label: "Стал", value: (r) => r.new_manager },
  { label: "Тариф", align: "right", value: (r) => r.tariff },
  { label: "Оплачена", align: "center", value: (r) => (r.paid === 1 ? "Да" : "—"), cellClass: (r) => (r.paid === 1 ? "yes" : "muted") },
];

function checkLineClass(line: string): string {
  if (line.startsWith("ПРЕВЫШЕН") || line.includes(": НЕТ")) return "check-bad";
  if (line.includes(": ДА")) return "check-good";
  if (line.startsWith("  ")) return "check-detail";
  return "";
}

function stat(label: string, value: number): HTMLElement {
  return h("div", { class: "stat" }, h("span", { class: "stat-value" }, value.toLocaleString("ru-RU")), h("span", { class: "stat-label" }, label));
}

function emptyState(text: string): HTMLElement {
  return h("div", { class: "empty" }, h("p", {}, text));
}

function resultName(sourceName: string): string {
  return `${sourceName.replace(/\.xlsx$/i, "")}-result.xlsx`;
}

export interface AppHandle {
  /** Loads an already parsed export, as if it had been picked from disk. */
  loadTable(table: Table, name: string): Promise<void>;
  /** Loads the bytes of an .xlsx export, as if it had been picked from disk. */
  loadExcelFile(name: string, data: ArrayBuffer): Promise<void>;
  run(): void;
  /** The result workbook that "Сохранить результат" would write. */
  exportResult(): Promise<Uint8Array>;
}

export async function createApp(root: HTMLElement, platform: Platform): Promise<AppHandle> {
  let config: ManagersConfig = defaultConfig();
  let table: Table | null = null;
  let fileName: string | null = null;
  let last: { result: DistributionResult; sourceName: string } | null = null;

  const fileLabel = h("span", { class: "file-label" }, "Файл не загружен");
  const statusLabel = h("span", { class: "status", role: "status", "aria-live": "polite" }, "Готово");
  const setStatus = (text: string) => {
    statusLabel.textContent = text;
  };

  // ---- config -------------------------------------------------------------------------------

  async function persistConfig(): Promise<void> {
    try {
      await platform.writeConfig(serializeManagersConfig(config));
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось сохранить managers.json:\n${errorText(error)}`);
    }
  }

  const managersTab = createManagersTab({
    config: () => config,
    update(managers: ManagerEntry[], status: string) {
      config = { version: 2, managers };
      setStatus(status);
      managersTab.refresh();
      void persistConfig();
    },
    hasExcel: () => table !== null,
    mergeFromExcel,
    importConfig: () => void importConfig(),
    reloadConfig: () => void reloadConfig(),
    warn: (text) => void showMessage("warning", "Внимание", text),
    confirmDelete(names) {
      const text =
        names.length === 1 ? `Удалить менеджера '${names[0]}'?` : `Удалить ${names.length} менеджеров?\n${names.map((n) => `• ${n}`).join("\n")}`;
      return confirmDialog("Подтверждение", text, "Удалить");
    },
    configLocation: () => platform.describeConfigLocation(),
  });

  function withExportManagers(next: ManagersConfig): ManagersConfig {
    return table !== null && table.columns.includes(COL_MANAGER) ? ensureManagersPresent(next, managersFromTable(table)) : next;
  }

  function mergeFromExcel(): void {
    if (table === null) {
      void showMessage("warning", "Внимание", "Сначала загрузи Excel.");
      return;
    }
    if (!table.columns.includes(COL_MANAGER)) {
      void showMessage("error", "Ошибка", `В Excel нет колонки '${COL_MANAGER}'.`);
      return;
    }
    config = ensureManagersPresent(config, managersFromTable(table));
    managersTab.refresh();
    setStatus("Менеджеры подтянуты из Excel");
    void persistConfig();
  }

  async function reloadConfig(): Promise<void> {
    try {
      const text = await platform.readConfig();
      config = withExportManagers(text === null ? defaultConfig() : parseManagersConfig(text));
      managersTab.refresh();
      setStatus("managers.json перезагружен");
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось перезагрузить managers.json:\n${errorText(error)}`);
    }
  }

  async function importConfig(): Promise<void> {
    let picked;
    try {
      picked = await platform.pickConfigFile();
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось открыть файл:\n${errorText(error)}`);
      return;
    }
    if (picked === null) return;

    let imported: ManagersConfig;
    try {
      imported = parseManagersConfig(picked.text);
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось прочитать ${picked.name}:\n${errorText(error)}`);
      return;
    }
    if (imported.managers.length === 0) {
      await showMessage("warning", "Внимание", `В ${picked.name} нет ни одного менеджера.`);
      return;
    }
    if (config.managers.length > 0) {
      const ok = await confirmDialog(
        "Импорт managers.json",
        `Заменить текущий список (${config.managers.length}) менеджерами из ${picked.name} (${imported.managers.length})?`,
        "Заменить",
      );
      if (!ok) return;
    }
    config = withExportManagers(imported);
    managersTab.refresh();
    setStatus(`Импортировано менеджеров: ${imported.managers.length}`);
    await persistConfig();
  }

  // ---- Excel and distribution --------------------------------------------------------------

  async function loadTable(next: Table, name: string): Promise<void> {
    table = next;
    fileName = name;
    fileLabel.textContent = name;
    setStatus("Excel загружен");
    if (next.columns.includes(COL_MANAGER)) {
      config = ensureManagersPresent(config, managersFromTable(next));
      managersTab.refresh();
      await persistConfig();
    }
  }

  async function loadExcelFile(name: string, data: ArrayBuffer): Promise<void> {
    try {
      await loadTable(await readInputTable(data), name);
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось прочитать Excel:\n${errorText(error)}`);
    }
  }

  async function loadExcel(): Promise<void> {
    try {
      const picked = await platform.pickExcel();
      if (picked !== null) await loadExcelFile(picked.name, picked.data);
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось прочитать Excel:\n${errorText(error)}`);
    }
  }

  async function exportResult(): Promise<Uint8Array> {
    if (last === null) throw new Error("Сначала запусти распределение.");
    return new Uint8Array(await (await buildResultWorkbook(last.result)).arrayBuffer());
  }

  function run(): void {
    if (table === null) {
      void showMessage("warning", "Внимание", "Сначала загрузи Excel.");
      return;
    }
    try {
      const result = distribute(table, config);
      last = { result, sourceName: fileName ?? "result.xlsx" };
      renderResult(result);
      setStatus("Распределение завершено");
      selectTab("summary");
    } catch (error) {
      void showMessage("error", "Ошибка", `Не удалось выполнить распределение:\n${errorText(error)}`);
    }
  }

  async function saveResult(): Promise<void> {
    if (last === null) {
      await showMessage("warning", "Внимание", "Сначала запусти распределение.");
      return;
    }
    try {
      const path = await platform.saveExcel(resultName(last.sourceName), await exportResult());
      if (path === null) return;
      setStatus("Результат сохранён");
      await showMessage("info", "Готово", `Результат сохранён:\n${path}`);
    } catch (error) {
      await showMessage("error", "Ошибка", `Не удалось сохранить результат:\n${errorText(error)}`);
    }
  }

  // ---- layout -------------------------------------------------------------------------------

  const panels = new Map<TabId, HTMLElement>(TABS.map(({ id }) => [id, h("section", { class: "panel", id: `panel-${id}`, role: "tabpanel", "aria-labelledby": `tab-${id}` })]));
  const tabButtons = new Map<TabId, HTMLButtonElement>();

  function selectTab(id: TabId): void {
    for (const [tabId, button] of tabButtons) {
      const active = tabId === id;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      panels.get(tabId)!.hidden = !active;
    }
  }

  const tabBar = h(
    "div",
    {
      class: "tabs",
      role: "tablist",
      onkeydown: (event: KeyboardEvent) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const ids = TABS.map((t) => t.id);
        const current = ids.findIndex((id) => tabButtons.get(id)!.getAttribute("aria-selected") === "true");
        const next = ids[(current + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length]!;
        selectTab(next);
        tabButtons.get(next)!.focus();
      },
    },
    ...TABS.map(({ id, label }) => {
      const button = h("button", { class: "tab", id: `tab-${id}`, role: "tab", "aria-controls": `panel-${id}`, onclick: () => selectTab(id) }, label);
      tabButtons.set(id, button);
      return button;
    }),
  );

  const toolbar = h(
    "header",
    { class: "toolbar" },
    h(
      "div",
      { class: "toolbar-actions" },
      h("button", { class: "btn", onclick: () => void loadExcel() }, "Загрузить Excel"),
      h("button", { class: "btn", onclick: mergeFromExcel }, "Подтянуть менеджеров из Excel"),
      h("button", { class: "btn btn-primary", onclick: run }, "Запустить распределение"),
      h("button", { class: "btn", onclick: () => void saveResult() }, "Сохранить результат"),
    ),
    h("div", { class: "toolbar-info" }, fileLabel, statusLabel),
  );

  function setPanel(id: TabId, ...content: Node[]): void {
    const panel = panels.get(id)!;
    clear(panel);
    panel.append(...content);
  }

  function renderResult(result: DistributionResult): void {
    const inLayout = result.summary.reduce((sum, r) => sum + r.fact_total, 0);
    const total = result.newManagerEmails.length;

    setPanel(
      "summary",
      h("div", { class: "stats" }, stat("строк в выгрузке", total), stat("в раскладке", inLayout), stat("заморожено", total - inLayout), stat("перемещений", result.moves.length)),
      dataTable(summaryColumns, result.summary).el,
    );
    setPanel(
      "moves",
      result.moves.length === 0 ? emptyState("Перемещений нет: все кассы уже стоят где нужно.") : dataTable(movesColumns, result.moves).el,
    );
    setPanel(
      "checks",
      h(
        "div",
        { class: "checks" },
        ...result.checks.map((line) => h("div", { class: `check-line ${checkLineClass(line)}` }, line === "" ? " " : line)),
      ),
    );
    setPanel("chart", renderChart(result.chart));
  }

  setPanel("summary", emptyState("Загрузи Excel, проверь менеджеров и нажми «Запустить распределение»."));
  setPanel("moves", emptyState("Здесь появится лог перемещений."));
  setPanel("checks", emptyState("Здесь появятся проверки результата."));
  setPanel("chart", emptyState("Здесь появится график «факт против таргета»."));
  setPanel("managers", managersTab.el);

  root.append(toolbar, tabBar, h("main", { class: "panels" }, ...TABS.map(({ id }) => panels.get(id)!)));
  selectTab("summary");

  // ---- start --------------------------------------------------------------------------------

  try {
    const text = await platform.readConfig();
    if (text === null) {
      config = defaultConfig();
      await persistConfig();
    } else {
      config = parseManagersConfig(text);
    }
  } catch (error) {
    await showMessage(
      "error",
      "Ошибка",
      `Не удалось прочитать конфиг менеджеров, начинаю с пустого:\n${errorText(error)}\n\nПервое же изменение перезапишет файл. Старый managers.json можно подтянуть кнопкой «Импортировать managers.json…».`,
    );
  }
  managersTab.refresh();

  return { loadTable, loadExcelFile, run, exportResult };
}
