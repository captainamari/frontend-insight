import { describe, it, expect, vi } from "vitest";
import {
  compareProjectCards,
  projectCardState,
  resolveProjectRange,
  ProjectSummaryService,
  type ProjectCardScore,
} from "../src/project-summary.js";
import { scoreColor } from "../src/score-evaluation.js";
import { ScoreManagementService } from "../src/score-management.js";
import type { MySqlStore } from "../src/mysql-store.js";
import type { MetricLibraryService } from "../src/metric-library.js";
const score = (value: number | null, reasons: string[] = []): ProjectCardScore => ({
  scoreKey: "operational_score",
  value,
  status: value === null ? "unavailable" : "available",
  color: "gray",
  versionId: "op",
  version: 1,
  reasons,
  context: {},
  availableFrom: null,
});
describe("R2 project state and canonical range", () => {
  it.each([
    [0, "alert"],
    [59.999, "alert"],
    [60, "alert"],
    [80, "alert"],
    [80.001, "normal"],
    [84.999, "normal"],
    [85, "normal"],
    [100, "normal"],
  ])("separates state threshold at %s", (n, state) =>
    expect(projectCardState("healthy", [score(Number(n)), score(90)]).state).toBe(
      state,
    ),
  );
  it("never treats unknown, no data, missing, partial or insufficient as healthy", () => {
    for (const state of ["unknown", "no_data", "partial"])
      expect(projectCardState(state, [score(90), score(90)]).state).toBe(
        "insufficient_data",
      );
    expect(
      projectCardState("healthy", [score(null, ["insufficient_sample"]), score(90)])
        .state,
    ).toBe("insufficient_data");
    expect(
      projectCardState("healthy", [score(null, ["MISSING_CONFIGURATION"]), score(90)])
        .state,
    ).toBe("missing_configuration");
  });
  it("applies Jesse's alert-first decision without dropping missing reasons", () => {
    for (const pipeline of ["broken", "delayed"]) {
      const r = projectCardState(pipeline, [
        score(null, ["MISSING_CONFIGURATION"]),
        score(null, ["insufficient_sample"]),
      ]);
      expect(r.state).toBe("alert");
      expect(r.reasons.join()).toContain("MISSING_CONFIGURATION");
      expect(r.reasons.join()).toContain("insufficient_sample");
    }
    expect(
      projectCardState("healthy", [score(0), score(null, ["insufficient_sample"])])
        .state,
    ).toBe("alert");
  });
  it("sorts all candidates with deterministic tie breaking before slicing", () => {
    const cards = Array.from({ length: 25 }, (_, i) => ({
      id: String(i).padStart(2, "0"),
      alert: i === 24,
      lastDataAt: i === 23 ? "2026-09-10T00:00:00Z" : null,
    }))
      .reverse()
      .sort(compareProjectCards);
    expect(cards.slice(0, 2).map((x) => x.id)).toEqual(["24", "23"]);
    expect(
      new Set(
        [...cards.slice(0, 12), ...cards.slice(12, 24), ...cards.slice(24)].map(
          (x) => x.id,
        ),
      ).size,
    ).toBe(25);
  });
  it("pins rolling instants, canonical granularity, custom and 13-month bound", () => {
    for (const [range, granularity] of [
      ["7d", "day"],
      ["30d", "day"],
      ["90d", "week"],
      ["365d", "month"],
    ] as const)
      expect(
        resolveProjectRange({ range, env: "prod" }, new Date("2026-09-11T00:00:00Z"))
          .granularity,
      ).toBe(granularity);
    expect(() => resolveProjectRange({ range: "custom", env: "prod" })).toThrow();
    expect(() =>
      resolveProjectRange({
        range: "7d",
        env: "prod",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
      }),
    ).toThrow();
    expect(() =>
      resolveProjectRange({
        range: "custom",
        env: "prod",
        from: "2025-01-01T00:00:00Z",
        to: "2026-02-02T00:00:00Z",
      }),
    ).toThrow();
    expect(
      resolveProjectRange({
        range: "custom",
        env: "dev",
        from: "2025-01-01T00:00:00Z",
        to: "2026-02-01T00:00:00Z",
      }).env,
    ).toBe("dev");
  });
});
describe("R2 batch read query budget", () => {
  it.each([1, 20, 49])(
    "executes four SELECTs plus one fact read for %s candidates",
    async (count) => {
      const statements: string[] = [];
      const rows = Array.from({ length: count }, (_, i) => ({
        id: String(i),
        app_id: String(i),
        name: "项目" + i,
        timezone: i % 2 ? "Asia/Shanghai" : "America/New_York",
        status: "active",
      }));
      const connection = {
        query: vi.fn(async (sql: string) => {
          statements.push(sql);
          return [sql.includes("FROM projects p ") ? rows : []];
        }),
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn(),
      };
      const mysql = {
        pool: { getConnection: async () => connection },
      } as unknown as MySqlStore;
      const observations = {
        projectObservations: vi.fn(async () => ({
          items: [],
          statistics: { rowsRead: 0, bytesRead: 0, elapsedSeconds: 0 },
        })),
      };
      const service = new ProjectSummaryService(
        mysql,
        new ScoreManagementService(mysql, {} as MetricLibraryService),
        observations,
      );
      const result = await service.summary(
        { userId: "viewer", globalRole: "viewer", displayName: "Viewer", email: null },
        { search: "项目", page: 999, pageSize: 12, env: "prod", range: "7d" },
      );
      expect(statements.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(4);
      expect(result.diagnostics.metadataQueries).toBe(4);
      expect(observations.projectObservations).toHaveBeenCalledTimes(1);
      expect(statements.find((sql) => sql.includes("FROM projects p "))).toContain(
        "pm.user_id=?",
      );
      expect(result.total).toBe(count);
      expect(result.page).toBe(Math.ceil(count / 12));
      expect(result.items[0]!.operational.value).toBeNull();
      expect(result.items[0]!.pipeline.state).toBe("no_data");
      expect(result.items[0]!.range.timezone).toBe(
        rows.find((r) => r.id === result.items[0]!.id)!.timezone,
      );
    },
  );
});

it.each([
  [null, "gray"],
  [0, "red"],
  [59.999, "red"],
  [60, "yellow"],
  [80, "yellow"],
  [80.001, "yellow"],
  [84.999, "yellow"],
  [85, "green"],
])("R2 color at %s", (value, color) =>
  expect(scoreColor(value as number | null)).toBe(color),
);
