import type {
  MetricEntityScope,
  MetricTimeGranularity,
} from "./system-metric-catalog.js";

export const FORMULA_LIMITS = Object.freeze({
  maximumInputs: 20,
  maximumDepth: 8,
  maximumNodes: 100,
});

export type BinaryOperator = "+" | "-" | "*" | "/";
export type FormulaFunction = "min" | "max" | "clamp";
export type NormalizeDirection = "higher_better" | "lower_better" | "target_range";

export type FormulaAst =
  | { readonly type: "metric"; readonly metricKey: string }
  | { readonly type: "literal"; readonly value: number }
  | {
      readonly type: "binary";
      readonly operator: BinaryOperator;
      readonly left: FormulaAst;
      readonly right: FormulaAst;
    }
  | {
      readonly type: "call";
      readonly function: FormulaFunction;
      readonly arguments: readonly FormulaAst[];
    }
  | {
      readonly type: "weighted_mean";
      readonly items: readonly {
        readonly value: FormulaAst;
        readonly weight: number;
      }[];
    }
  | {
      readonly type: "normalize";
      readonly direction: NormalizeDirection;
      readonly input: FormulaAst;
      readonly target: Readonly<Record<string, number>>;
    };

export type FormulaInputStatus =
  | "available"
  | "missing"
  | "insufficient_sample"
  | "data_delayed"
  | "metric_not_available";

export interface FormulaInputValue {
  readonly value: number | null;
  readonly status: FormulaInputStatus;
  readonly sampleSize: number | null;
  readonly reason?: string | null;
}

export interface FormulaEvaluationResult {
  readonly value: number | null;
  readonly status: FormulaInputStatus;
  readonly sampleSize: number | null;
  readonly reason: string | null;
}

export interface FormulaMetricReference {
  readonly metricKey: string;
  readonly projectId: string;
  readonly unit: string;
  readonly entityScopes: readonly MetricEntityScope[];
  readonly timeGranularities: readonly MetricTimeGranularity[];
  readonly minimumSample: number;
}

export interface FormulaValidationContext {
  readonly projectId: string;
  readonly outputUnit: string;
  readonly outputScope: MetricEntityScope;
  readonly outputGranularity: MetricTimeGranularity;
  readonly minimumSample: number;
  readonly resolveMetric: (metricKey: string) => FormulaMetricReference | null;
}

export interface FormulaValidationResult {
  readonly ast: FormulaAst;
  readonly unit: string;
  readonly dependencies: readonly string[];
  readonly nodeCount: number;
  readonly depth: number;
  readonly minimumSample: number;
}

export class FormulaValidationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}:${path}`);
    this.name = "FormulaValidationError";
  }
}

const METRIC_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
) => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new FormulaValidationError("FORMULA_FIELD_NOT_ALLOWED", `${path}.${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new FormulaValidationError("FORMULA_FIELD_REQUIRED", `${path}.${key}`);
    }
  }
};

function objectAt(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FormulaValidationError("FORMULA_NODE_INVALID", path);
  }
  return input as Record<string, unknown>;
}

function finiteNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new FormulaValidationError("FORMULA_NUMBER_INVALID", path);
  }
  return input;
}

