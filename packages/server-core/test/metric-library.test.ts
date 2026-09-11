import { describe, expect, it } from "vitest";
import {
  assertMetricKeyCanBeCreated,
  formulaToDescription,
  validateMetricVersionSnapshot,
  type MetricLibraryDefinition,
  type MetricLibraryVersion,
} from "../src/metric-library.js";
import {
  METRIC_CATALOG,
  type SystemMetricDefinition,
} from "../src/system-metric-catalog.js";

const version: MetricLibraryVersion = {
  id: "version-1",
  projectId: "project-1",
  libraryType: "operational",
  version: 1,
  status: "draft",
  manifestVersion: "1.8.0",
  sourceVersionId: null,
  createdByUserId: "user-1",
  activatedAt: null,
  supersededAt: null,
  abandonedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function snapshot(system: SystemMetricDefinition): MetricLibraryDefinition {
  return {
    id: `id-${system.metricKey}`,
    libraryVersionId: version.id,
    metricKey: system.metricKey,
    origin: "system",
    category: system.category,
    displayName: system.displayName,
    businessDescription: system.businessDescription,
    formulaDescription: system.formulaDescription,
    numeratorDescription: system.numeratorDescription,
    denominatorDescription: system.denominatorDescription,
    deduplicationKey: system.deduplicationKey,
    unit: system.unit,
    percentiles: system.percentiles,
    reportingTiming: system.reportingTiming,
    entityScopes: system.entityScopes,
    timeGranularities: system.timeGranularities,
    minimumSample: system.minimumSample,
    missingPolicy: system.missingPolicy,
    owner: system.owner,
    definitionVersion: system.definitionVersion,
    implementationStatus: system.implementationStatus,
    formulaAst: null,
    availableFrom: system.availableFrom,
    unavailableReason: system.unavailableReason,
    milestone: system.milestone,
    enabled: true,
  };
}

function business(
  metricKey: string,
  formulaAst: MetricLibraryDefinition["formulaAst"],
  unit: string,
): MetricLibraryDefinition {
  return {
    id: `id-${metricKey}`,
    libraryVersionId: version.id,
    metricKey,
    origin: "business",
    category: "usage",
    displayName: metricKey,
    businessDescription: metricKey,
    formulaDescription: formulaAst ? formulaToDescription(formulaAst) : "",
    numeratorDescription: "input",
    denominatorDescription: "input",
    deduplicationKey: "input",
    unit,
    percentiles: [],
    reportingTiming: "bucket evaluation",
    entityScopes: ["project"],
    timeGranularities: ["day"],
    minimumSample: 1,
    missingPolicy: "propagate",
    owner: "test",
    definitionVersion: "business-v1",
    implementationStatus: "not_collected",
    formulaAst,
    availableFrom: null,
    unavailableReason: "dependency status",
    milestone: "R1-B",
    enabled: true,
  };
}

const operationalSystems = METRIC_CATALOG.filter(
  (item) => !["performance", "stability"].includes(item.category),
).map(snapshot);

describe("metric library snapshot validation", () => {
  it("validates a complete snapshot and derives business status from dependencies", () => {
    const definitions = [
      ...operationalSystems,
      business("derived_partial", { type: "metric", metricKey: "pv" }, "views"),
      business("derived_missing", { type: "metric", metricKey: "dau" }, "users"),
      business(
        "derived_chain",
        { type: "metric", metricKey: "derived_partial" },
        "views",
      ),
    ];
    const report = validateMetricVersionSnapshot({ version, definitions });
    expect(report.errors).toEqual([]);
    expect(
      report.definitions.find((item) => item.metricKey === "derived_partial")
        ?.implementationStatus,
    ).toBe("partial");
    expect(
      report.definitions.find((item) => item.metricKey === "derived_missing")
        ?.implementationStatus,
    ).toBe("not_collected");
    expect(
      report.definitions.find((item) => item.metricKey === "derived_chain")
        ?.implementationStatus,
    ).toBe("partial");
    expect(report.order.indexOf("pv")).toBeLessThan(
      report.order.indexOf("derived_partial"),
    );
  });

  it("fails a snapshot with a missing or semantically substituted system key", () => {
    const missing = operationalSystems.slice(1);
    const missingReport = validateMetricVersionSnapshot({
      version,
      definitions: missing,
    });
    expect(missingReport.valid).toBe(false);
    expect(
      missingReport.errors.some((item) => item.code === "SYSTEM_METRIC_MISSING"),
    ).toBe(true);

    const changed = operationalSystems.map((item, index) =>
      index === 0 ? { ...item, definitionVersion: "changed" } : item,
    );
    const changedReport = validateMetricVersionSnapshot({
      version,
      definitions: changed,
    });
    expect(
      changedReport.errors.some((item) => item.code === "SYSTEM_METRIC_CHANGED"),
    ).toBe(true);
  });

  it("keeps the original identity version on immutable pre-approval snapshots", () => {
    const definitions = operationalSystems.map((item) => ({
      ...item,
      definitionVersion:
        item.definitionVersion === "system-identity-2026-09-09.1"
          ? "system-v1.8.0"
          : item.definitionVersion,
    }));
    const report = validateMetricVersionSnapshot({
      version: { ...version, status: "superseded" },
      definitions,
    });
    expect(report.valid).toBe(true);
    expect(definitions.find((m) => m.metricKey === "uv")!.definitionVersion).toBe(
      "system-v1.8.0",
    );
  });
  it("rejects system-reserved keys before any database mutation", () => {
    expect(() => assertMetricKeyCanBeCreated(METRIC_CATALOG[0]!.metricKey)).toThrow(
      "SYSTEM_METRIC_KEY_RESERVED",
    );
  });
});
