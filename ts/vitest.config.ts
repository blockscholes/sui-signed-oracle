import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const evaluating = existsSync(resolve("..", ".evaluator-localnet.json"));
export default defineConfig({
  test: {
    reporters: evaluating ? ["default", "json"] : ["default"],
    ...(evaluating ? { outputFile: { json: "../.evaluator-artifacts/vitest-results.json" } } : {}),
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] },
  },
});
