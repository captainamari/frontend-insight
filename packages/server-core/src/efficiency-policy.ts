import { R4C_FACT_DEFINITION_VERSION } from "./system-metric-catalog.js";
/** C01/C02 approved 2026-09-29. Structured observations never become scalar score inputs. */
export interface FormCounters {
  formId: string;
  changes: number;
  resets: number;
  submits: number;
  validationFailures: number;
  lifecycles: number;
  noSubmit: number;
  overflow: number;
  submittedChanges: number;
  submittedResets: number;
  submittedValidationFailures: number;
}
export interface BusinessResultCounters {
  started: number;
  success: number;
  rejected: number;
  technical_failure: number;
  canceled: number;
  unknown: number;
  unresolved: number;
}
export function approvedEfficiencyResults(
  forms: FormCounters[],
  operations: BusinessResultCounters,
  excluded: number,
  sourceCoverage = { forms: false, operations: false },
) {
  const results = forms.map((f) => {
    const reason = f.overflow
      ? "FORM_COUNTER_OVERFLOW"
      : !f.submits
        ? "ZERO_DENOMINATOR"
        : f.submits < 5
          ? "INSUFFICIENT_SAMPLE"
          : excluded
            ? "EXCLUDED_OR_CONFLICTING_FACTS"
            : null;
    return {
      formId: f.formId,
      sampleSize: f.submits,
      denominator: f.submits,
      numerators: {
        changes: f.submittedChanges,
        resets: f.submittedResets,
        validationFailures: f.submittedValidationFailures,
      },
      definitionVersion: R4C_FACT_DEFINITION_VERSION,
      coverage: sourceCoverage.forms ? "controlled_unsampled_settlements" : "unknown",
      excludedNoSubmitLifecycles: f.noSubmit,
      status: reason ? "unavailable" : "observed",
      reason,
      // Ratios, not percent-points. In particular resets/submits is not clamped.
      changesPerSubmit: reason ? null : f.submittedChanges / f.submits,
      resetRate: reason ? null : f.submittedResets / f.submits,
      validationErrorRate: reason ? null : f.submittedValidationFailures / f.submits,
    };
  });
  const operationReason = !operations.started
    ? "BUSINESS_ADAPTER_NOT_OBSERVED"
    : operations.unresolved || excluded
      ? "EXCLUDED_OR_CONFLICTING_FACTS"
      : operations.unknown
        ? "BUSINESS_RESULT_UNKNOWN"
        : operations.started < 5
          ? "INSUFFICIENT_SAMPLE"
          : null;
  return {
    form_efficiency: {
      value:
        sourceCoverage.forms && results.length && results.every((r) => !r.reason)
          ? results.map((r) => ({
              formId: r.formId,
              changesPerSubmit: r.changesPerSubmit,
              resetRate: r.resetRate,
              validationErrorRate: r.validationErrorRate,
            }))
          : null,
      status:
        sourceCoverage.forms && results.length && results.every((r) => !r.reason)
          ? "available"
          : forms.length
            ? "partial"
            : "not_collected",
      reason:
        sourceCoverage.forms && results.length && results.every((r) => !r.reason)
          ? null
          : forms.length
            ? !sourceCoverage.forms
              ? "FORM_COVERAGE_NOT_VERIFIED"
              : (results.find((r) => r.reason)?.reason ?? "FORM_COVERAGE_NOT_VERIFIED")
            : "FORM_COLLECTOR_NOT_OBSERVED",
      observations: forms,
      results,
      cohort: "lifecycle_settlement_time",
      minimumSample: 5,
    },
    operation_fail_rate: {
      value:
        !operationReason && sourceCoverage.operations
          ? operations.rejected / operations.started
          : null,
      observedValue: operationReason ? null : operations.rejected / operations.started,
      status:
        !operationReason && sourceCoverage.operations
          ? "available"
          : operations.started
            ? "partial"
            : "not_collected",
      reason:
        operationReason ??
        (sourceCoverage.operations ? null : "BUSINESS_ADAPTER_COVERAGE_NOT_VERIFIED"),
      observations: operations,
      numerator: operations.rejected,
      denominator: operations.started,
      sampleSize: operations.started,
      unit: "ratio",
      coverage: sourceCoverage.operations
        ? "controlled_unsampled_operations"
        : "unknown",
      definitionVersion: R4C_FACT_DEFINITION_VERSION,
      minimumSample: 5,
      cohort: "operation_start_time; terminal_received_by_asOf",
    },
  };
}
