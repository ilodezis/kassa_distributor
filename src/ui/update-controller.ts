// What the app knows about updates, without the DOM: the view renders whatever state this holds.
//
// Background checks are silent: a failed one (offline, GitHub down) changes nothing on screen.
// A check the user asked for always answers: a new version, "this is the latest", or the error.

import type { AvailableUpdate, UpdateProgress, Updates } from "../platform/types.ts";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "check-failed"; message: string }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "downloading"; update: AvailableUpdate; progress: UpdateProgress }
  | { kind: "restarting"; update: AvailableUpdate }
  | { kind: "install-failed"; update: AvailableUpdate; message: string };

export interface UpdateController {
  state(): UpdateState;
  currentVersion(): string | null;
  /** Looks for a newer release. `silent`: a background check, errors stay invisible. */
  check(options?: { silent?: boolean }): Promise<void>;
  /** Downloads, verifies and installs the pending update, then restarts into it. */
  install(): Promise<void>;
  /** Back to idle after a transient answer ("latest", a failed manual check). */
  acknowledge(): void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createUpdateController(updates: Updates, onChange: (state: UpdateState) => void): UpdateController {
  let state: UpdateState = { kind: "idle" };
  let version: string | null = null;
  let checking = false;

  const set = (next: UpdateState) => {
    state = next;
    onChange(state);
  };

  const pending = (): AvailableUpdate | null =>
    state.kind === "available" || state.kind === "install-failed" ? state.update : null;

  const busy = () => state.kind === "downloading" || state.kind === "restarting";

  void updates.currentVersion().then(
    (value) => {
      version = value;
      onChange(state);
    },
    () => undefined,
  );

  async function check(options: { silent?: boolean } = {}): Promise<void> {
    if (checking || busy()) return;
    checking = true;
    const silent = options.silent === true;
    const before = pending();
    if (!silent && before === null) set({ kind: "checking" });
    try {
      const found = await updates.check();
      if (busy()) {
        // An install started while this check was in flight: it wins.
        await found?.dispose();
        return;
      }
      if (found === null) {
        if (before !== null) await before.dispose();
        set(silent ? { kind: "idle" } : { kind: "latest" });
      } else if (before !== null && before.version === found.version) {
        // Same release as the one already on screen: keep it, so an error message is not lost.
        await found.dispose();
        if (!silent && state.kind === "install-failed") set({ kind: "available", update: before });
      } else {
        if (before !== null) await before.dispose();
        set({ kind: "available", update: found });
      }
    } catch (error) {
      if (silent) {
        if (state.kind === "checking") set({ kind: "idle" });
      } else if (before === null) {
        set({ kind: "check-failed", message: errorText(error) });
      }
    } finally {
      checking = false;
    }
  }

  async function install(): Promise<void> {
    const update = pending();
    if (update === null) return;
    set({ kind: "downloading", update, progress: { downloaded: 0, total: null } });
    try {
      await update.install((progress) => set({ kind: "downloading", update, progress }));
      set({ kind: "restarting", update });
      await updates.restart();
    } catch (error) {
      set({ kind: "install-failed", update, message: errorText(error) });
    }
  }

  function acknowledge(): void {
    if (state.kind === "latest" || state.kind === "check-failed") set({ kind: "idle" });
  }

  return { state: () => state, currentVersion: () => version, check, install, acknowledge };
}
