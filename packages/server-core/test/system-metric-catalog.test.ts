import {
  CANONICAL_METRIC_KEYS,
  FORBIDDEN_ALIASES,
} from "@frontend-insight/event-contract";
import { describe, expect, it } from "vitest";
import {
  assertMetricKeyCanBeCreated,
  assertMetricKeyRequest,
} from "../src/metric-library.js";
import type { MetricLibraryError } from "../src/metric-library.js";
import {
  METRIC_CATALOG,
  IDENTITY_DEFINITION_VERSION,
  isHistoricalIdentityDefinition,
  unavailableSystemMetricResult,
} from "../src/system-metric-catalog.js";

describe("read-only system metric catalog", () => {
  it("registers all 35 attachment keys in the five required categories", () => {
    expect(METRIC_CATALOG).toHaveLength(45);
    expect(new Set(METRIC_CATALOG.map((item) => item.metricKey)).size).toBe(45);
    expect(new Set(METRIC_CATALOG.map((item) => item.category))).toEqual(
      new Set(["usage", "operation", "performance", "stability", "organization"]),
    );
  });

  it("uses approved identified business identity consistently without UV aliases", () => {
    for (const key of ["uv", "dau", "wau", "mau", "hourly_distribution"]) {
      const item = METRIC_CATALOG.find((m) => m.metricKey === key)!;
      expect(item.definitionVersion).toBe(IDENTITY_DEFINITION_VERSION);
      expect(item.deduplicationKey).toContain("project-HMAC(userId)");
      expect(JSON.stringify(item)).not.toContain("deviceId");
      expect(isHistoricalIdentityDefinition(key, "system-v1.8.0")).toBe(true);
    }
    expect(isHistoricalIdentityDefinition("js_error_rate", "system-v1.8.0")).toBe(
      false,
    );
    expect(isHistoricalIdentityDefinition("uv", "unapproved")).toBe(false);
  });

  it("provides complete definition, collection and availability metadata", () => {
    for (const item of METRIC_CATALOG) {
      expect(item.origin).toBe("system");
      expect(item.displayName).not.toBe("");
      expect(item.businessDescription).not.toBe("");
      expect(item.formulaDescription).not.toBe("");
      expect(item.deduplicationKey).not.toBe("");
      expect(item.unit).not.toBe("");
      expect(item.reportingTiming).not.toBe("");
      expect(item.entityScopes.length).toBeGreaterThan(0);
      expect(item.timeGranularities.length).toBeGreaterThan(0);
      expect(item.minimumSample).toBeGreaterThanOrEqual(0);
      expect(item.missingPolicy).not.toBe("");
      expect(item.owner).not.toBe("");
      expect(item.definitionVersion).not.toBe("");
      expect(["implemented", "partial", "not_collected"]).toContain(
        item.implementationStatus,
      );
      if (item.implementationStatus === "not_collected") {
        expect(item.availableFrom).toBeNull();
        expect(item.unavailableReason).not.toBeNull();
      }
    }
  });

  it("never returns fabricated zero or an empty trend for partial/not-collected metrics", () => {
    for (const item of METRIC_CATALOG.filter(
      (metric) => metric.implementationStatus !== "implemented",
    )) {
      expect(unavailableSystemMetricResult(item.metricKey)).toMatchObject({
        value: null,
        trend: null,
        status: "metric_not_available",
      });
    }
  });

  it("protects reserved keys and returns a stable removed-key error without aliases", () => {
    const reserved = METRIC_CATALOG[0]!.metricKey;
    expect(() => assertMetricKeyCanBeCreated(reserved)).toThrowError(
      expect.objectContaining<Partial<MetricLibraryError>>({
        code: "SYSTEM_METRIC_KEY_RESERVED",
      }),
    );
    const futureScoreKey = CANONICAL_METRIC_KEYS.find(
      (key) => !METRIC_CATALOG.some((item) => item.metricKey === key),
    )!;
    expect(() => assertMetricKeyCanBeCreated(futureScoreKey)).toThrowError(
      expect.objectContaining<Partial<MetricLibraryError>>({
        code: "SYSTEM_METRIC_KEY_RESERVED",
      }),
    );
    const removed = FORBIDDEN_ALIASES.metricKeys[0];
    expect(() => assertMetricKeyRequest(removed)).toThrowError(
      expect.objectContaining<Partial<MetricLibraryError>>({
        code: "METRIC_KEY_REMOVED",
      }),
    );
    expect(() => assertMetricKeyCanBeCreated(removed)).toThrowError(
      expect.objectContaining<Partial<MetricLibraryError>>({
        code: "METRIC_KEY_REMOVED",
      }),
    );
  });
});
