import { describe, expect, it, vi } from "vitest";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import {
  ProjectOverviewService,
  evaluateOverviewMetrics,
  segmentOverviewBuckets,
} from "../src/project-overview.js";
import { METRIC_CATALOG } from "../src/system-metric-catalog.js";
import type { MetricLibraryDefinition } from "../src/metric-library.js";
import type { FactWindow } from "../src/overview-facts.js";
import { reviewDigest, snapshotDigest } from "../src/score-storage.js";
import { evaluateScore } from "../src/score-evaluation.js";
import { operationalScoreFixture } from "./score-fixture.js";

const pv = {
  ...METRIC_CATALOG.find((m) => m.metricKey === "pv")!,
  id: "pv-id",
  libraryVersionId: "active",
  origin: "system",
  enabled: true,
  formulaAst: null,
} as MetricLibraryDefinition;
function fact(value: number | null): FactWindow {
  const input = {
    value,
    status: value === null ? ("missing" as const) : ("available" as const),
    sampleSize: value === null ? null : 100,
    reason: value === null ? "NO_EVENTS_IN_BUCKET" : null,
  };
  return {
    inputs: { pv: input },
    raw: { pv: input },
    events: 100,
    lastDataAt: "2026-09-15T00:00:00Z",
  };
}
describe("R3 same evaluator, versions and honest facts", () => {
  it("keeps real zero, null, sample gates and raw observed facts separate", () => {
    expect(evaluateOverviewMetrics([pv], ["pv"], fact(0), "day", null)[0]!.value).toBe(
      0,
    );
    expect(
      evaluateOverviewMetrics([pv], ["pv"], fact(null), "day", null)[0]!.value,
    ).toBeNull();
    const partial = fact(5);
    partial.inputs.pv = {
      value: null,
      sampleSize: 5,
      status: "metric_not_available",
      reason: "ENV_EXPOSURE_NOT_VERIFIED",
    };
    expect(
      evaluateOverviewMetrics([pv], ["pv"], partial, "day", null)[0],
    ).toMatchObject({ value: null, rawValue: 5, reason: "ENV_EXPOSURE_NOT_VERIFIED" });
    expect(
      evaluateOverviewMetrics(
        [{ ...pv, minimumSample: 101 }],
        ["pv"],
        fact(5),
        "day",
        null,
      )[0],
    ).toMatchObject({ value: null, reason: "METRIC_MINIMUM_SAMPLE_NOT_MET" });
    expect(
      evaluateOverviewMetrics(
        [{ ...pv, definitionVersion: "historical-identity" }],
        ["pv"],
        partial,
        "day",
        null,
      )[0]!.rawValue,
    ).toBeNull();
  });
  it("runs business AST in the window and buckets, never averages ratios", () => {
    const ratio = {
      ...pv,
      origin: "business" as const,
      metricKey: "inverse_pv",
      formulaAst: {
        type: "binary" as const,
        operator: "/" as const,
        left: { type: "literal" as const, value: 100 },
        right: { type: "metric" as const, metricKey: "pv" },
      },
    };
    const run = (n: number) =>
      evaluateOverviewMetrics([pv, ratio], [ratio.metricKey], fact(n), "day", null)[0]!
        .value;
    expect(run(10)).toBe(10);
    expect(run(40)).toBe(2.5);
    expect(run(50)).toBe(2);
    expect(run(50)).not.toBe((run(10)! + run(40)!) / 2);
    expect(
      evaluateOverviewMetrics(
        [pv],
        ["pv"],
        fact(10),
        "day",
        "VERSION_RANGE_BOUNDARY",
      )[0],
    ).toMatchObject({ value: null, rawValue: null });
  });
  it("splits within buckets, records old and reactivated identities, and leaves unversioned gaps", () => {
    const query = resolveProjectCalendar(
      {
        range: "custom",
        env: "prod",
        from: "2026-09-14T00:00:00Z",
        to: "2026-09-16T00:00:00Z",
      },
      "UTC",
    );
    const pieces = segmentOverviewBuckets(query.buckets, [
      {
        versionId: "a",
        effectiveFrom: "2026-09-14T03:00:00.000Z",
        effectiveTo: "2026-09-15T03:00:00.000Z",
      },
      {
        versionId: "b",
        effectiveFrom: "2026-09-15T03:00:00.000Z",
        effectiveTo: "2026-09-15T08:00:00.000Z",
      },
      { versionId: "a", effectiveFrom: "2026-09-15T08:00:00.000Z", effectiveTo: null },
    ]);
    expect(pieces.map((p) => p.versionId)).toEqual([null, "a", "a", "b", "a"]);
    expect(pieces[1]!.segment).not.toBe(pieces[4]!.segment);
    pieces.slice(1).forEach((p, i) => expect(p.from).toBe(pieces[i]!.to));
  });
  it("display selection leaves R1-C formula, contributions and definition digest unchanged", () => {
    const input = operationalScoreFixture();
    const r = evaluateScore(input);
    expect(r.value).toBeCloseTo(76.15, 8);
    expect(r.dimensions.reduce((sum, d) => sum + (d.contribution ?? 0), 0)).toBeCloseTo(
      r.value!,
      8,
    );
    const before = JSON.stringify(r);
    const selected = r.dimensions.slice(0, 3);
    expect(
      selected.every((d) => d.score !== null && d.score >= 0 && d.score <= 100),
    ).toBe(true);
    expect(JSON.stringify(r)).toBe(before);
    const digest = snapshotDigest("v", input.configuration, {}, [pv]);
    expect(reviewDigest(digest, [])).toBe(digest);
    expect(
      reviewDigest(digest, [
        { metricKey: "pv", route: "project-overview", surface: "overview", order: 0 },
      ]),
    ).not.toBe(digest);
  });
});

