import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const project = "11111111-1111-4111-8111-111111111111";
const modules = [
  ["overview", "项目概览"],
  ["business", "业务分析"],
  ["pages", "页面分析"],
  ["metrics", "指标管理"],
  ["settings", "设置"],
] as const;
for (const role of ["admin", "viewer"] as const) {
  test(`${role}: unique formal navigation, deep link, refresh, back and retired API`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(180000);
    const q = "env=prod&range=30d";
    await page.goto(`/projects/${project}/pages?${q}&tab=operations`);
    await expect(page).toHaveURL(/login/);
    await page.getByLabel("邮箱").fill(`${role}@example.invalid`);
    await page
      .getByLabel("密码")
      .fill(role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/pages`));
    for (const [key, label] of modules) {
      await page
        .getByRole("navigation", { name: "项目导航" })
        .getByRole("button", { name: label, exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`/projects/${project}/${key}\\?`));
      expect(new URL(page.url()).searchParams.get("env")).toBe("prod");
      expect(new URL(page.url()).searchParams.get("range")).toBe("30d");
      await expect(
        page.getByRole("navigation", { name: "项目导航" }).getByRole("button"),
      ).toHaveCount(5);
      await page.reload();
      await expect(
        page
          .getByRole("navigation", { name: "项目导航" })
          .getByRole("button", { name: label, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
    await page
      .getByRole("navigation", { name: "项目导航" })
      .getByRole("button", { name: "页面分析", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/pages\\?`));
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\?/);
    await page.getByRole("button", { name: "返回全部项目", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\?/);
    for (const path of [
      "/features",
      "/features/retired",
      "/operational",
      "/pages",
      "/page-detail",
      "/observability",
      "/operational-config",
      "/onboarding",
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/projects(?:\?|$)/);
    }
    const login = await request.post("/api/auth/login", {
      data: {
        email: `${role}@example.invalid`,
        password: role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234",
      },
    });
    const headers = { authorization: `Bearer ${(await login.json()).accessToken}` };
    for (const suffix of [
      "analytics/overview",
      "analytics/pages",
      "analytics/modules",
      "analytics/page-detail",
      "onboarding/status",
      "observability/overview",
      "observability/errors",
    ]) {
      expect(
        (await request.get(`/api/projects/${project}/${suffix}`, { headers })).status(),
      ).toBe(404);
    }
    if (role === "viewer")
      expect(
        (
          await request.post(`/api/projects/${project}/modules`, {
            headers,
            data: { moduleKey: "forbidden", name: "forbidden" },
          })
        ).status(),
      ).toBe(403);
    if (role === "viewer") {
      mkdirSync("artifacts", { recursive: true });
      writeFileSync(
        `artifacts/r8-${info.project.name}.json`,
        JSON.stringify(
          {
            testedCommit: process.env.GITHUB_SHA,
            browser: info.project.name,
            roles: ["admin", "viewer"],
            modules: 6,
            retiredApi: "404",
            deepLink: true,
            refresh: true,
            back: true,
            manualAcceptance: false,
          },
          null,
          2,
        ),
      );
    }
  });
}
