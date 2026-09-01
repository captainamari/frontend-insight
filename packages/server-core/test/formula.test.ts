import { describe, expect, it } from "vitest";
import {
  evaluateFormula,
  evaluateFormulaTrend,
  FORMULA_LIMITS,
  FormulaValidationError,
  parseFormulaAst,
  topologicalSortFormulaGraph,
  validateFormulaAst,
  type FormulaAst,
  type FormulaMetricReference,
} from "../src/formula.js";

const projectId = "project-a";
const references: Record<string, FormulaMetricReference> = {
  views: metric("views", "views", 1),
  sessions_count: metric("sessions_count", "session_count", 1),
  ratio_a: metric("ratio_a", "ratio", 5),
  ratio_b: metric("ratio_b", "ratio", 10),
  latency: metric("latency", "milliseconds", 5),
  users_count: metric("users_count", "users", 1),
};

function metric(
  metricKey: string,
  unit: string,
  minimumSample: number,
): FormulaMetricReference {
  return {
    metricKey,
    projectId,
    unit,
    entityScopes: ["project", "module"],
    timeGranularities: ["day", "week"],
    minimumSample,
  };
}

function validate(ast: unknown, outputUnit = "ratio", minimumSample = 10) {
  return validateFormulaAst(ast, {
    projectId,
    outputUnit,
    outputScope: "project",
    outputGranularity: "day",
    minimumSample,
    resolveMetric: (key) => references[key] ?? null,
  });
}

function code(operation: () => unknown): string {
  try {
    operation();
    return "NO_ERROR";
  } catch (cause) {
    expect(cause).toBeInstanceOf(FormulaValidationError);
    return (cause as FormulaValidationError).code;
  }
}

describe("controlled formula parser", () => {
  it("rejects source text, SQL-shaped fields, arbitrary fields and unapproved functions", () => {
    expect(code(() => parseFormulaAst("SELECT 1"))).toBe("FORMULA_NODE_INVALID");
    expect(
      code(() =>
        parseFormulaAst({ type: "metric", metricKey: "views", sql: "SELECT value" }),
      ),
    ).toBe("FORMULA_FIELD_NOT_ALLOWED");
    expect(
      code(() =>
        parseFormulaAst({ type: "metric", metricKey: "views", field: "raw.secret" }),
      ),
    ).toBe("FORMULA_FIELD_NOT_ALLOWED");
    expect(
      code(() =>
        parseFormulaAst({
          type: "call",
          function: "eval",
          arguments: [{ type: "metric", metricKey: "views" }],
        }),
      ),
    ).toBe("FORMULA_FUNCTION_NOT_ALLOWED");
    expect(
      code(() =>
        parseFormulaAst({
          type: "call",
          function: "coalesce",
          arguments: [
            { type: "metric", metricKey: "views" },
            { type: "literal", value: 0 },
          ],
        }),
      ),
    ).toBe("FORMULA_FUNCTION_NOT_ALLOWED");
  });

  it("enforces maximum inputs, depth and nodes at their exact boundaries", () => {
    const refs: Record<string, FormulaMetricReference> = {};
    for (let index = 0; index <= FORMULA_LIMITS.maximumInputs; index += 1) {
      refs[`input_${index}`] = metric(`input_${index}`, "ratio", 1);
    }
    const manyInputs = Array.from(
      { length: FORMULA_LIMITS.maximumInputs + 1 },
      (_, index) => ({
        value: { type: "metric", metricKey: `input_${index}` },
        weight: 1,
      }),
    );
    expect(
      validateFormulaAst(
        { type: "weighted_mean", items: manyInputs.slice(0, 20) },
        {
          projectId,
          outputUnit: "ratio",
          outputScope: "project",
          outputGranularity: "day",
          minimumSample: 1,
          resolveMetric: (key) => refs[key] ?? null,
        },
      ).dependencies,
    ).toHaveLength(20);
    expect(
      code(() =>
        validateFormulaAst(
          { type: "weighted_mean", items: manyInputs },
          {
            projectId,
            outputUnit: "ratio",
            outputScope: "project",
            outputGranularity: "day",
            minimumSample: 1,
            resolveMetric: (key) => refs[key] ?? null,
          },
        ),
      ),
    ).toBe("FORMULA_INPUT_LIMIT_EXCEEDED");

    let allowedDepth: unknown = { type: "metric", metricKey: "ratio_a" };
    for (let index = 1; index < FORMULA_LIMITS.maximumDepth; index += 1) {
      allowedDepth = {
        type: "binary",
        operator: "*",
        left: allowedDepth,
        right: { type: "literal", value: 1 },
      };
    }
    expect(parseFormulaAst(allowedDepth)).toBeDefined();
    const deep = {
      type: "binary",
      operator: "*",
      left: allowedDepth,
      right: { type: "literal", value: 1 },
    };
    expect(code(() => parseFormulaAst(deep))).toBe("FORMULA_DEPTH_LIMIT_EXCEEDED");

    const maximumNodes = {
      type: "weighted_mean",
      items: Array.from({ length: 99 }, () => ({
        value: { type: "metric", metricKey: "ratio_a" },
        weight: 1,
      })),
    };
    expect(parseFormulaAst(maximumNodes)).toBeDefined();
    const manyNodes = {
      ...maximumNodes,
      items: [
        ...(maximumNodes.items as Array<unknown>),
        { value: { type: "metric", metricKey: "ratio_a" }, weight: 1 },
      ],
    };
    expect(code(() => parseFormulaAst(manyNodes))).toBe("FORMULA_NODE_LIMIT_EXCEEDED");
  });
});

