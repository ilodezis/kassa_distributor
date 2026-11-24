// The release job's gate: latest.json is written only for files that the app would accept.
// Fixtures are signed by the real Tauri CLI with a throwaway test key (not the release key).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import tauriConf from "../src-tauri/tauri.conf.json" with { type: "json" };
import { type ManifestInput, buildManifest, checkSignature, parsePublicKey } from "../scripts/release/manifest.ts";

const dir = join(import.meta.dirname, "fixtures", "updater");
const read = (name: string) => readFileSync(join(dir, name));
const testKey = parsePublicKey(read("test-key.pub").toString("utf8"));

const app = { data: new Uint8Array(read("app.tar.gz")), signature: read("app.tar.gz.sig").toString("utf8") };

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    repo: "owner/app",
    tag: "v2.2.0",
    version: "2.2.0",
    notes: "  Что нового\n",
    pubDate: new Date("2026-11-24T10:00:00Z"),
    publicKey: testKey,
    files: [{ target: "darwin-aarch64", assetName: "kassa-distributor_2.2.0_aarch64.app.tar.gz", ...app }],
    ...overrides,
  };
}

describe("update signature check", () => {
  it("accepts a CLI signature and reads the version it was signed for", () => {
    const checked = checkSignature(app.data, app.signature, testKey);
    expect(checked.keyId).toBe(testKey.id);
    expect(checked.version).toBe("2.2.0");
    expect(checked.trustedComment).toContain("file:app.tar.gz");
  });

  it("rejects a file changed by a single bit", () => {
    const tampered = app.data.slice();
    tampered[3]! ^= 1;
    expect(() => checkSignature(tampered, app.signature, testKey)).toThrow("does not match the file");
  });

  it("rejects a signature by another key, naming both keys", () => {
    const releaseKey = parsePublicKey(tauriConf.plugins.updater.pubkey);
    expect(releaseKey.id).not.toBe(testKey.id);
    expect(() => checkSignature(app.data, app.signature, releaseKey)).toThrow(`signed with key ${testKey.id}, the app trusts key ${releaseKey.id}`);
  });

  it("rejects an altered trusted comment, so the signed version cannot be swapped", () => {
    const text = Buffer.from(app.signature, "base64").toString("utf8").replace("version:2.2.0", "version:9.9.9");
    const forged = Buffer.from(text, "utf8").toString("base64");
    expect(() => checkSignature(app.data, forged, testKey)).toThrow("trusted comment was altered");
  });

  it("parses the release key built into the app", () => {
    expect(parsePublicKey(tauriConf.plugins.updater.pubkey).id).toMatch(/^[0-9A-F]{16}$/);
  });
});

describe("latest.json", () => {
  it("points at the release asset and carries the signature and notes", () => {
    expect(buildManifest(input())).toEqual({
      version: "2.2.0",
      notes: "Что нового",
      pub_date: "2026-11-24T10:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/owner/app/releases/download/v2.2.0/kassa-distributor_2.2.0_aarch64.app.tar.gz",
          signature: app.signature.trim(),
        },
      },
    });
  });

  it("leaves notes out when the release has none", () => {
    expect(buildManifest(input({ notes: " \n" }))).not.toHaveProperty("notes");
  });

  it("refuses a file signed for another version or for none (the app requires the signed version)", () => {
    expect(() => buildManifest(input({ tag: "v2.3.0", version: "2.3.0" }))).toThrow("signed for version 2.2.0, releasing 2.3.0");
    const unversioned = { data: new Uint8Array(read("unversioned.tar.gz")), signature: read("unversioned.tar.gz.sig").toString("utf8") };
    expect(() =>
      buildManifest(input({ files: [{ target: "darwin-aarch64", assetName: "a.tar.gz", ...unversioned }] })),
    ).toThrow("signed for version none");
  });

  it("refuses a tag that is not the version, and asset names GitHub would rewrite", () => {
    expect(() => buildManifest(input({ tag: "v2.2.1" }))).toThrow("does not match version");
    expect(() =>
      buildManifest(input({ files: [{ target: "darwin-aarch64", assetName: "Kassa Distributor.app.tar.gz", ...app }] })),
    ).toThrow("asset names may only hold");
  });

  it("refuses an empty release and a target listed twice", () => {
    expect(() => buildManifest(input({ files: [] }))).toThrow("no update files");
    const file = { target: "darwin-aarch64", assetName: "a.tar.gz", ...app };
    expect(() => buildManifest(input({ files: [file, file] }))).toThrow("listed twice");
  });
});
