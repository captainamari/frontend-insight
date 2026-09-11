import { computed, reactive } from "vue";
import { api } from "./api";
import type { Project } from "./types";

const state = reactive<{
  items: Project[];
  loading: boolean;
  loaded: boolean;
}>({
  items: [],
  loading: false,
  loaded: false,
});

export const projects = {
  state,
  remember(project: Project): void {
    const index = state.items.findIndex((p) => p.id === project.id);
    if (index >= 0) state.items[index] = project;
    else state.items.push(project);
  },
  active: computed(() => state.items.filter((project) => project.status === "active")),
  async load(force = false): Promise<Project[]> {
    if (state.loaded && !force) return state.items;
    state.loading = true;
    try {
      state.items = await api.listProjects();
      state.loaded = true;
      return state.items;
    } finally {
      state.loading = false;
    }
  },
  async refresh(): Promise<Project[]> {
    return this.load(true);
  },
  reset(): void {
    state.items = [];
    state.loaded = false;
    state.loading = false;
  },
  find(projectId: string | null | undefined): Project | null {
    return state.items.find((project) => project.id === projectId) ?? null;
  },
};
