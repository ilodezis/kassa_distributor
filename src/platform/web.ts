// Browser implementation: lets the UI run in a plain browser (dev server, manual checks).
// The config goes to localStorage, files go through <input type=file> and a download link.
// A browser cannot update an installed app, so there are no updates here; the dev server can
// stage a fake one (?fake-update, ?fake-update=fail) to show the update flow without a release.

import { CONFIG_FILE, type PickedFile, type PickedText, type Platform, type Updates } from "./types.ts";

const STORAGE_KEY = "kassa.managers.json";

function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

async function devUpdates(): Promise<Updates | null> {
  if (!import.meta.env.DEV) return null;
  const mode = new URLSearchParams(location.search).get("fake-update");
  if (mode === null) return null;
  const { createFakeUpdates } = await import("./fake-updates.ts");
  return createFakeUpdates({ fail: mode === "fail" });
}

export async function createWebPlatform(): Promise<Platform> {
  const updates = await devUpdates();
  return {
    async pickExcel(): Promise<PickedFile | null> {
      const file = await chooseFile(".xlsx");
      return file === null ? null : { name: file.name, data: await file.arrayBuffer() };
    },

    async saveExcel(suggestedName: string, data: Uint8Array): Promise<string | null> {
      const url = URL.createObjectURL(
        new Blob([data as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return suggestedName;
    },

    async pickConfigFile(): Promise<PickedText | null> {
      const file = await chooseFile(".json,application/json");
      return file === null ? null : { name: file.name, text: await file.text() };
    },

    async readConfig(): Promise<string | null> {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },

    async writeConfig(text: string): Promise<void> {
      localStorage.setItem(STORAGE_KEY, text);
    },

    async describeConfigLocation(): Promise<string> {
      return `localStorage (${CONFIG_FILE}, браузерный режим)`;
    },

    updates,
  };
}
