import {
  collectFormulaDependencies,
  evaluateFormula,
  FormulaValidationError,
  parseFormulaAst,
  topologicalSortFormulaGraph,
  validateFormulaAst,
  type FormulaAst,
  type FormulaMetricReference,
  type NormalizeDirection,
} from "./formula.js";
import { assertMetricKeyRequest, type MetricLibraryType } from "./metric-library.js";
import type { SystemMetricImplementationStatus } from "./generated/system-metric-seed.js";
import {
  RESERVED_SYSTEM_METRIC_KEYS,
  type MetricTimeGranularity,
} from "./system-metric-catalog.js";

// This module consumes version-pinned facts. It never queries a collector, supplies
// demonstration facts, or treats a catalog registration as an implemented query.
export interface ScoreLeaf {
  key: string;
  metricKey: string;
  weight: number;
  enabled: boolean;
  direction: NormalizeDirection;
  target: Readonly<Record<string, number>> | null;
  minimumSample: number;
}

export interface ScoreConfiguration {
  scoreKey: string;
  displayName: string;
  libraryType: MetricLibraryType;
  owner: string | null;
  displayUnit: "points" | "percent";
  scope: "project" | "module";
  granularity: MetricTimeGranularity;
  dimensions: {
    key: string;
    displayName: string;
    weight: number;
    leaves: ScoreLeaf[];
  }[];
  gate: { minimumEligibleDimensions: number; minimumLeafWeightCoverage: number };
  colorBands: { greenMinimum: number; yellowMinimum: number };
  radarDimensions: string[];
}

export interface ScoreMetricReference extends FormulaMetricReference {
  libraryType: MetricLibraryType;
  metricSetVersion: string;
  definitionVersion: string;
  implementationStatus: SystemMetricImplementationStatus;
  formulaAst: FormulaAst | null;
  enabled: boolean;
}

export interface ScoreBinding {
  projectId: string;
  libraryType: MetricLibraryType;
  metricSetVersion: string;
  definitionVersion: string;
  metrics: readonly ScoreMetricReference[];
}

export type ScoreInputStatus =
  | "available"
  | "missing"
  | "insufficient_sample"
  | "missing_target"
  | "partial"
  | "not_collected"
  | "delayed"
  | "broken"
  | "no_data"
  | "metric_not_available"
  | "context_mismatch";

export interface ScoreQueryContext {
  projectId: string;
  env: "prod" | "staging" | "dev";
  metricSetVersion: string;
  definitionVersion: string;
  scopeId: string;
  from: string;
  to: string;
  timezone: string;
  granularity: MetricTimeGranularity;
}

export interface ScoreFact {
  context: ScoreQueryContext;
  value: number | null;
  sampleSize: number | null;
  status: ScoreInputStatus;
  reason: string | null;
  availableFrom: string | null;
}

export interface ScoreEvaluationInput {
  configuration: unknown;
  binding: ScoreBinding;
  context: ScoreQueryContext;
  facts: Readonly<Record<string, ScoreFact>>;
  pipelineStatus: "healthy" | "delayed" | "broken" | "no_data";
  configurationConfirmed: boolean;
  effectiveAt: string | null;
  // Only a separately authorized history-trial service should set historical_trial.
  mode: "current" | "historical_trial";
}

function fail(code: string, path: string): never {
  throw new FormulaValidationError(code, path);
}

function record(value: unknown, keys: readonly string[], path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("SCORE_OBJECT_REQUIRED", path);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    fail("SCORE_FIELD_NOT_ALLOWED", path);
  if (keys.some((key) => !(key in result))) fail("SCORE_FIELD_REQUIRED", path);
  return result;
}

function text(value: unknown, path: string, maximum = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail("SCORE_TEXT_INVALID", path);
  return value.trim();
}

function key(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(result)) fail("SCORE_KEY_INVALID", path);
  return result;
}

