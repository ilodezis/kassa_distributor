// The real platform: native dialogs and files through the Tauri plugins.
//
// The managers config lives in the app data folder (on macOS ~/Library/Application Support/
// <bundle identifier>/managers.json), never inside the .app bundle: the bundle is replaced on
// every update and may be read-only.

import { getVersion } from "@tauri-apps/api/app";
import { appDataDir, dataDir, join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { type AvailableUpdate, CONFIG_FILE, type PickedFile, type PickedText, type Platform, type Updates } from "./types.ts";

// Where the old Python app kept its managers.json when built for macOS.
const LEGACY_APP_DIR = "KassaDistributor";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function configPath(): Promise<string> {
  return join(await appDataDir(), CONFIG_FILE);
}

// Where to look, the public key and the anti-downgrade rule (requireSignedVersion) are set in
// tauri.conf.json, on the Rust side: the page can ask for an update, not choose where it comes from.
const CHECK_TIMEOUT_MS = 30_000;

function createTauriUpdates(): Updates {
  return {
    currentVersion: getVersion,

    async check(): Promise<AvailableUpdate | null> {
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (update === null) return null;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body?.trim() ?? "",
        async install(onProgress) {
          let downloaded = 0;
          let total: number | null = null;
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") total = event.data.contentLength ?? null;
            else if (event.event === "Progress") downloaded += event.data.chunkLength;
            else downloaded = total ?? downloaded;
            onProgress({ downloaded, total });
          });
        },
        dispose: () => update.close(),
      };
    },

    restart: relaunch,
  };
}

export function createTauriPlatform(): Platform {
  return {
    async pickExcel(): Promise<PickedFile | null> {
      const path = await open({
        title: "Выбери Excel-файл",
        multiple: false,
        directory: false,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (path === null) return null;
      const bytes = await readFile(path);
      return { name: baseName(path), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    },

    async saveExcel(suggestedName: string, data: Uint8Array): Promise<string | null> {
      const path = await save({
        title: "Сохранить результат",
        defaultPath: suggestedName,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (path === null) return null;
      await writeFile(path, data);
      return path;
    },

    async pickConfigFile(): Promise<PickedText | null> {
      let defaultPath: string | undefined;
      try {
        defaultPath = await join(await dataDir(), LEGACY_APP_DIR);
      } catch {
        defaultPath = undefined;
      }
      const path = await open({
        title: "Выбери managers.json",
        multiple: false,
        directory: false,
        defaultPath,
        filters: [{ name: "managers.json", extensions: ["json"] }],
      });
      if (path === null) return null;
      return { name: baseName(path), text: await readTextFile(path) };
    },

    async readConfig(): Promise<string | null> {
      const path = await configPath();
      if (!(await exists(path))) return null;
      return readTextFile(path);
    },

    async writeConfig(text: string): Promise<void> {
      const dir = await appDataDir();
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      await writeTextFile(await join(dir, CONFIG_FILE), text);
    },

    describeConfigLocation: configPath,

    updates: createTauriUpdates(),
  };
}