/** Strictly parses JSON data into the only executable formula representation. */
export function parseFormulaAst(input: unknown): FormulaAst {
  let nodeCount = 0;
  const parse = (raw: unknown, path: string, depth: number): FormulaAst => {
    nodeCount += 1;
    if (nodeCount > FORMULA_LIMITS.maximumNodes) {
      throw new FormulaValidationError("FORMULA_NODE_LIMIT_EXCEEDED", path, {
        maximum: FORMULA_LIMITS.maximumNodes,
      });
    }
    if (depth > FORMULA_LIMITS.maximumDepth) {
      throw new FormulaValidationError("FORMULA_DEPTH_LIMIT_EXCEEDED", path, {
        maximum: FORMULA_LIMITS.maximumDepth,
      });
    }
    const value = objectAt(raw, path);
    const type = value.type;
    if (type === "metric") {
      exactKeys(value, ["type", "metricKey"], path);
      if (
        typeof value.metricKey !== "string" ||
        !METRIC_KEY_PATTERN.test(value.metricKey)
      ) {
        throw new FormulaValidationError(
          "FORMULA_METRIC_KEY_INVALID",
          `${path}.metricKey`,
        );
      }
      return Object.freeze({ type, metricKey: value.metricKey });
    }
    if (type === "literal") {
      exactKeys(value, ["type", "value"], path);
      return Object.freeze({ type, value: finiteNumber(value.value, `${path}.value`) });
    }
    if (type === "binary") {
      exactKeys(value, ["type", "operator", "left", "right"], path);
      if (!["+", "-", "*", "/"].includes(String(value.operator))) {
        throw new FormulaValidationError(
          "FORMULA_OPERATOR_NOT_ALLOWED",
          `${path}.operator`,
        );
      }
      return Object.freeze({
        type,
        operator: value.operator as BinaryOperator,
        left: parse(value.left, `${path}.left`, depth + 1),
        right: parse(value.right, `${path}.right`, depth + 1),
      });
    }
    if (type === "call") {
      exactKeys(value, ["type", "function", "arguments"], path);
      if (!["min", "max", "clamp"].includes(String(value.function))) {
        throw new FormulaValidationError(
          "FORMULA_FUNCTION_NOT_ALLOWED",
          `${path}.function`,
        );
      }
      if (!Array.isArray(value.arguments)) {
        throw new FormulaValidationError(
          "FORMULA_ARGUMENTS_INVALID",
          `${path}.arguments`,
        );
      }
      const functionName = value.function as FormulaFunction;
      const requiredLength = functionName === "clamp" ? 3 : 2;
      if (
        value.arguments.length < requiredLength ||
        (functionName === "clamp" && value.arguments.length !== 3)
      ) {
        throw new FormulaValidationError("FORMULA_ARITY_INVALID", `${path}.arguments`);
      }
      return Object.freeze({
        type,
        function: functionName,
        arguments: Object.freeze(
          value.arguments.map((item, index) =>
            parse(item, `${path}.arguments[${index}]`, depth + 1),
          ),
        ),
      });
    }
    if (type === "weighted_mean") {
      exactKeys(value, ["type", "items"], path);
      if (!Array.isArray(value.items) || value.items.length < 1) {
        throw new FormulaValidationError("FORMULA_ITEMS_INVALID", `${path}.items`);
      }
      const items = value.items.map((rawItem, index) => {
        const itemPath = `${path}.items[${index}]`;
        const item = objectAt(rawItem, itemPath);
        exactKeys(item, ["value", "weight"], itemPath);
        const weight = finiteNumber(item.weight, `${itemPath}.weight`);
        if (weight <= 0) {
          throw new FormulaValidationError(
            "FORMULA_WEIGHT_INVALID",
            `${itemPath}.weight`,
          );
        }
        return Object.freeze({
          value: parse(item.value, `${itemPath}.value`, depth + 1),
          weight,
        });
      });
      return Object.freeze({ type, items: Object.freeze(items) });
    }
    if (type === "normalize") {
      exactKeys(value, ["type", "direction", "input", "target"], path);
      if (
        !["higher_better", "lower_better", "target_range"].includes(
          String(value.direction),
        )
      ) {
        throw new FormulaValidationError(
          "FORMULA_DIRECTION_NOT_ALLOWED",
          `${path}.direction`,
        );
      }
      const target = objectAt(value.target, `${path}.target`);
      const direction = value.direction as NormalizeDirection;
      const targetKeys =
        direction === "higher_better"
          ? ["floor", "target"]
          : direction === "lower_better"
            ? ["target", "ceiling"]
            : ["toleranceMin", "targetMin", "targetMax", "toleranceMax"];
      exactKeys(target, targetKeys, `${path}.target`);
      const parsedTarget = Object.fromEntries(
        targetKeys.map((key) => [
          key,
          finiteNumber(target[key], `${path}.target.${key}`),
        ]),
      );
      validateNormalizeTarget(direction, parsedTarget, `${path}.target`);
      return Object.freeze({
        type,
        direction,
        input: parse(value.input, `${path}.input`, depth + 1),
        target: Object.freeze(parsedTarget),
      });
    }
    throw new FormulaValidationError("FORMULA_NODE_TYPE_NOT_ALLOWED", `${path}.type`);
  };
  return parse(input, "$", 1);
}