describe("formula semantic validation", () => {
  it("accepts same-unit arithmetic and rejects incompatible addition", () => {
    expect(
      validate({
        type: "binary",
        operator: "+",
        left: { type: "metric", metricKey: "ratio_a" },
        right: { type: "metric", metricKey: "ratio_b" },
      }).unit,
    ).toBe("ratio");
    expect(
      code(() =>
        validate(
          {
            type: "binary",
            operator: "+",
            left: { type: "metric", metricKey: "views" },
            right: { type: "metric", metricKey: "latency" },
          },
          "views",
        ),
      ),
    ).toBe("FORMULA_UNIT_INCOMPATIBLE");
  });

  it("allows scalar multiplication/division and approved compound units only", () => {
    expect(
      validate(
        {
          type: "binary",
          operator: "*",
          left: { type: "metric", metricKey: "latency" },
          right: { type: "literal", value: 2 },
        },
        "milliseconds",
      ).unit,
    ).toBe("milliseconds");
    expect(
      validate(
        {
          type: "binary",
          operator: "/",
          left: { type: "metric", metricKey: "views" },
          right: { type: "metric", metricKey: "sessions_count" },
        },
        "views_per_session",
      ).unit,
    ).toBe("views_per_session");
    expect(
      validate(
        {
          type: "call",
          function: "clamp",
          arguments: [
            { type: "metric", metricKey: "latency" },
            { type: "literal", value: 0 },
            { type: "literal", value: 1_000 },
          ],
        },
        "milliseconds",
      ).unit,
    ).toBe("milliseconds");
    expect(
      code(() =>
        validate(
          {
            type: "binary",
            operator: "*",
            left: { type: "metric", metricKey: "views" },
            right: { type: "metric", metricKey: "latency" },
          },
          "views",
        ),
      ),
    ).toBe("FORMULA_UNIT_INCOMPATIBLE");
  });

  it("validates scope, granularity and minimum sample", () => {
    expect(
      code(() =>
        validateFormulaAst(
          { type: "metric", metricKey: "ratio_b" },
          {
            projectId,
            outputUnit: "ratio",
            outputScope: "page",
            outputGranularity: "day",
            minimumSample: 10,
            resolveMetric: (key) => references[key] ?? null,
          },
        ),
      ),
    ).toBe("FORMULA_SCOPE_INCOMPATIBLE");
    expect(
      code(() =>
        validateFormulaAst(
          { type: "metric", metricKey: "ratio_b" },
          {
            projectId,
            outputUnit: "ratio",
            outputScope: "project",
            outputGranularity: "hour",
            minimumSample: 10,
            resolveMetric: (key) => references[key] ?? null,
          },
        ),
      ),
    ).toBe("FORMULA_GRANULARITY_INCOMPATIBLE");
    expect(
      code(() => validate({ type: "metric", metricKey: "ratio_b" }, "ratio", 9)),
    ).toBe("FORMULA_MINIMUM_SAMPLE_TOO_LOW");
  });

  it("fails fast for missing dependencies and cross-project references", () => {
    expect(code(() => validate({ type: "metric", metricKey: "unknown_metric" }))).toBe(
      "FORMULA_DEPENDENCY_MISSING",
    );
    const cross = { ...references.ratio_a!, projectId: "project-b" };
    expect(
      code(() =>
        validateFormulaAst(
          { type: "metric", metricKey: "ratio_a" },
          {
            projectId,
            outputUnit: "ratio",
            outputScope: "project",
            outputGranularity: "day",
            minimumSample: 5,
            resolveMetric: () => cross,
          },
        ),
      ),
    ).toBe("FORMULA_CROSS_PROJECT_REFERENCE");
  });
});

