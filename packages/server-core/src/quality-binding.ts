import {
  collectFormulaDependencies,
  evaluateFormula,
  type FormulaInputValue,
} from "./formula.js";
import { QUALITY_DEFINITION_VERSION, type QualityFactStore } from "./quality-facts.js";
import type { MetricLibraryService } from "./metric-library.js";
/** A caller-selected immutable snapshot controls semantics; new collectors never relabel old definitions. */
export function bindQualityFacts(
  result: Pick<Awaited<ReturnType<QualityFactStore["read"]>>, "inputs" | "from" | "to">,
  snapshot: Awaited<ReturnType<MetricLibraryService["getVersion"]>>,
) {
  if (snapshot.version.libraryType !== "quality")
    throw new Error("QUALITY_LIBRARY_REQUIRED");
  const definitions = new Map(snapshot.definitions.map((d) => [d.metricKey, d]));
  const inputs: Record<string, FormulaInputValue> = {};
  const visiting = new Set<string>();
  function evaluate(key: string): FormulaInputValue {
    if (inputs[key]) return inputs[key]!;
    const d = definitions.get(key);
    if (!d || !d.enabled)
      return {
        value: null,
        status: "metric_not_available",
        sampleSize: null,
        reason: "VERSION_METRIC_DISABLED_OR_MISSING",
      };
    if (visiting.has(key)) throw new Error("QUALITY_FORMULA_CYCLE");
    visiting.add(key);
    let value: FormulaInputValue;
    if (d.origin === "system")
      value =
        d.definitionVersion === QUALITY_DEFINITION_VERSION
          ? (result.inputs[key] ?? {
              value: null,
              status: "metric_not_available",
              sampleSize: null,
              reason: "QUALITY_SOURCE_MISSING",
            })
          : {
              value: null,
              status: "metric_not_available",
              sampleSize: null,
              reason: "QUALITY_DEFINITION_UPGRADE_REQUIRED",
            };
    else if (d.formulaAst) {
      for (const dep of collectFormulaDependencies(d.formulaAst))
        inputs[dep] = evaluate(dep);
      value = evaluateFormula(d.formulaAst, inputs);
    } else
      value = {
        value: null,
        status: "metric_not_available",
        sampleSize: null,
        reason: "FORMULA_MISSING",
      };
    if (value.status === "available" && (value.sampleSize ?? 0) < d.minimumSample)
      value = {
        ...value,
        value: null,
        status: "insufficient_sample",
        reason: "INSUFFICIENT_SAMPLE",
      };
    if (
      snapshot.version.status === "active" &&
      (!snapshot.version.activatedAt || result.from < snapshot.version.activatedAt)
    )
      value = {
        ...value,
        value: null,
        status: "metric_not_available",
        reason: "VERSION_RANGE_BOUNDARY",
      };
    visiting.delete(key);
    inputs[key] = value;
    return value;
  }
  for (const d of snapshot.definitions) evaluate(d.metricKey);
  return {
    versionId: snapshot.version.id,
    versionStatus: snapshot.version.status,
    mode: snapshot.version.status === "active" ? "current" : "preview",
    inputs,
  };
}
