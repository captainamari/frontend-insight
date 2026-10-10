import {
  collectFormulaDependencies,
  evaluateFormula,
  type FormulaInputValue,
} from "./formula.js";
import type { MetricLibraryDefinition } from "./metric-library.js";
import { PAGE_USAGE_DEFINITION } from "./page-usage.js";
export function bindPageUsage(
  definitions: readonly MetricLibraryDefinition[],
  keys: readonly string[],
  inputs: Record<string, FormulaInputValue>,
  boundary = false,
) {
  const values: Record<string, FormulaInputValue> = {};
  const visiting = new Set<string>();
  function read(key: string): FormulaInputValue {
    if (values[key]) return values[key]!;
    const d = definitions.find((d) => d.metricKey === key);
    const missing = (reason: string): FormulaInputValue => ({
      value: null,
      status: "metric_not_available",
      sampleSize: null,
      reason,
    });
    if (!d || !d.enabled || !d.entityScopes.includes("page"))
      return (values[key] = missing("PAGE_METRIC_DISABLED_OR_MISSING"));
    if (visiting.has(key)) return missing("FORMULA_CYCLE");
    visiting.add(key);
    let value: FormulaInputValue;
    if (d.origin === "system")
      value =
        d.definitionVersion === PAGE_USAGE_DEFINITION
          ? (inputs[key] ?? missing("PAGE_SOURCE_MISSING"))
          : missing("PAGE_DEFINITION_UPGRADE_REQUIRED");
    else if (d.formulaAst) {
      for (const dep of collectFormulaDependencies(d.formulaAst)) read(dep);
      value = evaluateFormula(d.formulaAst, values);
    } else value = missing("FORMULA_MISSING");
    if (boundary) value = missing("VERSION_RANGE_BOUNDARY");
    else if (value.status === "available" && (value.sampleSize ?? 0) < d.minimumSample)
      value = {
        ...value,
        value: null,
        status: "insufficient_sample",
        reason: "INSUFFICIENT_SAMPLE",
      };
    visiting.delete(key);
    return (values[key] = value);
  }
  return keys.map((key) => {
    const d = definitions.find((d) => d.metricKey === key);
    return {
      key,
      name: d?.displayName ?? key,
      unit: d?.unit ?? "",
      definitionVersion: d?.definitionVersion ?? null,
      ...read(key),
    };
  });
}
