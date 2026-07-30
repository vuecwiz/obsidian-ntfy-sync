import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { obsidian: resolve(import.meta.dirname, "tests/helpers/obsidian-runtime.ts") },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: ".artifacts/coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/settings/**", "src/ui/**"],
      thresholds: {
        branches: 80,
        "src/{rules,templates,state,inbox}/**/*.ts": { branches: 90 },
        "src/{transport,effects}/**/*.ts": { branches: 80 },
      },
    },
  },
});
