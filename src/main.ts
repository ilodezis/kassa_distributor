import { createPlatform } from "./platform/index.ts";
import { type AppHandle, createApp } from "./ui/app.ts";

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) throw new Error("#app not found");
  const app = await createApp(root, await createPlatform());

  // Dev and e2e builds expose the app so the UI can be driven without a native file chooser.
  if (import.meta.env.DEV || import.meta.env.MODE === "e2e") {
    (window as unknown as { __app: AppHandle }).__app = app;
  }
}

void main();
