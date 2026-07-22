import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function workspaceSource(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@frontend-insight/event-contract": workspaceSource(
        "./packages/event-contract/src/index.ts",
      ),
      "@frontend-insight/shared-config": workspaceSource(
        "./packages/shared-config/src/index.ts",
      ),
      "@frontend-insight/test-fixtures": workspaceSource(
        "./packages/test-fixtures/src/index.ts",
      ),
      "@frontend-insight/database": workspaceSource("./packages/database/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: { enabled: false },
  },
});
