import type {
  MetricLibraryDefinition,
  MetricLibraryVersion,
} from "./metric-library.js";
import { validateScoreConfiguration, type ScoreBinding } from "./score-evaluation.js";

/** Checks an unsaved configuration against a real version snapshot. No fact inputs. */
export function preflightScoreConfiguration(
  configuration: unknown,
  snapshot: {
    version: MetricLibraryVersion;
    definitions: readonly MetricLibraryDefinition[];
  },
) {
  const binding: ScoreBinding = {
    projectId: snapshot.version.projectId,
    libraryType: snapshot.version.libraryType,
    metricSetVersion: snapshot.version.id,
    definitionVersion: "unsaved",
    metrics: snapshot.definitions.map((metric) => ({
      metricKey: metric.metricKey,
      projectId: snapshot.version.projectId,
      libraryType: snapshot.version.libraryType,
      metricSetVersion: snapshot.version.id,
      definitionVersion: metric.definitionVersion,
      unit: metric.unit,
      entityScopes: metric.entityScopes,
      timeGranularities: metric.timeGranularities,
      minimumSample: metric.minimumSample,
      implementationStatus: metric.implementationStatus,
      formulaAst: metric.formulaAst,
      enabled: metric.enabled,
    })),
  };
  const validation = validateScoreConfiguration(configuration, binding);
  return {
    valid: true,
    metricSetVersion: snapshot.version.id,
    libraryType: snapshot.version.libraryType,
    configuration: validation.configuration,
    dependencies: validation.dependencies,
    readiness: validation.readiness,
    value: null,
    status: "unavailable" as const,
    reason: "SCORE_PREFLIGHT_CONFIGURATION_ONLY",
    saved: false,
  };
}
