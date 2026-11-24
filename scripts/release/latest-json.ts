// Writes latest.json for a release, after checking every signature against the app's key.
//
//   node scripts/release/latest-json.ts --repo owner/name --tag v2.2.0 --out latest.json \
//     [--notes-file notes.txt] darwin-aarch64=path/to/app.tar.gz
//
// Each file needs its signature next to it as <file>.sig. The version comes from the tag and
// must match package.json; the public key comes from src-tauri/tauri.conf.json.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type ReleaseFile, buildManifest, parsePublicKey } from "./manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    tag: { type: "string" },
    out: { type: "string" },
    "notes-file": { type: "string" },
  },
});

if (values.repo === undefined || values.tag === undefined || values.out === undefined || positionals.length === 0) {
  console.error("usage: latest-json.ts --repo owner/name --tag vX.Y.Z --out latest.json [--notes-file f] target=file...");
  process.exit(2);
}

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = values.tag.replace(/^v/, "");
if (pkg.version !== version || conf.version !== version) {
  console.error(`tag ${values.tag}: package.json is ${pkg.version}, tauri.conf.json is ${conf.version}`);
  process.exit(1);
}

const files: ReleaseFile[] = positionals.map((arg) => {
  const eq = arg.indexOf("=");
  if (eq <= 0) throw new Error(`expected target=file, got '${arg}'`);
  const path = arg.slice(eq + 1);
  return {
    target: arg.slice(0, eq),
    assetName: basename(path),
    data: readFileSync(path),
    signature: readFileSync(`${path}.sig`, "utf8"),
  };
});

const manifest = buildManifest({
  repo: values.repo,
  tag: values.tag,
  version,
  notes: values["notes-file"] === undefined ? "" : readFileSync(values["notes-file"], "utf8"),
  pubDate: new Date(),
  publicKey: parsePublicKey(conf.plugins.updater.pubkey),
  files,
});

writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${values.out}: ${Object.keys(manifest.platforms).join(", ")}, version ${manifest.version}`);
