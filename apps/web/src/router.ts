import { CANONICAL_ROUTES } from "@frontend-insight/event-contract/canonical";
import { createRouter, createWebHistory } from "vue-router";
import { auth } from "./auth";
import { api, ApiError } from "./api";
import { projects } from "./projects";
import type { Project } from "./types";
import AppShell from "./components/AppShell.vue";
import LoginView from "./views/LoginView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    {
      path: CANONICAL_ROUTES.projects,
      name: "projects",
      component: () => import("./views/ProjectsView.vue"),
    },
    {
      path: "/projects/:projectId/access-error",
      name: "project-access-error",
      component: () => import("./views/ProjectAccessView.vue"),
    },
    {
      path: "/projects/:projectId",
      component: AppShell,
      children: [
        {
          path: "",
          redirect: (to) => ({
            name: "project-overview",
            params: to.params,
            query: to.query,
          }),
        },
        {
          path: "overview",
          name: "project-overview",
          component: () => import("./views/ProjectOverviewView.vue"),
        },
        {
          path: "metrics",
          name: "project-metrics",
          component: () => import("./views/MetricsView.vue"),
        },
        {
          path: "business",
          name: "project-business",
          component: () => import("./views/BusinessAnalysisView.vue"),
          meta: { requiresAuth: true },
        },
        {
          path: "pages",
          name: "project-pages",
          component: () => import("./views/PageAnalysisView.vue"),
        },
        {
          path: "settings",
          name: "project-settings",
          component: () => import("./views/SettingsView.vue"),
        },
      ],
    },
    { path: "/", redirect: { name: "projects" } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

let navigationGeneration = 0;
router.beforeEach(async (to) => {
  const generation = ++navigationGeneration;
  await auth.initialize();
  if (generation !== navigationGeneration) return false;
  if (to.name !== "login" && !auth.isAuthenticated.value) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login" && auth.isAuthenticated.value) return { name: "projects" };
  if (to.name !== "project-access-error") {
    const projectId =
      typeof to.params.projectId === "string"
        ? to.params.projectId
        : typeof to.query.project === "string"
          ? to.query.project
          : null;
    if (projectId) {
      try {
        const project = await api.request<Project>(
          "/api/projects/" + encodeURIComponent(projectId) + "/access",
        );
        if (generation !== navigationGeneration) return false;
        projects.remember(project);
      } catch (error) {
        if (generation !== navigationGeneration) return false;
        return {
          name: "project-access-error",
          params: { projectId },
          query: {
            retry: to.fullPath,
            kind:
              error instanceof ApiError && error.status === 403 ? "forbidden" : "error",
          },
        };
      }
    }
  }
  return true;
});
