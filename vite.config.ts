import { defineConfig } from "vitest/config";

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
  build: {
    // WKWebView on macOS 10.15+ and WebView2 both handle ES2022.
    target: "es2022",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
