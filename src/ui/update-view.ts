// The update notice and the install dialog.
//
// The notice sits at the right end of the tab bar. Normally it is just the version, muted, and
// a click checks for updates by hand. When a newer release is found it turns into an accented
// "Обновление X.Y.Z" that opens the dialog. Nothing pops up by itself: the update waits until
// the user has a moment, and the restart happens only on their click.

import type { UpdateProgress } from "../platform/types.ts";
import { clear, h, s } from "./dom.ts";
import type { UpdateController, UpdateState } from "./update-controller.ts";

const LATEST_NOTICE_MS = 4000;

/** Bytes as megabytes the way a Russian UI writes them: "9,8 МБ". */
export function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0МБ`;
}

/** Whole percent of a download, null when the size is unknown. */
export function progressPercent(progress: UpdateProgress): number | null {
  if (progress.total === null || progress.total <= 0) return null;
  return Math.min(100, Math.floor((progress.downloaded / progress.total) * 100));
}

export function progressText(progress: UpdateProgress): string {
  if (progress.total === null || progress.total <= 0) return `Скачано ${formatSize(progress.downloaded)}`;
  const total = formatSize(progress.total).replace(/\u00a0МБ$/, "");
  return `${formatSize(progress.downloaded).replace(/\u00a0МБ$/, "")} из ${total}\u00a0МБ`;
}

function arrowIcon(): SVGSVGElement {
  // Arrow into a tray: "download", drawn on the 16px grid in the text's stroke weight.
  return s(
    "svg",
    { class: "update-chip-icon", viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", focusable: "false" },
    s("path", { d: "M8 2.5v7M4.75 6.5 8 9.75l3.25-3.25M3 12.5h10", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }),
  );
}

export interface UpdateViewOptions {
  /** True when a distribution result exists that has not been saved yet. */
  hasUnsavedResult: () => boolean;
}

export interface UpdateView {
  /** The notice for the tab bar. */
  chip: HTMLButtonElement;
  render(state: UpdateState): void;
}

export function createUpdateView(controller: UpdateController, options: UpdateViewOptions): UpdateView {
  const chip = h("button", { class: "update-chip", type: "button" });
  let dialog: HTMLDialogElement | null = null;
  // What the dialog shows now: a download in progress is updated in place, not rebuilt.
  let shown: UpdateState["kind"] | null = null;
  let live: { track: HTMLElement; bar: HTMLElement; text: HTMLElement; percent: HTMLElement } | null = null;
  let latestTimer: ReturnType<typeof setTimeout> | undefined;

  const locked = () => {
    const kind = controller.state().kind;
    return kind === "downloading" || kind === "restarting";
  };

  function closeDialog(): void {
    if (dialog === null || locked()) return;
    dialog.close();
    dialog.remove();
    dialog = null;
    shown = null;
    live = null;
  }

  function openDialog(): void {
    if (dialog !== null) return;
    dialog = h("dialog", { class: "modal update-modal", "aria-labelledby": "update-title" });
    // Escape and the backdrop mean "later", except while installing: then there is no going back.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    document.body.append(dialog);
    renderDialog(controller.state());
    dialog.showModal();
  }

  chip.addEventListener("click", () => {
    const state = controller.state();
    switch (state.kind) {
      case "idle":
      case "check-failed":
        void controller.check();
        break;
      case "latest":
        controller.acknowledge();
        break;
      case "checking":
        break;
      default:
        openDialog();
    }
  });

  function renderChip(state: UpdateState): void {
    const version = controller.currentVersion();
    const current = version === null ? "" : `Версия ${version}`;
    chip.dataset.state = state.kind;
    chip.disabled = state.kind === "checking";
    clear(chip);
    switch (state.kind) {
      case "idle":
        chip.append(current);
        chip.title = "Проверить обновления";
        chip.hidden = version === null;
        break;
      case "checking":
        chip.append("Проверяю обновления…");
        chip.title = "";
        chip.hidden = false;
        break;
      case "latest":
        chip.append(`${current} — последняя`);
        chip.title = "Обновлений нет";
        chip.hidden = false;
        break;
      case "check-failed":
        chip.append("Не удалось проверить обновления");
        chip.title = `${state.message}\nНажми, чтобы попробовать снова`;
        chip.hidden = false;
        break;
      case "available":
      case "install-failed":
        chip.append(arrowIcon(), `Обновление ${state.update.version}`);
        chip.title = "Посмотреть, что нового, и установить";
        chip.hidden = false;
        break;
      case "downloading": {
        const percent = progressPercent(state.progress);
        chip.append(arrowIcon(), percent === null ? "Скачиваю обновление…" : `Скачиваю обновление · ${percent}\u00a0%`);
        chip.title = "";
        chip.hidden = false;
        break;
      }
      case "restarting":
        chip.append("Перезапускаю…");
        chip.title = "";
        chip.hidden = false;
        break;
    }
  }

  function setProgress(track: HTMLElement, bar: HTMLElement, percent: number | null): void {
    track.classList.toggle("is-indeterminate", percent === null);
    if (percent === null) {
      track.removeAttribute("aria-valuenow");
      bar.style.removeProperty("width");
    } else {
      track.setAttribute("aria-valuenow", String(percent));
      bar.style.width = `${percent}%`;
    }
  }

  function progressBar(percent: number | null): { track: HTMLElement; bar: HTMLElement } {
    const bar = h("div", { class: "update-progress-bar" });
    const track = h(
      "div",
      { class: "update-progress", role: "progressbar", "aria-label": "Загрузка обновления", "aria-valuemin": 0, "aria-valuemax": 100 },
      bar,
    );
    setProgress(track, bar, percent);
    return { track, bar };
  }

  function renderDialog(state: UpdateState): void {
    if (dialog === null) return;
    if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "restarting" && state.kind !== "install-failed") {
      closeDialog();
      return;
    }
    if (state.kind === "downloading" && shown === "downloading" && live !== null) {
      const percent = progressPercent(state.progress);
      setProgress(live.track, live.bar, percent);
      live.text.textContent = progressText(state.progress);
      live.percent.textContent = percent === null ? "" : `${percent}\u00a0%`;
      return;
    }
    const { update } = state;
    const content: Node[] = [
      h("h2", { class: "modal-title", id: "update-title" }, `Обновление до версии ${update.version}`),
      h("p", { class: "update-meta" }, `Сейчас установлена ${update.currentVersion}. Перед установкой приложение проверит подпись пакета.`),
    ];
    if (update.notes !== "") {
      content.push(h("h3", { class: "update-notes-title" }, "Что нового"), h("div", { class: "update-notes", tabindex: 0 }, update.notes));
    }

    if (state.kind === "available") {
      if (options.hasUnsavedResult()) {
        content.push(h("p", { class: "update-warning" }, "Результат распределения не сохранён. После перезапуска его придётся посчитать заново."));
      }
      content.push(
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: closeDialog }, "Позже"),
          h("button", { class: "btn btn-primary", type: "button", autofocus: true, onclick: () => void controller.install() }, "Обновить и перезапустить"),
        ),
      );
    } else if (state.kind === "downloading") {
      const percent = progressPercent(state.progress);
      const { track, bar } = progressBar(percent);
      const text = h("span", {}, progressText(state.progress));
      const percentLabel = h("span", { class: "update-percent" }, percent === null ? "" : `${percent}\u00a0%`);
      live = { track, bar, text, percent: percentLabel };
      content.push(h("div", { class: "update-status" }, track, h("div", { class: "update-status-line" }, text, percentLabel)));
    } else if (state.kind === "restarting") {
      const { track } = progressBar(100);
      content.push(h("div", { class: "update-status" }, track, h("div", { class: "update-status-line" }, h("span", {}, "Установлено, перезапускаю приложение…"))));
    } else {
      content.push(
        h("p", { class: "update-error", role: "alert" }, `Не получилось обновиться: ${state.message}`, h("br"), "Текущая версия работает как прежде."),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: closeDialog }, "Закрыть"),
          h("button", { class: "btn btn-primary", type: "button", autofocus: true, onclick: () => void controller.install() }, "Попробовать снова"),
        ),
      );
    }

    if (state.kind !== "downloading") live = null;
    shown = state.kind;
    dialog.replaceChildren(...content);
    dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
  }

  function render(state: UpdateState): void {
    clearTimeout(latestTimer);
    if (state.kind === "latest") latestTimer = setTimeout(() => controller.acknowledge(), LATEST_NOTICE_MS);
    renderChip(state);
    renderDialog(state);
  }

  return { chip, render };
}
