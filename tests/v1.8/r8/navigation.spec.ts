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

test("leaving business cancels its pending default-selection read before access resolves", async ({
  page,
}) => {
  test.setTimeout(60000);
  const query = new URLSearchParams({
    env: "prod",
    range: "30d",
    from: new Date(Date.now() - 29 * 86400000).toISOString(),
    to: new Date().toISOString(),
  });
  await page.goto(`/projects/${project}/settings?${query}`);
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?/);
  let releaseBusiness!: () => void, releaseAccess!: () => void;
  let businessReady = false,
    accessReady = false;
  const businessGate = new Promise<void>((resolve) => {
    releaseBusiness = resolve;
  });
  const accessGate = new Promise<void>((resolve) => {
    releaseAccess = resolve;
  });
  let armAccess = false,
    canceled = false;
  page.on("requestfailed", (request) => {
    if (request.url().includes(`/api/projects/${project}/business?`)) canceled = true;
  });
  // Delay real responses only. No fabricated business facts or authorization.
  await page.route(`**/api/projects/${project}/business?**`, async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect((await response.json()).moduleId).toBeTruthy();
    businessReady = true;
    await businessGate;
    await route.fulfill({ response }).catch((error) => {
      if (!canceled) throw error;
    });
  });
  await page.route(`**/api/projects/${project}/access`, async (route) => {
    if (armAccess) {
      const response = await route.fetch();
      accessReady = true;
      await accessGate;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  try {
    await test.step("hold the real default-module response during SPA entry", async () => {
      await page
        .getByRole("navigation", { name: "项目导航" })
        .getByRole("button", { name: "业务分析", exact: true })
        .click();
      await expect(page).toHaveURL(/\/business\?/);
      await expect
        .poll(() => businessReady, {
          timeout: 10000,
          message: "real business response reached the hold",
        })
        .toBe(true);
    });
    expect(canceled).toBe(false);
    armAccess = true;
    await page
      .getByRole("navigation", { name: "项目导航" })
      .getByRole("button", { name: "页面分析", exact: true })
      .click();
    await test.step("cancel old read while the real access response is still held", async () => {
      await expect
        .poll(() => accessReady, { message: "new navigation reached access guard" })
        .toBe(true);
      // Release the obsolete real response while authorization is still blocked.
      // Browser interception must not itself prevent the abort signal settling.
      releaseBusiness();
      await expect
        .poll(() => canceled, {
          message: "old business read aborted before authorization resolves",
        })
        .toBe(true);
    });
    releaseBusiness();
    releaseAccess();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/pages\\?`));
    await expect(
      page
        .getByRole("navigation", { name: "项目导航" })
        .getByRole("button", { name: "页面分析", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    releaseBusiness();
    releaseAccess();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