function number(value: unknown, path: string, minimum: number, maximum: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    fail("SCORE_NUMBER_INVALID", path);
  return value;
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    fail("SCORE_ENUM_INVALID", path);
  return value as T;
}

function array(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    fail("SCORE_ARRAY_INVALID", path);
  return value;
}

function weight(value: unknown, path: string) {
  const result = number(value, path, 0, 1);
  if (result === 0) fail("SCORE_WEIGHT_INVALID", path);
  return result;
}

function unique(keys: readonly string[], path: string) {
  if (new Set(keys).size !== keys.length) fail("SCORE_DUPLICATE_KEY", path);
}

function sumToOne(weights: readonly number[], path: string) {
  if (Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9)
    fail("SCORE_WEIGHT_SUM_INVALID", path);
}

function normalization(leaf: ScoreLeaf): FormulaAst {
  if (!leaf.target) fail("SCORE_TARGET_REQUIRED", leaf.key);
  return parseFormulaAst({
    type: "normalize",
    direction: leaf.direction,
    input: { type: "metric", metricKey: leaf.metricKey },
    target: leaf.target,
  });
}

/** Runtime parser: strict keys at every level; no arbitrary fields or executable text. */
export function parseScoreConfiguration(input: unknown): ScoreConfiguration {
  const root = record(
    input,
    [
      "scoreKey",
      "displayName",
      "libraryType",
      "owner",
      "displayUnit",
      "scope",
      "granularity",
      "dimensions",
      "gate",
      "colorBands",
      "radarDimensions",
    ],
    "$",
  );
  const scoreKey = key(root.scoreKey, "$.scoreKey");
  assertMetricKeyRequest(scoreKey);
  if (
    RESERVED_SYSTEM_METRIC_KEYS.has(scoreKey) &&
    !["operational_score", "quality_score"].includes(scoreKey)
  )
    fail("SYSTEM_METRIC_KEY_RESERVED", "$.scoreKey");
  const libraryType = choice(
    root.libraryType,
    ["operational", "quality"],
    "$.libraryType",
  );
  if (
    (scoreKey === "operational_score" && libraryType !== "operational") ||
    (scoreKey === "quality_score" && libraryType !== "quality")
  )
    fail("SCORE_TYPE_MISMATCH", "$.scoreKey");
  const dimensions = array(root.dimensions, 3, 6, "$.dimensions").map((raw, index) => {
    const path = `$.dimensions[${index}]`;
    const dim = record(raw, ["key", "displayName", "weight", "leaves"], path);
    const leaves = array(dim.leaves, 1, 20, `${path}.leaves`).map(
      (rawLeaf, leafIndex): ScoreLeaf => {
        const leafPath = `${path}.leaves[${leafIndex}]`;
        const item = record(
          rawLeaf,
          [
            "key",
            "metricKey",
            "weight",
            "enabled",
            "direction",
            "target",
            "minimumSample",
          ],
          leafPath,
        );
        if (typeof item.enabled !== "boolean") fail("SCORE_BOOLEAN_REQUIRED", leafPath);
        const minimumSample = number(item.minimumSample, leafPath, 1, 1_000_000);
        if (!Number.isInteger(minimumSample)) fail("SCORE_SAMPLE_INVALID", leafPath);
        const leaf: ScoreLeaf = {
          key: key(item.key, leafPath),
          metricKey: key(item.metricKey, leafPath),
          weight: weight(item.weight, leafPath),
          enabled: item.enabled,
          direction: choice(
            item.direction,
            ["higher_better", "lower_better", "target_range"],
            leafPath,
          ),
          target: item.target === null ? null : (item.target as Record<string, number>),
          minimumSample,
        };
        assertMetricKeyRequest(leaf.metricKey);
        if (leaf.target !== null) {
          const parsed = normalization(leaf);
          if (parsed.type === "normalize") leaf.target = parsed.target;
        }
        return leaf;
      },
    );
    unique(
      leaves.map((leaf) => leaf.key),
      path,
    );
    sumToOne(
      leaves.map((leaf) => leaf.weight),
      path,
    );
    return {
      key: key(dim.key, path),
      displayName: text(dim.displayName, path),
      weight: weight(dim.weight, path),
      leaves,
    };
  });
  unique(
    dimensions.map((dim) => dim.key),
    "$.dimensions",
  );
  unique(
    dimensions.flatMap((dim) => dim.leaves.map((leaf) => leaf.key)),
    "$.leaves",
  );
  sumToOne(
    dimensions.map((dim) => dim.weight),
    "$.dimensions",
  );
  const gate = record(
    root.gate,
    ["minimumEligibleDimensions", "minimumLeafWeightCoverage"],
    "$.gate",
  );
  const minimumEligibleDimensions = number(
    gate.minimumEligibleDimensions,
    "$.gate",
    3,
    dimensions.length,
  );
  if (!Number.isInteger(minimumEligibleDimensions))
    fail("SCORE_GATE_INVALID", "$.gate");
  const color = record(
    root.colorBands,
    ["greenMinimum", "yellowMinimum"],
    "$.colorBands",
  );
  const greenMinimum = number(color.greenMinimum, "$.colorBands", 0, 100);
  const yellowMinimum = number(color.yellowMinimum, "$.colorBands", 0, 100);
  if (yellowMinimum >= greenMinimum) fail("SCORE_COLOR_ORDER_INVALID", "$.colorBands");
  const radarDimensions = array(root.radarDimensions, 3, 6, "$.radarDimensions").map(
    (value) => key(value, "$.radarDimensions"),
  );
  unique(radarDimensions, "$.radarDimensions");
  if (radarDimensions.some((value) => !dimensions.some((dim) => dim.key === value)))
    fail("SCORE_RADAR_DIMENSION_MISSING", "$.radarDimensions");
  return {
    scoreKey,
    displayName: text(root.displayName, "$.displayName"),
    libraryType,
    owner: root.owner === null ? null : text(root.owner, "$.owner"),
    displayUnit: choice(root.displayUnit, ["points", "percent"], "$.displayUnit"),
    scope: choice(root.scope, ["project", "module"], "$.scope"),
    granularity: choice(
      root.granularity,
      ["5m", "hour", "day", "week", "month"],
      "$.granularity",
    ),
    dimensions,
    gate: {
      minimumEligibleDimensions,
      minimumLeafWeightCoverage: number(gate.minimumLeafWeightCoverage, "$.gate", 0, 1),
    },
    colorBands: { greenMinimum, yellowMinimum },
    radarDimensions,
  };
}

