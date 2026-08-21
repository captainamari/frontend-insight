import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_DEFINITION_VERSION,
  buildFixedAlerts,
  errorSeverity,
  type ErrorGroupSummary,
  type WebVitalSummary,
} from "../src/observability.js";

function errorGroup(overrides: Partial<ErrorGroupSummary> = {}): ErrorGroupSummary {
  return {
    groupId: "a".repeat(64),
    errorType: "js",
    errorName: "TypeError",
    message: "Cannot render chart",
    stackTopFrame: "at render (/assets/app.js:10:20)",
    requestMethod: null,
    requestPath: null,
    httpStatus: null,
    resourceType: null,
    occurrences: 5,
    affectedUsers: 1,
    affectedBrowsers: 3,
    affectedPages: 1,
    pages: ["/dashboard"],
    releases: ["release-1"],
    browserFamilies: ["Chrome"],
    osFamilies: ["Windows"],
    viewportBuckets: ["wide"],
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T01:00:00.000Z",
    severity: "warning",
    ...overrides,
  };
}

function vital(overrides: Partial<WebVitalSummary> = {}): WebVitalSummary {
  return {
    pageRoute: "/dashboard",
    vitalName: "lcp",
    release: "release-1",
    sampleSize: 20,
    p75: 4_200,
    poorSamples: 8,
    poorRate: 0.4,
    lastSeenAt: "2026-08-01T01:00:00.000Z",
    ...overrides,
  };
}

describe("fixed observability alerts", () => {
  it("uses documented error thresholds without an editable formula", () => {
    expect(
      errorSeverity({
        occurrences: 4,
        affectedUsers: 0,
        affectedBrowsers: 3,
        httpStatus: null,
      }),
    ).toBe("info");
    expect(
      errorSeverity({
        occurrences: 5,
        affectedUsers: 1,
        affectedBrowsers: 3,
        httpStatus: null,
      }),
    ).toBe("warning");
    expect(
      errorSeverity({
        occurrences: 20,
        affectedUsers: 2,
        affectedBrowsers: 4,
        httpStatus: 503,
      }),
    ).toBe("critical");
  });

  it("creates evidence-bearing error, vital and pipeline alerts", () => {
    const alerts = buildFixedAlerts({
      errors: [errorGroup()],
      vitals: [vital()],
      dataState: "delayed",
      updatedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(alerts.map((item) => item.ruleKey)).toEqual([
      "error_spike",
      "web_vital_poor",
      "telemetry_delayed",
    ]);
    expect(
      alerts.every(
        (item) => item.definitionVersion === OBSERVABILITY_DEFINITION_VERSION,
      ),
    ).toBe(true);
    expect(alerts[1]?.evidence).toContain("8/20");
  });

  it("does not alert on insufficient Web Vital samples", () => {
    const alerts = buildFixedAlerts({
      errors: [],
      vitals: [vital({ sampleSize: 19, poorSamples: 19, poorRate: 1 })],
      dataState: "healthy",
      updatedAt: null,
    });
    expect(alerts).toHaveLength(0);
  });
});
