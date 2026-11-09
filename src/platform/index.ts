import { isTauri } from "@tauri-apps/api/core";

import type { Platform } from "./types.ts";

export type { Platform } from "./types.ts";

export async function createPlatform(): Promise<Platform> {
  if (isTauri()) {
    const { createTauriPlatform } = await import("./tauri.ts");
    return createTauriPlatform();
  }
  const { createWebPlatform } = await import("./web.ts");
  return createWebPlatform();
}
