import { createRouter, createWebHistory } from "vue-router";
import { auth } from "./auth";
import AppShell from "./components/AppShell.vue";
import LoginView from "./views/LoginView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    {
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: { name: "projects" } },
        {
          path: "projects",
          name: "projects",
          component: () => import("./views/ProjectsView.vue"),
        },
        {
          path: "projects/:projectId/overview",
          name: "project-overview",
          component: () => import("./views/ProjectOverviewView.vue"),
        },
        {
          path: "projects/:projectId/business-analysis/features",
          name: "business-features",
          component: () => import("./views/FeaturesView.vue"),
        },
        {
          path: "projects/:projectId/business-analysis/features/:featureId",
          name: "feature-detail",
          component: () => import("./views/FeatureDetailView.vue"),
        },
        {
          path: "projects/:projectId/business-analysis/:section(tasks|reuse|efficiency)?",
          name: "business-analysis",
          component: () => import("./views/OperationalOverviewView.vue"),
        },
        {
          path: "projects/:projectId/page-analysis/usage",
          name: "page-usage",
          component: () => import("./views/PagesView.vue"),
        },
        {
          path: "projects/:projectId/page-analysis/usage/detail",
          name: "page-detail",
          component: () => import("./views/PageDetailView.vue"),
        },
        {
          path: "projects/:projectId/overview/operational-index",
          name: "operational-index",
          component: () => import("./views/OperationalIndexView.vue"),
        },
        {
          path: "projects/:projectId/page-analysis/:section(performance|errors|releases)",
          name: "page-analysis",
          component: () => import("./views/ObservabilityView.vue"),
        },
        {
          path: "projects/:projectId/page-analysis",
          redirect: (to) => ({
            name: "page-usage",
            params: to.params,
            query: to.query,
          }),
        },
        {
          path: "projects/:projectId/metrics",
          name: "metrics",
          redirect: (to) => ({
            name: "metric-catalog",
            params: to.params,
            query: to.query,
          }),
        },
        {
          path: "projects/:projectId/metrics/:section(catalog|lineage)",
          name: "metric-catalog",
          component: () => import("./views/MetricManagementView.vue"),
        },
        {
          path: "projects/:projectId/metrics/:section(profiles|targets)",
          name: "metric-configuration",
          component: () => import("./views/OperationalConfigView.vue"),
        },
        {
          path: "projects/:projectId/settings/collectors",
          name: "collector-settings",
          component: () => import("./views/CollectorSettingsView.vue"),
        },
        {
          path: "projects/:projectId/settings/:section?",
          name: "settings",
          component: () => import("./views/OnboardingView.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  await auth.initialize();
  if (to.name !== "login" && !auth.isAuthenticated.value) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login" && auth.isAuthenticated.value) return { name: "projects" };
  return true;
});