function validateNormalizeTarget(
  direction: NormalizeDirection,
  target: Readonly<Record<string, number>>,
  path: string,
): void {
  if (direction === "higher_better" && !(target.floor! < target.target!)) {
    throw new FormulaValidationError("FORMULA_TARGET_INVALID", path);
  }
  if (direction === "lower_better" && !(target.target! < target.ceiling!)) {
    throw new FormulaValidationError("FORMULA_TARGET_INVALID", path);
  }
  if (
    direction === "target_range" &&
    !(
      target.toleranceMin! < target.targetMin! &&
      target.targetMin! <= target.targetMax! &&
      target.targetMax! < target.toleranceMax!
    )
  ) {
    throw new FormulaValidationError("FORMULA_TARGET_INVALID", path);
  }
}

interface InferredNode {
  unit: string;
  nodeCount: number;
  depth: number;
  dependencies: Set<string>;
  minimumSample: number;
}

const APPROVED_DIVISION_UNITS: Readonly<Record<string, string>> = Object.freeze({
  "milliseconds/users": "milliseconds_per_user",
  "views/session_count": "views_per_session",
  "pages/session_count": "pages_per_session",
  "errors/views": "ratio",
  "errors/requests": "ratio",
  "failures/operations": "ratio",
});

function combineSets(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

export function validateFormulaAst(
  input: unknown,
  context: FormulaValidationContext,
): FormulaValidationResult {
  const ast = parseFormulaAst(input);
  const infer = (node: FormulaAst, path: string): InferredNode => {
    if (node.type === "literal") {
      return {
        unit: "scalar",
        nodeCount: 1,
        depth: 1,
        dependencies: new Set(),
        minimumSample: 0,
      };
    }
    if (node.type === "metric") {
      const reference = context.resolveMetric(node.metricKey);
      if (!reference) {
        throw new FormulaValidationError("FORMULA_DEPENDENCY_MISSING", path, {
          metricKey: node.metricKey,
        });
      }
      if (reference.projectId !== context.projectId) {
        throw new FormulaValidationError("FORMULA_CROSS_PROJECT_REFERENCE", path, {
          metricKey: node.metricKey,
        });
      }
      if (!reference.entityScopes.includes(context.outputScope)) {
        throw new FormulaValidationError("FORMULA_SCOPE_INCOMPATIBLE", path, {
          metricKey: node.metricKey,
          outputScope: context.outputScope,
        });
      }
      if (!reference.timeGranularities.includes(context.outputGranularity)) {
        throw new FormulaValidationError("FORMULA_GRANULARITY_INCOMPATIBLE", path, {
          metricKey: node.metricKey,
          outputGranularity: context.outputGranularity,
        });
      }
      return {
        unit: reference.unit,
        nodeCount: 1,
        depth: 1,
        dependencies: new Set([node.metricKey]),
        minimumSample: reference.minimumSample,
      };
    }
    if (node.type === "binary") {
      const left = infer(node.left, `${path}.left`);
      const right = infer(node.right, `${path}.right`);
      let unit: string;
      if (node.operator === "+" || node.operator === "-") {
        if (left.unit !== right.unit) {
          throw new FormulaValidationError("FORMULA_UNIT_INCOMPATIBLE", path, {
            left: left.unit,
            right: right.unit,
            operator: node.operator,
          });
        }
        unit = left.unit;
      } else if (node.operator === "*") {
        if (left.unit === "scalar") unit = right.unit;
        else if (right.unit === "scalar") unit = left.unit;
        else {
          throw new FormulaValidationError("FORMULA_UNIT_INCOMPATIBLE", path, {
            left: left.unit,
            right: right.unit,
            operator: node.operator,
          });
        }
      } else if (right.unit === "scalar") unit = left.unit;
      else if (left.unit === right.unit) unit = "ratio";
      else {
        const approved = APPROVED_DIVISION_UNITS[`${left.unit}/${right.unit}`];
        if (!approved) {
          throw new FormulaValidationError("FORMULA_UNIT_INCOMPATIBLE", path, {
            left: left.unit,
            right: right.unit,
            operator: node.operator,
          });
        }
        unit = approved;
      }
      return {
        unit,
        nodeCount: 1 + left.nodeCount + right.nodeCount,
        depth: 1 + Math.max(left.depth, right.depth),
        dependencies: combineSets(left.dependencies, right.dependencies),
        minimumSample: Math.max(left.minimumSample, right.minimumSample),
      };
    }
    if (node.type === "call") {
      const children = node.arguments.map((item, index) =>
        infer(item, `${path}.arguments[${index}]`),
      );
      const unit = children[0]!.unit;
      if (node.function === "clamp") {
        if (
          children
            .slice(1)
            .some((child) => child.unit !== "scalar" || child.dependencies.size > 0)
        ) {
          throw new FormulaValidationError("FORMULA_CLAMP_BOUND_NOT_LITERAL", path);
        }
      } else if (children.some((child) => child.unit !== unit)) {
        throw new FormulaValidationError("FORMULA_UNIT_INCOMPATIBLE", path);
      }
      return mergeChildren(unit, children);
    }
    if (node.type === "weighted_mean") {
      const children = node.items.map((item, index) =>
        infer(item.value, `${path}.items[${index}].value`),
      );
      const unit = children[0]!.unit;
      if (children.some((child) => child.unit !== unit)) {
        throw new FormulaValidationError("FORMULA_UNIT_INCOMPATIBLE", path);
      }
      return mergeChildren(unit, children);
    }
    const child = infer(node.input, `${path}.input`);
    return {
      ...child,
      unit: "score",
      nodeCount: child.nodeCount + 1,
      depth: child.depth + 1,
    };
  };
  const inferred = infer(ast, "$");
  if (inferred.dependencies.size === 0) {
    throw new FormulaValidationError("FORMULA_INPUT_REQUIRED", "$");
  }
  if (inferred.dependencies.size > FORMULA_LIMITS.maximumInputs) {
    throw new FormulaValidationError("FORMULA_INPUT_LIMIT_EXCEEDED", "$", {
      maximum: FORMULA_LIMITS.maximumInputs,
    });
  }
  if (inferred.unit !== context.outputUnit) {
    throw new FormulaValidationError("FORMULA_OUTPUT_UNIT_MISMATCH", "$", {
      inferred: inferred.unit,
      declared: context.outputUnit,
    });
  }
  if (context.minimumSample < inferred.minimumSample) {
    throw new FormulaValidationError("FORMULA_MINIMUM_SAMPLE_TOO_LOW", "$", {
      required: inferred.minimumSample,
      declared: context.minimumSample,
    });
  }
  return Object.freeze({
    ast,
    unit: inferred.unit,
    dependencies: Object.freeze([...inferred.dependencies].sort()),
    nodeCount: inferred.nodeCount,
    depth: inferred.depth,
    minimumSample: inferred.minimumSample,
  });
}

function mergeChildren(unit: string, children: readonly InferredNode[]): InferredNode {
  return {
    unit,
    nodeCount: 1 + children.reduce((sum, child) => sum + child.nodeCount, 0),
    depth: 1 + Math.max(...children.map((child) => child.depth)),
    dependencies: new Set(children.flatMap((child) => [...child.dependencies])),
    minimumSample: Math.max(...children.map((child) => child.minimumSample)),
  };
}

const statusPriority: Readonly<
  Record<Exclude<FormulaInputStatus, "available">, number>
> = {
  data_delayed: 4,
  insufficient_sample: 3,
  missing: 2,
  metric_not_available: 1,
};

function unavailableResult(
  values: readonly FormulaEvaluationResult[],
): FormulaEvaluationResult | null {
  const unavailable = values
    .filter(
      (
        item,
      ): item is FormulaEvaluationResult & {
        status: Exclude<FormulaInputStatus, "available">;
      } => item.status !== "available",
    )
    .sort((a, b) => statusPriority[b.status] - statusPriority[a.status])[0];
  return unavailable
    ? {
        value: null,
        status: unavailable.status,
        sampleSize: unavailable.sampleSize,
        reason: unavailable.reason,
      }
    : null;
}

/** The sole authoritative formula evaluator; it never executes source text, SQL or code. */
export function evaluateFormula(
  input: FormulaAst | unknown,
  values: Readonly<Record<string, FormulaInputValue>>,
): FormulaEvaluationResult {
  const ast = parseFormulaAst(input);
  const evaluate = (node: FormulaAst): FormulaEvaluationResult => {
    if (node.type === "literal") {
      return { value: node.value, status: "available", sampleSize: null, reason: null };
    }
    if (node.type === "metric") {
      const value = values[node.metricKey];
      if (!value)
        return {
          value: null,
          status: "missing",
          sampleSize: null,
          reason: "FORMULA_INPUT_MISSING",
        };
      if (value.status !== "available" || value.value === null) {
        return {
          value: null,
          status: value.status === "available" ? "missing" : value.status,
          sampleSize: value.sampleSize,
          reason: value.reason ?? `FORMULA_INPUT_${value.status.toUpperCase()}`,
        };
      }
      return {
        value: value.value,
        status: "available",
        sampleSize: value.sampleSize,
        reason: null,
      };
    }
    if (node.type === "binary") {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      const unavailable = unavailableResult([left, right]);
      if (unavailable) return unavailable;
      if (node.operator === "/" && right.value === 0) {
        return {
          value: null,
          status: "metric_not_available",
          sampleSize: minimumSample([left, right]),
          reason: "FORMULA_DIVISOR_ZERO",
        };
      }
      const value =
        node.operator === "+"
          ? left.value! + right.value!
          : node.operator === "-"
            ? left.value! - right.value!
            : node.operator === "*"
              ? left.value! * right.value!
              : left.value! / right.value!;
      return {
        value,
        status: "available",
        sampleSize: minimumSample([left, right]),
        reason: null,
      };
    }
    if (node.type === "call") {
      const items = node.arguments.map(evaluate);
      const unavailable = unavailableResult(items);
      if (unavailable) return unavailable;
      const numbers = items.map((item) => item.value!);
      const value =
        node.function === "min"
          ? Math.min(...numbers)
          : node.function === "max"
            ? Math.max(...numbers)
            : Math.min(numbers[2]!, Math.max(numbers[1]!, numbers[0]!));
      return {
        value,
        status: "available",
        sampleSize: minimumSample(items),
        reason: null,
      };
    }
    if (node.type === "weighted_mean") {
      const evaluated = node.items.map((item) => ({
        value: evaluate(item.value),
        weight: item.weight,
      }));
      const unavailable = unavailableResult(evaluated.map((item) => item.value));
      if (unavailable) return unavailable;
      const totalWeight = evaluated.reduce((sum, item) => sum + item.weight, 0);
      const value =
        evaluated.reduce((sum, item) => sum + item.value.value! * item.weight, 0) /
        totalWeight;
      return {
        value,
        status: "available",
        sampleSize: minimumSample(evaluated.map((item) => item.value)),
        reason: null,
      };
    }
    const evaluated = evaluate(node.input);
    if (evaluated.status !== "available") return evaluated;
    return {
      ...evaluated,
      value: normalize(evaluated.value!, node.direction, node.target),
    };
  };
  return evaluate(ast);
}

function minimumSample(values: readonly FormulaEvaluationResult[]): number | null {
  const samples = values.flatMap((item) =>
    item.sampleSize === null ? [] : [item.sampleSize],
  );
  return samples.length ? Math.min(...samples) : null;
}

function normalize(
  value: number,
  direction: NormalizeDirection,
  target: Readonly<Record<string, number>>,
): number {
  let result: number;
  if (direction === "higher_better") {
    result = (100 * (value - target.floor!)) / (target.target! - target.floor!);
  } else if (direction === "lower_better") {
    result = (100 * (target.ceiling! - value)) / (target.ceiling! - target.target!);
  } else if (value >= target.targetMin! && value <= target.targetMax!) {
    result = 100;
  } else if (value < target.targetMin!) {
    result =
      (100 * (value - target.toleranceMin!)) /
      (target.targetMin! - target.toleranceMin!);
  } else {
    result =
      (100 * (target.toleranceMax! - value)) /
      (target.toleranceMax! - target.targetMax!);
  }
  return Math.min(100, Math.max(0, result));
}

export interface FormulaTrendBucket {
  readonly bucket: string;
  readonly inputs: Readonly<Record<string, FormulaInputValue>>;
}

export function evaluateFormulaTrend(
  ast: FormulaAst | unknown,
  buckets: readonly FormulaTrendBucket[],
): readonly (FormulaEvaluationResult & { readonly bucket: string })[] {
  const parsed = parseFormulaAst(ast);
  return buckets.map((bucket) =>
    Object.freeze({ bucket: bucket.bucket, ...evaluateFormula(parsed, bucket.inputs) }),
  );
}

export interface FormulaGraphDefinition {
  readonly metricKey: string;
  readonly projectId: string;
  readonly formulaAst: FormulaAst | null;
}

export function topologicalSortFormulaGraph(
  definitions: readonly FormulaGraphDefinition[],
  projectId: string,
): readonly string[] {
  const byKey = new Map(definitions.map((item) => [item.metricKey, item]));
  const dependencyMap = new Map<string, readonly string[]>();
  for (const item of definitions) {
    if (item.projectId !== projectId) continue;
    const dependencies = item.formulaAst
      ? collectFormulaDependencies(item.formulaAst)
      : [];
    for (const key of dependencies) {
      const dependency = byKey.get(key);
      if (!dependency) {
        throw new FormulaValidationError("FORMULA_DEPENDENCY_MISSING", item.metricKey, {
          metricKey: key,
        });
      }
      if (dependency.projectId !== projectId) {
        throw new FormulaValidationError(
          "FORMULA_CROSS_PROJECT_REFERENCE",
          item.metricKey,
          { metricKey: key },
        );
      }
    }
    dependencyMap.set(item.metricKey, dependencies);
  }
  const result: string[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const visit = (key: string, path: readonly string[]): void => {
    if (state.get(key) === "visiting") {
      throw new FormulaValidationError("FORMULA_DEPENDENCY_CYCLE", key, {
        cycle: [...path, key],
      });
    }
    if (state.get(key) === "visited") return;
    state.set(key, "visiting");
    for (const dependency of dependencyMap.get(key) ?? [])
      visit(dependency, [...path, key]);
    state.set(key, "visited");
    result.push(key);
  };
  for (const key of dependencyMap.keys()) visit(key, []);
  return Object.freeze(result);
}

export function collectFormulaDependencies(ast: FormulaAst): readonly string[] {
  const keys = new Set<string>();
  const visit = (node: FormulaAst): void => {
    if (node.type === "metric") keys.add(node.metricKey);
    else if (node.type === "binary") {
      visit(node.left);
      visit(node.right);
    } else if (node.type === "call") node.arguments.forEach(visit);
    else if (node.type === "weighted_mean")
      node.items.forEach((item) => visit(item.value));
    else if (node.type === "normalize") visit(node.input);
  };
  visit(ast);
  return Object.freeze([...keys].sort());
}
