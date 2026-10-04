import { describe, it, expect } from "vitest";
import { ScoreManagementService } from "../src/score-management.js";
import type { MySqlStore } from "../src/mysql-store.js";
import type { MetricLibraryService } from "../src/metric-library.js";
import { qualityScoreFixture } from "./quality-score-fixture.js";
import { systemMetricDefinition } from "../src/system-metric-catalog.js";
import { reduceQuality, type QualityFactStore } from "../src/quality-facts.js";

describe("quality facts use the inherited score evaluator", () => {
  it("preserves the approved weights and independently calculated total; missing denominators cannot score", () => {
    const fixture = qualityScoreFixture();
    const keys = [
      "js_error_rate",
      "resource_error_rate",
      "api_error_rate",
      "lcp",
      "inp",
      "cls",
    ];
    const values = [0.005, 0.005, 0.005, 3000, 350, 0.175];
    const samples = [1000, 4000, 2000, 100, 100, 100];
    const snapshot = {
      version: {
        id: fixture.context.metricSetVersion,
        projectId: fixture.context.projectId,
        libraryType: "quality",
        status: "draft",
        activatedAt: null,
      },
      definitions: keys.map((key) => ({
        ...systemMetricDefinition(key)!,
        id: key,
        enabled: true,
        formulaAst: null,
      })),
      score: {
        configuration: fixture.configuration,
        dependencies: {
          confirmed: true,
          scopeId: fixture.context.scopeId,
          timezone: fixture.context.timezone,
          settings: { expectedActiveWeekdays: [] },
        },
      },
    } as unknown as Awaited<ReturnType<ScoreManagementService["get"]>>;
    const observed = reduceQuality(
      [],
      Date.parse(fixture.context.from),
      Date.parse(fixture.context.to),
      Date.parse(fixture.context.to) + 86400001,
    );
    for (const [i, key] of keys.entries()) {
      Object.assign(observed.metrics[key]!, {
        value: values[i],
        observedValue: values[i],
        sampleSize: samples[i],
        status: "available",
        reason: null,
        denominator: samples[i],
      });
      observed.inputs[key] = observed.metrics[key]!;
    }
    const observation = {
      ...observed,
      statistics: {
        clickHouseQueries: 1,
        rowsRead: 0,
        bytesRead: 0,
        elapsedSeconds: 0,
      },
    } as Awaited<ReturnType<QualityFactStore["read"]>>;
    const service = new ScoreManagementService(
      {} as MySqlStore,
      {} as MetricLibraryService,
    );
    const query = { ...fixture.context };
    const before = structuredClone(snapshot);
    const result = service.evaluateQuery(
      snapshot,
      query,
      [],
      "historical_trial",
      undefined,
      observation,
    );
    expect(result.value).toBeCloseTo(72.953216374269, 10);
    expect(result.qualityObservation?.inputs.api_error_rate?.value).toBe(0.005);
    expect(snapshot).toEqual(before);
    observed.inputs.api_error_rate = {
      value: null,
      sampleSize: 0,
      status: "metric_not_available",
      reason: "ZERO_DENOMINATOR",
    };
    const missing = service.evaluateQuery(
      snapshot,
      query,
      [],
      "historical_trial",
      undefined,
      observation,
    );
    expect(missing.dimensions[2]!.score).toBeNull();
    expect(missing.dimensions[2]!.leaves[0]!.reason).toBe("ZERO_DENOMINATOR");
  });
});