/** Validates both the scoring tree and its transitive, same-version metric DAG. */
export function validateScoreConfiguration(input: unknown, binding: ScoreBinding) {
  const configuration = parseScoreConfiguration(input);
  if (configuration.libraryType !== binding.libraryType)
    fail("SCORE_TYPE_MISMATCH", "$");
  unique(
    binding.metrics.map((metric) => metric.metricKey),
    "$.metrics",
  );
  const byKey = new Map(binding.metrics.map((metric) => [metric.metricKey, metric]));
  if (byKey.has(configuration.scoreKey)) fail("SCORE_KEY_CONFLICT", "$.scoreKey");
  const referenced = new Map<string, ScoreMetricReference>();
  const visiting = new Set<string>();
  const expand = (ast: FormulaAst): FormulaAst => {
    if (ast.type === "metric") {
      const metric = byKey.get(ast.metricKey);
      if (!metric) fail("FORMULA_DEPENDENCY_MISSING", ast.metricKey);
      if (metric.projectId !== binding.projectId)
        fail("FORMULA_CROSS_PROJECT_REFERENCE", ast.metricKey);
      if (metric.libraryType !== binding.libraryType)
        fail("SCORE_CROSS_TYPE_REFERENCE", ast.metricKey);
      if (metric.metricSetVersion !== binding.metricSetVersion)
        fail("SCORE_CROSS_VERSION_REFERENCE", ast.metricKey);
      if (visiting.has(ast.metricKey)) fail("FORMULA_DEPENDENCY_CYCLE", ast.metricKey);
      if (referenced.size >= 20 && !referenced.has(ast.metricKey))
        fail("FORMULA_INPUT_LIMIT_EXCEEDED", ast.metricKey);
      referenced.set(ast.metricKey, metric);
      if (!metric.formulaAst) return ast;
      visiting.add(ast.metricKey);
      const expanded = expand(parseFormulaAst(metric.formulaAst));
      visiting.delete(ast.metricKey);
      return expanded;
    }
    if (ast.type === "binary")
      return { ...ast, left: expand(ast.left), right: expand(ast.right) };
    if (ast.type === "call") return { ...ast, arguments: ast.arguments.map(expand) };
    if (ast.type === "weighted_mean")
      return {
        ...ast,
        items: ast.items.map((item) => ({ ...item, value: expand(item.value) })),
      };
    if (ast.type === "normalize") return { ...ast, input: expand(ast.input) };
    return ast;
  };
  const readiness: { key: string; reason: string }[] = [];
  if (!configuration.owner)
    readiness.push({ key: configuration.scoreKey, reason: "SCORE_OWNER_MISSING" });
  const tree: FormulaAst = {
    type: "weighted_mean",
    items: configuration.dimensions.map((dim) => ({
      weight: dim.weight,
      value: {
        type: "weighted_mean",
        items: dim.leaves.map((leaf) => {
          const direct: FormulaAst = { type: "metric", metricKey: leaf.metricKey };
          expand(direct);
          validateFormulaAst(direct, {
            projectId: binding.projectId,
            outputUnit: byKey.get(leaf.metricKey)!.unit,
            outputScope: configuration.scope,
            outputGranularity: configuration.granularity,
            minimumSample: leaf.minimumSample,
            resolveMetric: (metricKey) => byKey.get(metricKey) ?? null,
          });
          if (!leaf.target && leaf.enabled)
            readiness.push({ key: leaf.key, reason: "SCORE_TARGET_REQUIRED" });
          return {
            weight: leaf.weight,
            value: expand(leaf.target ? normalization(leaf) : direct),
          };
        }),
      },
    })),
  };
  // Includes disabled entries: hiding a node must never bypass complexity limits.
  parseFormulaAst(tree);
  topologicalSortFormulaGraph(
    [...referenced.values()].map((metric) => ({
      metricKey: metric.metricKey,
      projectId: metric.projectId,
      formulaAst: metric.formulaAst,
    })),
    binding.projectId,
  );
  for (const metric of referenced.values()) {
    if (metric.formulaAst)
      validateFormulaAst(metric.formulaAst, {
        projectId: binding.projectId,
        outputUnit: metric.unit,
        outputScope: configuration.scope,
        outputGranularity: configuration.granularity,
        minimumSample: metric.minimumSample,
        resolveMetric: (metricKey) => byKey.get(metricKey) ?? null,
      });
    if (!metric.enabled || metric.implementationStatus !== "implemented")
      readiness.push({
        key: metric.metricKey,
        reason: !metric.enabled ? "METRIC_DISABLED" : metric.implementationStatus,
      });
  }
  return { configuration, dependencies: [...referenced.keys()].sort(), readiness };
}

