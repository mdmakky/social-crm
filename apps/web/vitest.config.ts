import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // tsconfig uses jsx: "preserve" for Next; tests need the automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], exclude: ["e2e/**", "node_modules/**"] },
});
