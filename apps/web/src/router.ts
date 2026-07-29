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
        { path: "", redirect: { name: "features" } },
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
          path: "pages",
          name: "pages",
          component: () => import("./views/PagesView.vue"),
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

router.beforeEach(async (to) => {
  await auth.initialize();
  if (to.name !== "login" && !auth.isAuthenticated.value) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login" && auth.isAuthenticated.value) return { name: "features" };
  return true;
});
