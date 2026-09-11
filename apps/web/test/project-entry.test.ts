import { describe, it, expect } from "vitest";
import { safeRedirectTarget } from "../src/project-entry";
describe("R2 safe deep link", () => {
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "/login",
    "javascript:alert(1)",
    "/%0aevil",
    null,
  ])("rejects external or malformed %s", (value) =>
    expect(safeRedirectTarget(value, () => true)).toBe("/projects"),
  );
  it("preserves known internal context only", () => {
    const path = "/projects/uuid/metrics?tab=scores&env=dev";
    expect(safeRedirectTarget(path, () => true)).toBe(path);
    expect(safeRedirectTarget("/unknown", () => false)).toBe("/projects");
  });
});