function identity(context: ScoreQueryContext): string {
  return JSON.stringify([
    context.projectId,
    context.env,
    context.metricSetVersion,
    context.definitionVersion,
    context.scopeId,
    context.from,
    context.to,
    context.timezone,
    context.granularity,
  ]);
}

/** Cache consumers must also include the score key and library type. */
export function scoreQueryIdentity(
  scoreKey: string,
  libraryType: MetricLibraryType,
  context: ScoreQueryContext,
): string {
  return JSON.stringify([scoreKey, libraryType, identity(context)]);
}

function weightedMean(
  items: readonly { value: number; weight: number }[],
): number | null {
  if (!items.length) return null;
  return evaluateFormula(
    {
      type: "weighted_mean",
      items: items.map((item) => ({
        value: { type: "literal", value: item.value },
        weight: item.weight,
      })),
    },
    {},
  ).value;
}

export function evaluateScore(input: ScoreEvaluationInput) {
  const validation = validateScoreConfiguration(input.configuration, input.binding);
  const { configuration } = validation;
  const { context } = input;
  const from = Date.parse(context.from);
  const to = Date.parse(context.to);
  const maximumTo = new Date(from);
  maximumTo.setUTCMonth(maximumTo.getUTCMonth() + 13);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to > maximumTo.getTime()
  )
    fail("SCORE_RANGE_INVALID", "$.context");
  try {
    new Intl.DateTimeFormat("en", { timeZone: context.timezone });
  } catch {
    fail("SCORE_TIMEZONE_INVALID", "$.context");
  }
  if (!["prod", "staging", "dev"].includes(context.env))
    fail("SCORE_ENV_INVALID", "$.context");
  const byKey = new Map(
    input.binding.metrics.map((metric) => [metric.metricKey, metric]),
  );
  const reasons: string[] = [];
  if (!input.configurationConfirmed || !configuration.owner)
    reasons.push("MISSING_CONFIGURATION");
  if (input.pipelineStatus !== "healthy")
    reasons.push(`DATA_${input.pipelineStatus.toUpperCase()}`);
  if (
    context.projectId !== input.binding.projectId ||
    context.metricSetVersion !== input.binding.metricSetVersion ||
    context.definitionVersion !== input.binding.definitionVersion ||
    context.granularity !== configuration.granularity ||
    !context.scopeId ||
    (configuration.scope === "project" && context.scopeId !== context.projectId)
  )
    reasons.push("SCORE_CONTEXT_MISMATCH");
  if (
    input.mode === "current" &&
    (input.effectiveAt === null ||
      !Number.isFinite(Date.parse(input.effectiveAt)) ||
      from < Date.parse(input.effectiveAt))
  )
    reasons.push("VERSION_RANGE_BOUNDARY");
  const factContextMismatch = validation.dependencies.some(
    (metricKey) =>
      input.facts[metricKey] &&
      identity(input.facts[metricKey]!.context) !== identity(context),
  );
  if (factContextMismatch) reasons.push("SCORE_CONTEXT_MISMATCH");
  const resolved = new Map<string, ScoreFact>();
  const resolveFact = (metricKey: string): ScoreFact => {
    const cached = resolved.get(metricKey);
    if (cached) return cached;
    const reference = byKey.get(metricKey)!;
    let fact: ScoreFact = input.facts[metricKey] ?? {
      context,
      value: null,
      sampleSize: null,
      status: "missing",
      reason: "SCORE_FACT_MISSING",
      availableFrom: null,
    };
    if (!reference.enabled || reference.implementationStatus !== "implemented") {
      fact = {
        ...fact,
        value: null,
        status: reference.enabled
          ? (reference.implementationStatus as ScoreInputStatus)
          : "metric_not_available",
        reason: reference.enabled
          ? `METRIC_${reference.implementationStatus.toUpperCase()}`
          : "METRIC_DISABLED",
      };
    } else if (reference.formulaAst) {
      const dependencies = collectFormulaDependencies(reference.formulaAst).map(
        (dependency) => ({ key: dependency, fact: resolveFact(dependency) }),
      );
      const unavailable = dependencies.find(
        (dependency) => dependency.fact.status !== "available",
      );
      if (unavailable) fact = { ...unavailable.fact, value: null };
      else {
        const result = evaluateFormula(
          reference.formulaAst,
          Object.fromEntries(
            dependencies.map((dependency) => [
              dependency.key,
              {
                value: dependency.fact.value,
                sampleSize: dependency.fact.sampleSize,
                status: "available" as const,
              },
            ]),
          ),
        );
        fact = {
          context,
          value: result.value,
          sampleSize: result.sampleSize,
          status: result.status === "available" ? "available" : "metric_not_available",
          reason: result.reason,
          availableFrom:
            dependencies
              .map((dependency) => dependency.fact.availableFrom)
              .filter((value): value is string => value !== null)
              .sort()
              .at(-1) ?? null,
        };
      }
    }
    if (
      fact.status === "available" &&
      (fact.value === null || !Number.isFinite(fact.value))
    )
      fact = {
        ...fact,
        value: null,
        status: "missing",
        reason: "SCORE_VALUE_MISSING_OR_NONFINITE",
      };
    if (
      fact.status === "available" &&
      (fact.sampleSize === null ||
        !Number.isInteger(fact.sampleSize) ||
        fact.sampleSize < Math.max(1, reference.minimumSample))
    )
      fact = {
        ...fact,
        status: "insufficient_sample",
        reason: "SCORE_MINIMUM_SAMPLE_NOT_MET",
      };
    resolved.set(metricKey, fact);
    return fact;
  };
  const dimensions = configuration.dimensions.map((dimension) => {
    const leaves = dimension.leaves.map((leaf) => {
      const reference = byKey.get(leaf.metricKey)!;
      const fact = resolveFact(leaf.metricKey);
      let status: ScoreInputStatus = fact?.status ?? "missing";
      let reason = fact?.reason ?? (fact ? null : "SCORE_FACT_MISSING");
      let score: number | null = null;
      if (reasons.includes("SCORE_CONTEXT_MISMATCH")) {
        status = "context_mismatch";
        reason = "SCORE_CONTEXT_MISMATCH";
      } else if (!leaf.enabled || !reference.enabled) {
        status = "metric_not_available";
        reason = "METRIC_DISABLED";
      } else if (reference.implementationStatus !== "implemented") {
        status = reference.implementationStatus;
        reason = `METRIC_${status.toUpperCase()}`;
      } else if (input.pipelineStatus !== "healthy") {
        status = input.pipelineStatus;
        reason = `DATA_${input.pipelineStatus.toUpperCase()}`;
      } else if (!leaf.target) {
        status = "missing_target";
        reason = "SCORE_TARGET_REQUIRED";
      } else if (
        status === "available" &&
        (fact?.value === null ||
          fact?.value === undefined ||
          !Number.isFinite(fact.value))
      ) {
        status = "missing";
        reason = "SCORE_VALUE_MISSING_OR_NONFINITE";
      } else if (
        status === "available" &&
        (fact?.sampleSize === null ||
          fact?.sampleSize === undefined ||
          !Number.isInteger(fact.sampleSize) ||
          fact.sampleSize < leaf.minimumSample)
      ) {
        status = "insufficient_sample";
        reason = "SCORE_MINIMUM_SAMPLE_NOT_MET";
      }
      if (status === "available" && leaf.enabled && leaf.target && fact) {
        const result = evaluateFormula(normalization(leaf), {
          [leaf.metricKey]: {
            value: fact.value,
            sampleSize: fact.sampleSize,
            status: "available",
          },
        });
        if (result.value !== null && Number.isFinite(result.value)) {
          score = result.value;
          reason = null;
        } else {
          status = "metric_not_available";
          reason = "SCORE_VALUE_NONFINITE";
        }
      }
      return {
        ...leaf,
        unit: reference.unit,
        definitionVersion: reference.definitionVersion,
        rawValue: status === "context_mismatch" ? null : (fact?.value ?? null),
        sampleSize: status === "context_mismatch" ? null : (fact?.sampleSize ?? null),
        availableFrom:
          status === "context_mismatch" ? null : (fact?.availableFrom ?? null),
        status,
        reason,
        score,
        eligible: score !== null,
        configuredWeight: dimension.weight * leaf.weight,
        effectiveWeight: null as number | null,
        contribution: null as number | null,
      };
    });
    const eligible = leaves.filter((leaf) => leaf.eligible);
    const eligibleWeight = eligible.reduce((sum, leaf) => sum + leaf.weight, 0);
    const score = weightedMean(
      eligible.map((leaf) => ({ value: leaf.score!, weight: leaf.weight })),
    );
    return {
      key: dimension.key,
      displayName: dimension.displayName,
      weight: dimension.weight,
      score,
      eligible: score !== null,
      eligibleLeafWeight: eligibleWeight,
      effectiveWeight: null as number | null,
      contribution: null as number | null,
      leaves,
    };
  });
  const enabledLeaves = dimensions
    .flatMap((dimension) => dimension.leaves)
    .filter((leaf) => leaf.enabled);
  const totalWeight = enabledLeaves.reduce(
    (sum, leaf) => sum + leaf.configuredWeight,
    0,
  );
  const coveredWeight = enabledLeaves
    .filter((leaf) => leaf.eligible)
    .reduce((sum, leaf) => sum + leaf.configuredWeight, 0);
  const coverage = totalWeight ? coveredWeight / totalWeight : 0;
  const eligible = dimensions.filter((dimension) => dimension.eligible);
  if (eligible.length < configuration.gate.minimumEligibleDimensions)
    reasons.push("ELIGIBLE_DIMENSIONS_BELOW_GATE");
  if (
    !totalWeight ||
    coverage + Number.EPSILON < configuration.gate.minimumLeafWeightCoverage
  )
    reasons.push("LEAF_WEIGHT_COVERAGE_BELOW_GATE");
  const value = reasons.length
    ? null
    : weightedMean(
        eligible.map((dimension) => ({
          value: dimension.score!,
          weight: dimension.weight,
        })),
      );
  if (value !== null) {
    const dimensionWeight = eligible.reduce(
      (sum, dimension) => sum + dimension.weight,
      0,
    );
    for (const dimension of eligible) {
      dimension.effectiveWeight = dimension.weight / dimensionWeight;
      dimension.contribution = dimension.score! * dimension.effectiveWeight;
      for (const leaf of dimension.leaves.filter((item) => item.eligible)) {
        leaf.effectiveWeight =
          (dimension.effectiveWeight * leaf.weight) / dimension.eligibleLeafWeight;
        leaf.contribution = leaf.score! * leaf.effectiveWeight;
      }
    }
  }
  return {
    scoreKey: configuration.scoreKey,
    displayName: configuration.displayName,
    libraryType: configuration.libraryType,
    context,
    displayUnit: configuration.displayUnit,
    value,
    status: value === null ? ("unavailable" as const) : ("available" as const),
    reasons: [...new Set(reasons)],
    coverage,
    eligibleDimensions: eligible.length,
    dimensions,
    color:
      value === null
        ? "gray"
        : value >= configuration.colorBands.greenMinimum
          ? "green"
          : value >= configuration.colorBands.yellowMinimum
            ? "yellow"
            : "red",
    radar: configuration.radarDimensions.map((dimensionKey) => {
      const dimension = dimensions.find((item) => item.key === dimensionKey)!;
      return {
        key: dimension.key,
        displayName: dimension.displayName,
        value: dimension.score,
      };
    }),
    mode: input.mode,
    effectiveAt: input.effectiveAt,
  };
}

export function evaluateScoreTrend(inputs: readonly ScoreEvaluationInput[]) {
  // No interpolation, averaging totals, or synthetic buckets.
  return inputs.map((input) => evaluateScore(input));
}
