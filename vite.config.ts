import { defineConfig } from "vitest/config";

import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

// Vite options tailored for Tauri: fixed port, no screen clearing so Rust errors stay visible.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/reference/**"] },
  },
  // `vite preview` serves the production build under the same CSP the Tauri window enforces.
  preview: {
    port: 4173,
    strictPort: true,
    headers: { "Content-Security-Policy": tauriConf.app.security.csp },
  },
  build: {
    // WKWebView on macOS 12.3+ (Safari 15.4) and WebView2 both handle this.
    target: ["es2022", "safari15"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