describe("authoritative evaluator", () => {
  const divide: FormulaAst = {
    type: "binary",
    operator: "/",
    left: { type: "metric", metricKey: "views" },
    right: { type: "metric", metricKey: "sessions_count" },
  };

  it("returns unavailable for a zero divisor", () => {
    expect(
      evaluateFormula(divide, {
        views: { value: 10, status: "available", sampleSize: 10 },
        sessions_count: { value: 0, status: "available", sampleSize: 0 },
      }),
    ).toMatchObject({
      value: null,
      status: "metric_not_available",
      reason: "FORMULA_DIVISOR_ZERO",
    });
  });

  it.each([
    ["missing", "missing"],
    ["insufficient_sample", "insufficient_sample"],
    ["data_delayed", "data_delayed"],
  ] as const)("propagates %s without replacing it by zero", (inputStatus, expected) => {
    expect(
      evaluateFormula(divide, {
        views: { value: null, status: inputStatus, sampleSize: 2 },
        sessions_count: { value: 5, status: "available", sampleSize: 5 },
      }),
    ).toMatchObject({ value: null, status: expected });
  });

  it("uses exactly the same evaluator for total and each trend bucket", () => {
    const inputs = {
      views: { value: 120, status: "available" as const, sampleSize: 120 },
      sessions_count: { value: 40, status: "available" as const, sampleSize: 40 },
    };
    const total = evaluateFormula(divide, inputs);
    const trend = evaluateFormulaTrend(divide, [
      { bucket: "2026-08-01", inputs },
      { bucket: "2026-08-02", inputs },
    ]);
    expect(total.value).toBe(3);
    expect(trend.map((item) => item.value)).toEqual([total.value, total.value]);
  });

  it("matches three hand-calculated business metric fixtures exactly", () => {
    const fixtureOne = evaluateFormula(divide, {
      views: { value: 120, status: "available", sampleSize: 120 },
      sessions_count: { value: 40, status: "available", sampleSize: 40 },
    });
    const fixtureTwo = evaluateFormula(
      {
        type: "weighted_mean",
        items: [
          { value: { type: "metric", metricKey: "ratio_a" }, weight: 3 },
          { value: { type: "metric", metricKey: "ratio_b" }, weight: 2 },
        ],
      },
      {
        ratio_a: { value: 80, status: "available", sampleSize: 20 },
        ratio_b: { value: 60, status: "available", sampleSize: 20 },
      },
    );
    const fixtureThree = evaluateFormula(
      {
        type: "normalize",
        direction: "lower_better",
        input: { type: "metric", metricKey: "latency" },
        target: { target: 100, ceiling: 500 },
      },
      { latency: { value: 300, status: "available", sampleSize: 10 } },
    );
    expect(fixtureOne.value).toBe(3); // 120 / 40
    expect(fixtureTwo.value).toBe(72); // (80×3 + 60×2) / 5
    expect(fixtureThree.value).toBe(50); // 100×(500-300)/(500-100)
  });
});

describe("formula DAG", () => {
  it("sorts dependencies before consumers", () => {
    const order = topologicalSortFormulaGraph(
      [
        { metricKey: "base_metric", projectId, formulaAst: null },
        {
          metricKey: "derived_one",
          projectId,
          formulaAst: { type: "metric", metricKey: "base_metric" },
        },
        {
          metricKey: "derived_two",
          projectId,
          formulaAst: { type: "metric", metricKey: "derived_one" },
        },
      ],
      projectId,
    );
    expect(order.indexOf("base_metric")).toBeLessThan(order.indexOf("derived_one"));
    expect(order.indexOf("derived_one")).toBeLessThan(order.indexOf("derived_two"));
  });

  it("fails fast for cycles and missing graph dependencies", () => {
    expect(
      code(() =>
        topologicalSortFormulaGraph(
          [
            {
              metricKey: "metric_one",
              projectId,
              formulaAst: { type: "metric", metricKey: "metric_two" },
            },
            {
              metricKey: "metric_two",
              projectId,
              formulaAst: { type: "metric", metricKey: "metric_one" },
            },
          ],
          projectId,
        ),
      ),
    ).toBe("FORMULA_DEPENDENCY_CYCLE");
    expect(
      code(() =>
        topologicalSortFormulaGraph(
          [
            {
              metricKey: "metric_one",
              projectId,
              formulaAst: { type: "metric", metricKey: "missing_metric" },
            },
          ],
          projectId,
        ),
      ),
    ).toBe("FORMULA_DEPENDENCY_MISSING");
  });
});
