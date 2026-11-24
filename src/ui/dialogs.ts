// Modal messages and confirmations built on <dialog>. Native window.alert/confirm are not
// reliable in every webview, and these keep the look of the app.

import { h } from "./dom.ts";

export type MessageKind = "info" | "warning" | "error";

function open(build: (close: (result: boolean) => void) => HTMLElement[], kind: MessageKind, title: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: `modal modal-${kind}` });
    const close = (result: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    // Escape and a click on the backdrop count as "no".
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close(false);
    });
    dialog.append(h("h2", { class: "modal-title" }, title), ...build(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function showMessage(kind: MessageKind, title: string, text: string): Promise<void> {
  await open(
    (close) => [
      h("p", { class: "modal-text" }, text),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn btn-primary", autofocus: true, onclick: () => close(true) }, "Понятно"),
      ),
    ],
    kind,
    title,
  );
}

export function confirmDialog(title: string, text: string, confirmLabel: string): Promise<boolean> {
  return open(
    (close) => [
      h("p", { class: "modal-text" }, text),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", autofocus: true, onclick: () => close(false) }, "Отмена"),
        h("button", { class: "btn btn-danger", onclick: () => close(true) }, confirmLabel),
      ),
    ],
    "warning",
    title,
  );
}

/** Today in the local calendar as `YYYY-MM-DD`, the value format of `<input type="date">`. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Asks for a date. Resolves to `YYYY-MM-DD`, or null when cancelled. */
export function pickDateDialog(title: string, text: string, initial: string, confirmLabel: string): Promise<string | null> {
  let value: string | null = null;
  return open(
    (close) => {
      const input = h("input", { type: "date", id: "dialog-date", value: initial, required: true, autofocus: true });
      const confirm = h("button", { class: "btn btn-primary", type: "submit" }, confirmLabel);
      const sync = () => {
        confirm.disabled = input.value === "";
      };
      input.addEventListener("input", sync);
      const form = h(
        "form",
        {
          onsubmit: (event: SubmitEvent) => {
            event.preventDefault();
            if (input.value === "") return;
            value = input.value;
            close(true);
          },
        },
        h("p", { class: "modal-text" }, text),
        h("label", { class: "field", for: input.id }, h("span", { class: "field-label" }, "Дата переноса"), input),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Отмена"),
          confirm,
        ),
      );
      return [form];
    },
    "info",
    title,
  ).then((ok) => (ok ? value : null));
}
