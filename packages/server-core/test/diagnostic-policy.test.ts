import { describe, expect, it } from "vitest";
import { DEFAULT_DIAGNOSTIC_POLICY } from "@frontend-insight/event-contract/diagnostic-policy";
import { diagnosticRequestsSuppressed } from "../src/runtime-diagnostics.js";

describe("request policy admission", () => {
  it("enforces route and success-body rules for legacy and D3 shapes without query matching", () => {
    const policy = {
      ...DEFAULT_DIAGNOSTIC_POLICY,
      requestRoutes: ["/api/**"],
      successBodyRoutes: [],
    };
    for (const raw of [
      { request: { url: "https://fixture.invalid/outside?path=/api/x" } },
      {
        requests: [
          {
            url: { value: "https://fixture.invalid/api/x" },
            result: "success",
            responseBody: { value: "test" },
          },
        ],
      },
      {
        request: {
          url: "https://fixture.invalid/api/x",
          status: 200,
          responseBody: "test",
        },
      },
      { request: { responseBody: "no route identity" } },
    ])
      expect(diagnosticRequestsSuppressed(raw, policy)).toBe(true);
    expect(
      diagnosticRequestsSuppressed(
        {
          request: {
            url: "https://fixture.invalid/api/x?token=fixture",
            status: 500,
            responseBody: "failure",
          },
        },
        policy,
      ),
    ).toBe(false);
    expect(diagnosticRequestsSuppressed({}, policy)).toBe(false);
  });
});
