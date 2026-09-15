import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";
import {
  CANONICAL_RANGES,
  CANONICAL_ENVIRONMENTS,
} from "@frontend-insight/event-contract/canonical";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { projects } from "./projects";
import { buildRangeQuery, isRangePreset, rangeSearch } from "./range";
import type { RangePreset } from "./types";

export function useDashboardContext() {
  const route = useRoute();
  const projectId = computed(() => {
    if (typeof route.params.projectId === "string") return route.params.projectId;
    return typeof route.query.project === "string" ? route.query.project : null;
  });
  const project = computed(() => projects.find(projectId.value));
  const preset = computed<RangePreset>(() =>
    isRangePreset(route.query.range) ? route.query.range : "7d",
  );
  const range = computed(() =>
    project.value
      ? route.params.projectId &&
        typeof route.query.from === "string" &&
        typeof route.query.to === "string"
        ? (() => {
            try {
              const q = resolveProjectCalendar(
                {
                  range:
                    CANONICAL_RANGES.find((r) => r.key === route.query.range)?.key ??
                    "custom",
                  env:
                    CANONICAL_ENVIRONMENTS.find((e) => e === route.query.env) ?? "prod",
                  from: route.query.from,
                  to: route.query.to,
                },
                project.value!.timezone,
              );
              return { ...q, granularity: "day" as const };
            } catch {
              return null;
            }
          })()
        : buildRangeQuery(preset.value, project.value.timezone)
      : null,
  );
  const search = computed(() => (range.value ? rangeSearch(range.value) : ""));
  return { projectId, project, preset, range, search };
}
