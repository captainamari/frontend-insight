import { describe, expect, it } from "vitest";
import {
  resolveProductPresentation,
  type ProductPresentation,
} from "../src/presentation.js";

const base = {
  loading: false,
  hasData: true,
  errorStatus: null,
  dataState: "healthy" as const,
  hasActivity: true,
  hasGaps: false,
};

describe("M5 product presentation states", () => {
  const cases: Array<
    [ProductPresentation, Partial<Parameters<typeof resolveProductPresentation>[0]>]
  > = [
    ["ready", {}],
    ["loading", { loading: true, hasData: false }],
    ["onboarding", { dataState: "no_data", hasActivity: false }],
    ["no_activity", { hasActivity: false }],
    ["delayed", { dataState: "delayed" }],
    ["partial", { hasGaps: true }],
    ["error", { errorStatus: 500, hasData: false }],
    ["forbidden", { errorStatus: 403, hasData: false }],
    ["stale", { errorStatus: 503, hasData: true }],
  ];

  for (const [expected, overrides] of cases) {
    it(`resolves ${expected} without conflating it with another state`, () => {
      expect(resolveProductPresentation({ ...base, ...overrides })).toBe(expected);
    });
  }
});
