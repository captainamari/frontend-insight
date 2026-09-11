import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const devScript = await readFile(new URL("../../scripts/dev", import.meta.url), "utf8");
const flowVerifier = await readFile(
  new URL("../../packages/server-core/test/integration-flow.ts", import.meta.url),
  "utf8",
);
const acceptanceGuide = await readFile(
  new URL("../../docs/guides/v1.8-r0-local-acceptance-macos.md", import.meta.url),
  "utf8",
);

describe("R0 local-acceptance operations contract", () => {
  it("rebuilds tool-profile images before seed and smoke", () => {
    expect(devScript).toContain("compose run --rm --build seed");
    expect(devScript).toContain("compose run --rm --build --no-deps verifier");
    expect(devScript).toContain("compose stop api consumer web demo");
    expect(devScript).toContain("R0 startup stopped because seed did not complete");
  });

  it("verifier checks seed output without repairing it", () => {
    expect(flowVerifier).not.toContain("seedM6Fixture");
    expect(flowVerifier).toContain("verifySeedSnapshot");
    expect(flowVerifier).toContain("verifyDocumentedLogins");
  });

  it("documents the exact ASCII local credentials", () => {
    expect(acceptanceGuide).toContain("admin@example.invalid");
    expect(acceptanceGuide).toContain("LocalAdmin-1234");
    expect(acceptanceGuide).not.toMatch(/LocalAdmin[‐‑‒–—−]1234/u);
    expect(acceptanceGuide).toContain("run --rm --build verifier");
  });
});
