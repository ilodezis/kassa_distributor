// A staged update for the dev server: the whole flow (notice, dialog, progress, restart)
// without a release or a signed package. Never part of a production build.

import type { AvailableUpdate, Updates } from "./types.ts";

const SIZE = 9_800_000;
const STEPS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeUpdates(options: { fail: boolean }): Updates {
  return {
    currentVersion: async () => "2.1.0",

    async check(): Promise<AvailableUpdate | null> {
      await sleep(400);
      return {
        version: "2.2.0",
        currentVersion: "2.1.0",
        notes: "Кассы со статусом cancelled не участвуют в распределении и подписаны в логе проверок.\nОбновления приходят сами: приложение проверяет подпись и ставит новую версию по кнопке.",
        async install(onProgress) {
          for (let step = 1; step <= STEPS; step += 1) {
            await sleep(60);
            onProgress({ downloaded: Math.round((SIZE * step) / STEPS), total: SIZE });
            if (options.fail && step === STEPS / 2) throw new Error("connection reset while downloading");
          }
        },
        dispose: async () => undefined,
      };
    },

    restart: async () => location.reload(),
  };
}
