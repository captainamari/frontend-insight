import { describe, it, expect } from "vitest";
import { bindQualityFacts } from "../src/quality-binding.js";
import {
  QUALITY_DEFINITION_VERSION,
  type QualityFactStore,
} from "../src/quality-facts.js";
import type {
  MetricLibraryDefinition,
  MetricLibraryVersion,
} from "../src/metric-library.js";
import { systemMetricDefinition } from "../src/system-metric-catalog.js";
function fixture() {
  const metric = systemMetricDefinition("api_error_rate")!;
  const definition: MetricLibraryDefinition = {
    ...metric,
    id: "metric",
    libraryVersionId: "version",
    formulaAst: null,
    enabled: true,
  };
  const version: MetricLibraryVersion = {
    id: "version",
    projectId: "project",
    libraryType: "quality",
    version: 2,
    status: "draft",
    manifestVersion: "1.8.0",
    sourceVersionId: null,
    createdByUserId: "actor",
    activatedAt: null,
    supersededAt: null,
    abandonedAt: null,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  };
  const facts = {
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
    inputs: {
      api_error_rate: {
        value: 0.2,
        status: "available",
        sampleSize: 100,
        reason: null,
      },
    },
  } as Pick<Awaited<ReturnType<QualityFactStore["read"]>>, "inputs" | "from" | "to">;
  return { facts, snapshot: { version, definitions: [definition] } };
}
describe("R5-A pinned quality facts and DAG", () => {
  it("does not reinterpret old snapshots and keeps inputs immutable", () => {
    const f = fixture();
    f.snapshot.definitions[0]!.definitionVersion = "system-v1.8.0";
    const before = structuredClone(f);
    expect(bindQualityFacts(f.facts, f.snapshot).inputs.api_error_rate?.reason).toBe(
      "QUALITY_DEFINITION_UPGRADE_REQUIRED",
    );
    expect(f).toEqual(before);
  });
  it("evaluates a custom AST in the requested quality version", () => {
    const f = fixture();
    expect(f.snapshot.definitions[0]!.definitionVersion).toBe(
      QUALITY_DEFINITION_VERSION,
    );
    f.snapshot.definitions.push({
      ...f.snapshot.definitions[0]!,
      id: "business",
      metricKey: "double_error",
      origin: "business",
      formulaAst: {
        type: "binary",
        operator: "*",
        left: { type: "metric", metricKey: "api_error_rate" },
        right: { type: "literal", value: 2 },
      },
    });
    expect(bindQualityFacts(f.facts, f.snapshot)).toMatchObject({
      mode: "preview",
      versionId: "version",
      inputs: { double_error: { value: 0.4, status: "available" } },
    });
  });
  it("rejects cycles and wrong-library snapshots", () => {
    const f = fixture();
    f.snapshot.definitions[0]!.origin = "business";
    f.snapshot.definitions[0]!.formulaAst = {
      type: "metric",
      metricKey: "api_error_rate",
    };
    expect(() => bindQualityFacts(f.facts, f.snapshot)).toThrow(
      "QUALITY_FORMULA_CYCLE",
    );
    f.snapshot.version.libraryType = "operational";
    expect(() => bindQualityFacts(f.facts, f.snapshot)).toThrow(
      "QUALITY_LIBRARY_REQUIRED",
    );
  });
});
