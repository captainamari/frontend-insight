import { computed } from "vue";
import { useRoute } from "vue-router";
import { projects } from "./projects";

export function useDashboardContext() {
  const route = useRoute();
  const projectId = computed(() =>
    typeof route.params.projectId === "string" ? route.params.projectId : null,
  );
  const project = computed(() => projects.find(projectId.value));
  return { projectId, project };
}
