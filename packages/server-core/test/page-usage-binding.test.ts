import { it, expect } from "vitest";
import { bindPageUsage } from "../src/page-usage-binding.js";
import { METRIC_CATALOG } from "../src/system-metric-catalog.js";
import type { MetricLibraryDefinition } from "../src/metric-library.js";
const pv = {
  ...METRIC_CATALOG.find((d) => d.metricKey === "pv")!,
  id: "pv",
  libraryVersionId: "v",
  enabled: true,
  formulaAst: null,
} as MetricLibraryDefinition;
it("R6 refuses historical semantic relabeling, honors bounds, formulas and minimum sample", () => {
  const inputs = {
    pv: { value: 2, status: "available" as const, sampleSize: 2, reason: null },
  };
  expect(bindPageUsage([pv], ["pv"], inputs)[0]?.value).toBe(2);
  expect(
    bindPageUsage(
      [{ ...pv, definitionVersion: "system-identity-2026-09-09.1" }],
      ["pv"],
      inputs,
    )[0]?.reason,
  ).toBe("PAGE_DEFINITION_UPGRADE_REQUIRED");
  expect(bindPageUsage([pv], ["pv"], inputs, true)[0]?.reason).toBe(
    "VERSION_RANGE_BOUNDARY",
  );
  expect(
    bindPageUsage([{ ...pv, minimumSample: 3 }], ["pv"], inputs)[0]?.value,
  ).toBeNull();
  const derived = {
    ...pv,
    metricKey: "double_pv",
    origin: "business" as const,
    formulaAst: {
      type: "binary" as const,
      operator: "*" as const,
      left: { type: "metric" as const, metricKey: "pv" },
      right: { type: "literal" as const, value: 2 },
    },
  };
  expect(bindPageUsage([pv, derived], ["double_pv"], inputs)[0]?.value).toBe(4);
});
