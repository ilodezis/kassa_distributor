// Over-the-air updates: the state machine behind the notice, and how progress reads.

import { describe, expect, it, vi } from "vitest";

import type { AvailableUpdate, UpdateProgress, Updates } from "../src/platform/types.ts";
import { type UpdateState, createUpdateController } from "../src/ui/update-controller.ts";
import { formatSize, progressPercent, progressText } from "../src/ui/update-view.ts";

function fakeUpdate(version: string, install?: (onProgress: (p: UpdateProgress) => void) => Promise<void>): AvailableUpdate {
  return {
    version,
    currentVersion: "2.1.0",
    notes: "",
    install: install ?? (async (onProgress) => onProgress({ downloaded: 10, total: 10 })),
    dispose: vi.fn(async () => undefined),
  };
}

function setup(check: Updates["check"]) {
  const states: UpdateState[] = [];
  const updates: Updates = { currentVersion: async () => "2.1.0", check: vi.fn(check), restart: vi.fn(async () => undefined) };
  const controller = createUpdateController(updates, (state) => states.push(state));
  // State changes, not renders: the controller also re-renders once the version is known.
  const kinds = () => states.map((s) => s.kind).filter((kind, i, all) => i === 0 || kind !== all[i - 1]);
  const renders = () => states.map((s) => s.kind);
  return { controller, updates, kinds, renders };
}

describe("update controller", () => {
  it("a silent check that finds nothing or fails leaves the screen alone", async () => {
    const quiet = setup(async () => null);
    await quiet.controller.check({ silent: true });
    expect(quiet.controller.state().kind).toBe("idle");

    const offline = setup(async () => {
      throw new Error("offline");
    });
    await offline.controller.check({ silent: true });
    expect(offline.controller.state().kind).toBe("idle");
    expect(offline.kinds()).not.toContain("check-failed");
  });

  it("a manual check always answers: checking, then latest or the error", async () => {
    const latest = setup(async () => null);
    await latest.controller.check();
    expect(latest.kinds().filter((k) => k !== "idle")).toEqual(["checking", "latest"]);
    latest.controller.acknowledge();
    expect(latest.controller.state().kind).toBe("idle");

    const failing = setup(async () => {
      throw new Error("github is down");
    });
    await failing.controller.check();
    expect(failing.controller.state()).toEqual({ kind: "check-failed", message: "github is down" });
  });

  it("knows the running version", async () => {
    const { controller } = setup(async () => null);
    await Promise.resolve();
    expect(controller.currentVersion()).toBe("2.1.0");
  });

  it("installs with progress, then restarts into the new version", async () => {
    const update = fakeUpdate("2.2.0", async (onProgress) => {
      onProgress({ downloaded: 5, total: 10 });
      onProgress({ downloaded: 10, total: 10 });
    });
    const { controller, updates, renders } = setup(async () => update);
    await controller.check({ silent: true });
    expect(controller.state()).toEqual({ kind: "available", update });

    await controller.install();
    expect(renders().slice(-4)).toEqual(["downloading", "downloading", "downloading", "restarting"]);
    expect(updates.restart).toHaveBeenCalledOnce();
  });

  it("a failed install keeps the update so it can be retried, and never restarts", async () => {
    let attempt = 0;
    const update = fakeUpdate("2.2.0", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("signature does not match");
    });
    const { controller, updates } = setup(async () => update);
    await controller.check({ silent: true });

    await controller.install();
    expect(controller.state()).toEqual({ kind: "install-failed", update, message: "signature does not match" });
    expect(updates.restart).not.toHaveBeenCalled();

    await controller.install();
    expect(controller.state().kind).toBe("restarting");
    expect(updates.restart).toHaveBeenCalledOnce();
  });

  it("does not check while an install is running", async () => {
    let finish!: () => void;
    const update = fakeUpdate("2.2.0", () => new Promise<void>((resolve) => (finish = resolve)));
    const { controller, updates } = setup(async () => update);
    await controller.check({ silent: true });

    const installing = controller.install();
    await controller.check();
    expect(updates.check).toHaveBeenCalledOnce();
    finish();
    await installing;
  });

  it("a newer release replaces the pending one; the same release keeps it", async () => {
    const first = fakeUpdate("2.2.0");
    const same = fakeUpdate("2.2.0");
    const newer = fakeUpdate("2.3.0");
    const queue = [first, same, newer];
    const { controller } = setup(async () => queue.shift()!);

    await controller.check({ silent: true });
    await controller.check({ silent: true });
    expect(controller.state()).toEqual({ kind: "available", update: first });
    expect(same.dispose).toHaveBeenCalledOnce();

    await controller.check({ silent: true });
    expect(controller.state()).toEqual({ kind: "available", update: newer });
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});

describe("update progress text", () => {
  it("reads in megabytes with a Russian decimal comma", () => {
    expect(formatSize(9_800_000)).toBe("9,8 МБ");
    expect(progressText({ downloaded: 4_200_000, total: 9_800_000 })).toBe("4,2 из 9,8 МБ");
    expect(progressText({ downloaded: 4_200_000, total: null })).toBe("Скачано 4,2 МБ");
  });

  it("gives whole percent, never above 100, and none when the size is unknown", () => {
    expect(progressPercent({ downloaded: 4_200_000, total: 9_800_000 })).toBe(42);
    expect(progressPercent({ downloaded: 11, total: 10 })).toBe(100);
    expect(progressPercent({ downloaded: 5, total: null })).toBeNull();
    expect(progressPercent({ downloaded: 5, total: 0 })).toBeNull();
  });
});
