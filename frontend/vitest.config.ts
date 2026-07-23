import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // React 19 uses the automatic JSX runtime; transform .tsx accordingly under vitest's esbuild.
  esbuild: { jsx: "automatic" },
  // Mirror tsconfig's `@/* -> ./src/*` so value imports through the alias resolve under vitest.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    // docx's browser bundle probes global localStorage. Node 26 exposes experimental web storage
    // and warns when no persistence file is configured; test workers need no web storage at all.
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: true,
  },
});
