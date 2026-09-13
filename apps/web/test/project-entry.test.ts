import { describe, it, expect } from "vitest";
import { safeRedirectTarget, entryReason } from "../src/project-entry";
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

it("R2 preserves distinct metric facts when translating all unavailable reasons", () => {
  const reasons = [
    "operational_score:pv:METRIC_PARTIAL",
    "operational_score:uv:METRIC_PARTIAL",
    "quality_score:js_error_rate:METRIC_PARTIAL",
  ].map(entryReason);
  expect(new Set(reasons).size).toBe(3);
  expect(reasons[0]).toContain("运营：pv");
  expect(reasons[2]).toContain("质量：js_error_rate");
});
