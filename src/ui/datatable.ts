// A plain data table: sticky header, optional group header row, tabular numerals.

import { type Child, h } from "./dom.ts";

export interface Column<T> {
  label: string;
  /** Header group (e.g. "1 мес"); consecutive columns with the same group share one header cell. */
  group?: string;
  align?: "left" | "right" | "center";
  /** CSS class names for the cell. */
  cellClass?: (row: T) => string | undefined;
  value: (row: T) => Child;
}

export interface DataTable {
  /** Scroll container: put it in the layout. */
  el: HTMLElement;
  tbody: HTMLTableSectionElement;
}

export function dataTable<T>(columns: readonly Column<T>[], rows: readonly T[], options: { rowClass?: (row: T) => string | undefined } = {}): DataTable {
  const table = h("table", { class: "data" });
  const thead = h("thead");

  if (columns.some((c) => c.group !== undefined)) {
    const groups = h("tr", { class: "group-row" });
    for (let i = 0; i < columns.length; ) {
      const group = columns[i]!.group;
      let span = 1;
      while (i + span < columns.length && columns[i + span]!.group === group && group !== undefined) span += 1;
      groups.append(h("th", { colspan: span, class: group === undefined ? "" : "group-cell" }, group));
      i += span;
    }
    thead.append(groups);
  }

  thead.append(
    h("tr", {}, ...columns.map((c) => h("th", { class: `align-${c.align ?? "left"}` }, c.label))),
  );

  const tbody = h("tbody");
  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const tr = h("tr", { "data-index": index, class: options.rowClass?.(row) });
    for (const column of columns) {
      const classes = [`align-${column.align ?? "left"}`, column.cellClass?.(row)].filter(Boolean).join(" ");
      tr.append(h("td", { class: classes }, column.value(row)));
    }
    fragment.append(tr);
  });
  tbody.append(fragment);

  table.append(thead, tbody);
  return { el: h("div", { class: "table-scroll" }, table), tbody };
}
