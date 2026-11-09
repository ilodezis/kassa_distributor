// The "Менеджеры" tab: the list of managers with multi-select, and the editor next to it.

import { type ManagerEntry, type ManagersConfig, managerKey } from "../core/config.ts";
import { PERIOD_TOLERANCE, TOTAL_TOLERANCE } from "../core/constants.ts";
import { deleteManagers, saveManager } from "../core/editor.ts";
import { type Column, dataTable } from "./datatable.ts";
import { h } from "./dom.ts";

export interface ManagersTabHost {
  config(): ManagersConfig;
  /** Replaces the managers, saves the config file and refreshes everything that shows it. */
  update(managers: ManagerEntry[], status: string): void;
  hasExcel(): boolean;
  mergeFromExcel(): void;
  importConfig(): void;
  reloadConfig(): void;
  warn(text: string): void;
  confirmDelete(names: string[]): Promise<boolean>;
  configLocation(): Promise<string>;
}

const yesNo = (value: boolean) => (value ? "Да" : "Нет");

export function createManagersTab(host: ManagersTabHost): { el: HTMLElement; refresh: () => void } {
  let selected = new Set<string>();
  let anchor = -1;

  const listHost = h("div", { class: "managers-list" });
  const nameInput = h("input", { type: "text", id: "mgr-name", autocomplete: "off", spellcheck: "false" });
  const emailInput = h("input", { type: "text", id: "mgr-email", autocomplete: "off", spellcheck: "false", placeholder: "ivanov@company.ru" });
  const supportInput = h("input", { type: "checkbox", id: "mgr-support" });
  const hasCapInput = h("input", { type: "checkbox", id: "mgr-hascap" });
  const capInput = h("input", { type: "text", id: "mgr-cap", inputmode: "numeric", autocomplete: "off" });
  const locationNote = h("p", { class: "note" });

  const entries = () => host.config().managers;

  function toggleCapState(): void {
    capInput.disabled = !hasCapInput.checked;
    if (!hasCapInput.checked) capInput.value = "";
  }

  function setEditable(editable: boolean): void {
    nameInput.disabled = !editable;
    emailInput.disabled = !editable;
  }

  function fillForm(): void {
    const chosen = entries().filter((item) => selected.has(managerKey(item)));
    if (chosen.length === 0) return;

    if (chosen.length === 1) {
      const item = chosen[0]!;
      setEditable(true);
      nameInput.value = item.name;
      emailInput.value = item.email;
      supportInput.checked = item.is_support;
      hasCapInput.checked = item.has_cap;
      capInput.value = item.has_cap && item.cap !== null ? String(item.cap) : "";
    } else {
      setEditable(false);
      nameInput.value = `(выбрано ${chosen.length})`;
      emailInput.value = "";
      supportInput.checked = chosen.every((item) => item.is_support);
      hasCapInput.checked = chosen.every((item) => item.has_cap);
      const caps = new Set(chosen.map((item) => (item.has_cap && item.cap !== null ? String(item.cap) : "")));
      capInput.value = caps.size === 1 ? [...caps][0]! : "";
    }
    toggleCapState();
  }

  function clearForm(): void {
    selected = new Set();
    anchor = -1;
    nameInput.value = "";
    emailInput.value = "";
    setEditable(true);
    supportInput.checked = false;
    hasCapInput.checked = false;
    capInput.value = "";
    toggleCapState();
    renderList();
  }

  const columns: Column<ManagerEntry>[] = [
    { label: "Имя", value: (m) => m.name },
    {
      label: "Почта",
      value: (m) => (m.email === "" ? "нет почты" : m.email),
      cellClass: (m) => (m.email === "" ? "muted" : undefined),
    },
    { label: "Support", align: "center", value: (m) => yesNo(m.is_support), cellClass: (m) => (m.is_support ? "yes" : "muted") },
    { label: "Cap", align: "right", value: (m) => (m.has_cap && m.cap !== null ? m.cap : "—"), cellClass: (m) => (m.has_cap ? undefined : "muted") },
  ];

  function renderList(): void {
    const items = entries();
    const previousScroll = listHost.querySelector(".table-scroll")?.scrollTop ?? 0;
    const table = dataTable(columns, items, {
      rowClass: (m) =>
        [selected.has(managerKey(m)) ? "selected" : "", m.email === "" && m.is_support ? "attention" : ""].filter(Boolean).join(" "),
    });
    table.el.tabIndex = 0;
    table.el.setAttribute("role", "listbox");
    table.el.setAttribute("aria-multiselectable", "true");

    table.tbody.addEventListener("click", (event) => {
      const row = (event.target as Element).closest("tr");
      if (row === null) return;
      selectRow(Number(row.dataset.index), event as MouseEvent);
    });
    table.el.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const current = anchor >= 0 ? anchor : -1;
      const next = Math.min(items.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
      if (items.length > 0) selectRow(next, event);
    });

    listHost.replaceChildren(table.el);
    if (items.length === 0) {
      listHost.append(h("p", { class: "empty-note" }, "Менеджеров пока нет. Загрузи Excel — они подтянутся из выгрузки."));
    }
    table.el.scrollTop = previousScroll;
  }

  function selectRow(index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
    const items = entries();
    const item = items[index];
    if (item === undefined) return;

    if (event.shiftKey && anchor >= 0) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      selected = new Set(items.slice(from, to + 1).map(managerKey));
    } else if (event.ctrlKey || event.metaKey) {
      const key = managerKey(item);
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      selected = next;
      anchor = index;
    } else {
      selected = new Set([managerKey(item)]);
      anchor = index;
    }
    renderList();
    fillForm();
    listHost.querySelector<HTMLElement>(".table-scroll")?.focus({ preventScroll: true });
  }

  function onSave(): void {
    const result = saveManager(entries(), selected, {
      name: nameInput.value,
      email: emailInput.value,
      isSupport: supportInput.checked,
      hasCap: hasCapInput.checked,
      capText: capInput.value,
    });
    if (!result.ok) {
      host.warn(result.message);
      return;
    }
    selected = new Set(result.savedKeys);
    anchor = -1;
    host.update(result.managers, result.status);
    anchor = entries().findIndex((m) => selected.has(managerKey(m)));
    fillForm();
  }

  async function onDelete(): Promise<void> {
    const chosen = entries().filter((item) => selected.has(managerKey(item)));
    if (chosen.length === 0) {
      host.warn("Выбери менеджера.");
      return;
    }
    if (!(await host.confirmDelete(chosen.map((m) => m.name)))) return;
    const next = deleteManagers(entries(), selected);
    host.update(next, `Удалено менеджеров: ${chosen.length}`);
    clearForm();
  }

  hasCapInput.addEventListener("change", toggleCapState);

  const field = (label: string, input: HTMLElement) =>
    h("label", { class: "field", for: input.id }, h("span", { class: "field-label" }, label), input);
  const check = (label: string, input: HTMLElement) => h("label", { class: "check", for: input.id }, input, h("span", {}, label));

  const editor = h(
    "form",
    {
      class: "card editor",
      onsubmit: (event: Event) => {
        event.preventDefault();
        onSave();
      },
    },
    h("h3", {}, "Редактор менеджера"),
    field("Имя", nameInput),
    field("Почта (ключ, как в выгрузке)", emailInput),
    check("Участвует в сопровождении", supportInput),
    check("Есть cap", hasCapInput),
    field("Значение cap", capInput),
    h(
      "div",
      { class: "button-stack" },
      h("button", { type: "button", class: "btn", onclick: clearForm }, "Новый"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Добавить / обновить"),
      h("button", { type: "button", class: "btn btn-danger-quiet", onclick: () => void onDelete() }, "Удалить выбранного"),
    ),
  );

  const actions = h(
    "div",
    { class: "card" },
    h("h3", {}, "Действия"),
    h(
      "div",
      { class: "button-stack" },
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: () => (host.hasExcel() ? host.mergeFromExcel() : host.warn("Сначала загрузи Excel.")),
        },
        "Подтянуть из Excel",
      ),
      h("button", { type: "button", class: "btn", onclick: () => host.importConfig() }, "Импортировать managers.json…"),
      h("button", { type: "button", class: "btn", onclick: () => host.reloadConfig() }, "Перезагрузить из файла"),
    ),
    locationNote,
  );

  const hint = h(
    "div",
    { class: "hint" },
    h("strong", {}, "Логика"),
    h(
      "ul",
      {},
      h("li", {}, "менеджер определяется по почте"),
      h("li", {}, "paid на support не двигаются"),
      h("li", {}, "paid/unpaid с non-support уходят на support"),
      h("li", {}, "unpaid внутри support двигаются минимально"),
      h("li", {}, "расторжения и незнакомые статусы не двигаются"),
      h("li", {}, `допуски: total ±${TOTAL_TOLERANCE}, тарифы ±${PERIOD_TOLERANCE}`),
    ),
  );

  const el = h("div", { class: "managers-tab" }, listHost, h("aside", { class: "managers-side" }, editor, actions, hint));

  toggleCapState();

  return {
    el,
    refresh(): void {
      const present = new Set(entries().map(managerKey));
      selected = new Set([...selected].filter((key) => present.has(key)));
      renderList();
      void host.configLocation().then((location) => {
        locationNote.textContent = `Изменения сохраняются сами: ${location}`;
      });
    },
  };
}
