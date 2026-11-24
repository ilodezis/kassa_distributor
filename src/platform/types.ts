// What the app needs from the outside world. The Tauri implementation is the real one;
// the web implementation lets the UI run in a plain browser (dev server, manual checks).

export interface PickedFile {
  name: string;
  data: ArrayBuffer;
}

export interface PickedText {
  name: string;
  text: string;
}

export interface Platform {
  /** Asks for an .xlsx export and reads it. null when the user cancels. */
  pickExcel(): Promise<PickedFile | null>;
  /** Asks where to save the result and writes it. Returns where it went, null when cancelled. */
  saveExcel(suggestedName: string, data: Uint8Array): Promise<string | null>;
  /** Asks for a managers.json to import (the old Python app's file, or an export of this one). */
  pickConfigFile(): Promise<PickedText | null>;
  /** The saved managers config, null when none has been saved yet. */
  readConfig(): Promise<string | null>;
  writeConfig(text: string): Promise<void>;
  /** Where the config lives, for display. */
  describeConfigLocation(): Promise<string>;
  /** Over-the-air updates. null where the app cannot update itself (the browser build). */
  updates: Updates | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Size of the package in bytes, null when the server did not say. */
  total: number | null;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** Release notes, "" when the release has none. */
  notes: string;
  /**
   * Downloads the package, checks its signature against the key built into the app and
   * installs it. On Windows the installer closes the app itself once it starts.
   */
  install(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Releases the update when the user postpones it. */
  dispose(): Promise<void>;
}

export interface Updates {
  currentVersion(): Promise<string>;
  /** The newer release, or null when this version is the latest. */
  check(): Promise<AvailableUpdate | null>;
  /** Restarts into the installed version. */
  restart(): Promise<void>;
}

export const CONFIG_FILE = "managers.json";
