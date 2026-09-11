import { CANONICAL_ROUTES } from "@frontend-insight/event-contract";
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
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: { name: "projects" } },
        {
          path: "features",
          name: "features",
          component: () => import("./views/FeaturesView.vue"),
        },
        {
          path: "features/:featureId",
          name: "feature-detail",
          component: () => import("./views/FeatureDetailView.vue"),
        },
        {
          path: "operational",
          name: "operational-overview",
          component: () => import("./views/OperationalOverviewView.vue"),
        },
        {
          path: "pages",
          name: "pages",
          component: () => import("./views/PagesView.vue"),
        },
        {
          path: "page-detail",
          name: "page-detail",
          component: () => import("./views/PageDetailView.vue"),
        },
        {
          path: "observability",
          name: "observability",
          component: () => import("./views/ObservabilityView.vue"),
        },
        {
          path: "operational-config",
          name: "operational-config",
          component: () => import("./views/OperationalConfigView.vue"),
        },
        {
          path: "projects/:projectId/metrics",
          name: "project-metrics",
          component: () => import("./views/MetricsView.vue"),
        },
        {
          path: "onboarding",
          name: "onboarding",
          component: () => import("./views/OnboardingView.vue"),
        },
      ],
    },
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
            kind:
              error instanceof ApiError && error.status === 403 ? "forbidden" : "error",
          },
        };
      }
    }
  }
  return true;
});
