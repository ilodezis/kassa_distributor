// The update manifest (latest.json) and the signature check behind it.
//
// The app trusts an update only when its signature matches the public key built into it
// (plugins.updater.pubkey in tauri.conf.json). The release job checks every signature the same
// way before it publishes anything, so a wrong key or a broken file never reaches a release:
// it fails here instead of on every user's machine.
//
// Format: minisign. A key or a signature arrives as base64 of minisign's own text file.
//   public key:  untrusted comment line, then base64("Ed" | key id (8) | Ed25519 key (32))
//   signature:   untrusted comment line, then base64("ED" | key id (8) | signature (64)),
//                then "trusted comment: ...", then base64(signature over sig (64) | comment)
// "ED" signs the BLAKE2b-512 hash of the file, "Ed" (legacy) the file itself.

import { createHash, createPublicKey, verify } from "node:crypto";

export interface PublicKey {
  /** Key id in minisign's notation: 16 hex digits, as printed in the key's comment. */
  id: string;
  key: Uint8Array;
}

export interface CheckedSignature {
  keyId: string;
  trustedComment: string;
  /** The version the file was signed for (`--app-version`), null when the signature has none. */
  version: string | null;
}

export interface ManifestPlatform {
  url: string;
  signature: string;
}

export interface Manifest {
  version: string;
  notes?: string;
  pub_date: string;
  platforms: Record<string, ManifestPlatform>;
}

function decodeBase64Text(value: string, what: string): string {
  const text = Buffer.from(value.trim(), "base64").toString("utf8");
  if (text === "") throw new Error(`${what}: not base64 minisign text`);
  return text;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== "");
}

/** Key ids are stored little-endian; minisign prints them as a big-endian hex number. */
function keyIdHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

export function parsePublicKey(base64: string): PublicKey {
  const [, body] = lines(decodeBase64Text(base64, "public key"));
  if (body === undefined) throw new Error("public key: missing key line");
  const raw = Buffer.from(body, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("public key: not an Ed25519 minisign key");
  }
  return { id: keyIdHex(raw.subarray(2, 10)), key: new Uint8Array(raw.subarray(10)) };
}

function ed25519Verify(key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") },
    format: "jwk",
  });
  return verify(null, message, publicKey, signature);
}

/** `version:` field of a trusted comment, written by the Tauri CLI as tab separated pairs. */
export function signedVersion(trustedComment: string): string | null {
  for (const field of trustedComment.split("\t")) {
    if (field.startsWith("version:")) return field.slice("version:".length);
  }
  return null;
}

/** Throws unless `signature` (contents of a .sig file) is a valid signature of `file` by `publicKey`. */
export function checkSignature(file: Uint8Array, signature: string, publicKey: PublicKey): CheckedSignature {
  const [, sigLine, commentLine, globalLine] = lines(decodeBase64Text(signature, "signature"));
  if (sigLine === undefined || commentLine === undefined || globalLine === undefined) {
    throw new Error("signature: incomplete minisign signature");
  }
  const raw = Buffer.from(sigLine, "base64");
  if (raw.length !== 74) throw new Error("signature: wrong length");
  const algorithm = raw.subarray(0, 2).toString("latin1");
  const keyId = keyIdHex(raw.subarray(2, 10));
  const sig = raw.subarray(10);

  if (keyId !== publicKey.id) {
    throw new Error(`signature: signed with key ${keyId}, the app trusts key ${publicKey.id}`);
  }

  let message: Uint8Array;
  if (algorithm === "ED") message = createHash("blake2b512").update(file).digest();
  else if (algorithm === "Ed") message = file;
  else throw new Error(`signature: unknown algorithm '${algorithm}'`);
  if (!ed25519Verify(publicKey.key, message, sig)) throw new Error("signature: does not match the file");

  const prefix = "trusted comment: ";
  if (!commentLine.startsWith(prefix)) throw new Error("signature: missing trusted comment");
  const trustedComment = commentLine.slice(prefix.length);
  const globalSig = Buffer.from(globalLine, "base64");
  if (!ed25519Verify(publicKey.key, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), globalSig)) {
    throw new Error("signature: trusted comment was altered");
  }

  return { keyId, trustedComment, version: signedVersion(trustedComment) };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ReleaseFile {
  /** Updater target, e.g. `darwin-aarch64`, `windows-x86_64`. */
  target: string;
  /** Asset name on the release: becomes the last segment of the download URL. */
  assetName: string;
  data: Uint8Array;
  signature: string;
}

export interface ManifestInput {
  repo: string;
  tag: string;
  version: string;
  notes: string;
  pubDate: Date;
  publicKey: PublicKey;
  files: readonly ReleaseFile[];
}

/**
 * Checks every file against the app's key and the release version, then builds latest.json.
 * The app is configured with requireSignedVersion, so a signature without the version or with
 * another one would be refused by every client: refuse it here first.
 */
export function buildManifest(input: ManifestInput): Manifest {
  if (!SEMVER.test(input.version)) throw new Error(`version '${input.version}' is not semver`);
  if (input.tag !== `v${input.version}`) throw new Error(`tag ${input.tag} does not match version ${input.version}`);
  if (input.files.length === 0) throw new Error("no update files");

  const platforms: Record<string, ManifestPlatform> = {};
  for (const file of input.files) {
    if (platforms[file.target] !== undefined) throw new Error(`${file.target}: listed twice`);
    if (!/^[\w.-]+$/.test(file.assetName)) {
      // GitHub rewrites spaces and other characters in asset names, which would break the URL.
      throw new Error(`${file.assetName}: asset names may only hold letters, digits, '.', '_' and '-'`);
    }
    let checked: CheckedSignature;
    try {
      checked = checkSignature(file.data, file.signature, input.publicKey);
    } catch (error) {
      throw new Error(`${file.target} (${file.assetName}): ${(error as Error).message}`);
    }
    if (checked.version !== input.version) {
      throw new Error(`${file.target} (${file.assetName}): signed for version ${checked.version ?? "none"}, releasing ${input.version}`);
    }
    platforms[file.target] = {
      url: `https://github.com/${input.repo}/releases/download/${input.tag}/${file.assetName}`,
      signature: file.signature.trim(),
    };
  }

  const manifest: Manifest = { version: input.version, pub_date: input.pubDate.toISOString(), platforms };
  const notes = input.notes.trim();
  if (notes !== "") manifest.notes = notes;
  return manifest;
}
