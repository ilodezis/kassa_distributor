// The Tauri platform: the config must live in the app data folder, never inside the .app bundle.
// (The Python version had the same guard: test_built_app_keeps_config_outside_bundle.)

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_DATA = "/Users/test/Library/Application Support/io.github.ilodezis.kassa-distributor";

const fs = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  dirs: new Set<string>(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => APP_DATA,
  dataDir: async () => "/Users/test/Library/Application Support",
  join: async (...parts: string[]) => parts.join("/"),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) => fs.files.has(path) || fs.dirs.has(path),
  mkdir: async (path: string) => void fs.dirs.add(path),
  readFile: async (path: string) => fs.files.get(path) as Uint8Array,
  readTextFile: async (path: string) => fs.files.get(path) as string,
  writeFile: async (path: string, data: Uint8Array) => void fs.files.set(path, data),
  writeTextFile: async (path: string, text: string) => void fs.files.set(path, text),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { createTauriPlatform } from "../src/platform/tauri.ts";

describe("Tauri platform", () => {
  beforeEach(() => {
    fs.files.clear();
    fs.dirs.clear();
    dialog.open.mockReset();
    dialog.save.mockReset();
  });

  it("keeps the config in the app data folder, creating it on first save", async () => {
    const platform = createTauriPlatform();
    expect(await platform.readConfig()).toBeNull();

    await platform.writeConfig('{"version": 2}');
    expect(fs.dirs.has(APP_DATA)).toBe(true);
    expect([...fs.files.keys()]).toEqual([`${APP_DATA}/managers.json`]);
    expect(await platform.readConfig()).toBe('{"version": 2}');

    const location = await platform.describeConfigLocation();
    expect(location).toBe(`${APP_DATA}/managers.json`);
    expect(location).not.toContain(".app/");
  });

  it("reads a picked export and returns its file name", async () => {
    const path = "/Users/test/Downloads/renewal-distribution-2026-11.xlsx";
    fs.files.set(path, new Uint8Array([1, 2, 3]));
    dialog.open.mockResolvedValue(path);

    const picked = await createTauriPlatform().pickExcel();
    expect(picked?.name).toBe("renewal-distribution-2026-11.xlsx");
    expect([...new Uint8Array(picked!.data)]).toEqual([1, 2, 3]);
    expect(dialog.open.mock.calls[0]![0].filters).toEqual([{ name: "Excel", extensions: ["xlsx"] }]);
  });

  it("returns null when the dialogs are cancelled", async () => {
    dialog.open.mockResolvedValue(null);
    dialog.save.mockResolvedValue(null);
    const platform = createTauriPlatform();
    expect(await platform.pickExcel()).toBeNull();
    expect(await platform.pickConfigFile()).toBeNull();
    expect(await platform.saveExcel("x.xlsx", new Uint8Array([1]))).toBeNull();
    expect(fs.files.size).toBe(0);
  });

  it("saves the result where the user chose and starts the config dialog in the old app's folder", async () => {
    dialog.save.mockResolvedValue("/Users/test/Desktop/out.xlsx");
    const platform = createTauriPlatform();
    expect(await platform.saveExcel("renewal-result.xlsx", new Uint8Array([9, 9]))).toBe("/Users/test/Desktop/out.xlsx");
    expect([...(fs.files.get("/Users/test/Desktop/out.xlsx") as Uint8Array)]).toEqual([9, 9]);
    expect(dialog.save.mock.calls[0]![0].defaultPath).toBe("renewal-result.xlsx");

    fs.files.set("/Users/test/old/managers.json", '{"managers": []}');
    dialog.open.mockResolvedValue("/Users/test/old/managers.json");
    expect(await platform.pickConfigFile()).toEqual({ name: "managers.json", text: '{"managers": []}' });
    expect(dialog.open.mock.calls[0]![0].defaultPath).toBe("/Users/test/Library/Application Support/KassaDistributor");
  });
});