describe("R3 read-model query growth", () => {
  it("keeps batched queries constant at 1/24 bindings and daily/monthly buckets, enforces 4 per unit", async () => {
    let count = 1;
    const definitions = Array.from({ length: 24 }, (_, n) => ({
      ...pv,
      metricKey: "metric_" + n,
    }));
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT p.*"))
          return [
            [
              {
                id: "p",
                name: "test",
                timezone: "UTC",
                app_id: "app",
                retention_days: 90,
              },
            ],
          ];
        if (sql.includes("b.route_name"))
          return [
            definitions
              .slice(0, count)
              .map((d) => ({ library_version_id: "v", metric_key: d.metricKey })),
          ];
        return [[]];
      }),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    const scoreReader = {
      readActiveBatch: vi.fn(async (c: typeof connection) => {
        for (const sql of ["SELECT versions", "SELECT definitions", "SELECT periods"])
          await c.query(sql);
        return [
          {
            libraryType: "operational",
            version: { id: "v", version: 1, activatedAt: "2025-01-01T00:00:00.000Z" },
            snapshot: { definitions },
            result: null,
            activationPeriods: [
              {
                versionId: "v",
                effectiveFrom: "2025-01-01T00:00:00.000Z",
                effectiveTo: null,
              },
            ],
          },
        ];
      }),
    };
    const observations = {
      projectObservations: vi.fn(async () => ({ items: [], statistics: {} })),
    };
    const facts = {
      read: vi.fn(async (_p: string, _e: string, buckets: unknown[]) => ({
        window: fact(null),
        buckets: buckets.map(() => fact(null)),
        availableFrom: null,
        statistics: { rowsRead: 0, bytesRead: 0, elapsedSeconds: 0 },
      })),
    };
    const alerts = {
      overviewEvidence: vi.fn(async () => ({
        status: "unavailable",
        reason: "no_data",
        scope: {},
        items: [],
      })),
    };
    type Args = ConstructorParameters<typeof ProjectOverviewService>;
    const service = new ProjectOverviewService(
      { pool: { getConnection: async () => connection } } as unknown as Args[0],
      scoreReader as unknown as Args[1],
      observations as unknown as Args[2],
      facts as unknown as Args[3],
      alerts as unknown as Args[4],
    );
    for (const n of [1, 24]) {
      count = n;
      for (const range of ["7d", "365d"] as const) {
        const before = facts.read.mock.calls.length;
        const r = await service.overview("p", {
          range,
          env: "prod",
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-08T00:00:00Z",
        });
        expect(r.metrics.cards).toHaveLength(n);
        expect(r.diagnostics.metadataQueries).toBe(6);
        expect(facts.read.mock.calls.length - before).toBe(1);
      }
    }
    await expect(
      service.overview("p", {
        range: "7d",
        env: "prod",
        metrics: definitions.slice(0, 5).map((d) => d.metricKey),
      }),
    ).rejects.toMatchObject({ code: "OVERVIEW_UNIT_SERIES_LIMIT" });
    expect(facts.read).toHaveBeenCalledTimes(4);
    expect(observations.projectObservations).toHaveBeenCalledTimes(4);
    expect(alerts.overviewEvidence).toHaveBeenCalledTimes(4);
  });
});
