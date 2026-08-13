import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.M5_WEB_URL ?? "http://127.0.0.1:4173";

async function login(page: Page, role: "admin" | "viewer" = "viewer"): Promise<void> {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("邮箱").fill(`${role}@example.invalid`);
  await page
    .getByLabel("密码")
    .fill(role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/projects(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "全部项目" })).toBeVisible();
}

async function enterFirstProject(page: Page): Promise<string> {
  const cards = page.getByRole("button", { name: /进入项目概览/ });
  await expect(cards.first()).toBeVisible();
  await cards.first().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview/);
  await expect(page.getByRole("heading", { name: /项目概览|智慧园区/ })).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

test("entry is always first and preserves its own URL state", async ({ page }) => {
  await login(page);
  await page.getByLabel("搜索项目").fill("智慧");
  await expect(page).toHaveURL(/q=/);
  const entryUrl = page.url();
  await enterFirstProject(page);
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await expect(page).toHaveURL(entryUrl);
  await expect(page.getByLabel("搜索项目")).toHaveValue("智慧");
});

test("project overview owns the index and exposes exactly four first-level modules", async ({
  page,
}) => {
  await login(page);
  await enterFirstProject(page);
  const navigation = page.getByRole("navigation", { name: "项目一级导航" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  for (const name of ["业务分析", "页面分析", "指标管理", "设置"]) {
    await expect(
      navigation.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  }
  for (const removed of ["功能采用", "项目运营指数", "前端可观测性"]) {
    await expect(
      navigation.getByRole("button", { name: new RegExp(`^${removed}`) }),
    ).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /项目运营指数/ })).toBeVisible();
});

test("all canonical modules and subdomains are deep-linkable", async ({ page }) => {
  await login(page);
  const projectId = await enterFirstProject(page);
  const navigation = page.getByRole("navigation", { name: "项目一级导航" });

  await navigation.getByRole("button", { name: /^业务分析/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/business-analysis`));
  await expect(page.getByRole("heading", { name: "业务分析" })).toBeVisible();

  await navigation.getByRole("button", { name: /^页面分析/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/page-analysis/usage`),
  );
  await expect(page.getByRole("heading", { name: "页面访问" })).toBeVisible();

  await navigation.getByRole("button", { name: /^指标管理/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/metrics/catalog`));
  await expect(page.getByRole("heading", { name: "指标管理" })).toBeVisible();

  await navigation.getByRole("button", { name: /^设置/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings`));
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
});

test("legacy top-level analysis routes cannot bypass entry and overview", async ({
  page,
}) => {
  await login(page);
  for (const route of [
    "/features",
    "/operational",
    "/pages",
    "/operational-index",
    "/observability",
    "/operational-config",
    "/onboarding",
  ]) {
    await page.goto(`${webUrl}${route}`);
    await expect(page).toHaveURL(/\/projects(?:\?|$)/);
  }
});

test("viewer can read metric definitions but cannot configure them", async ({
  page,
}) => {
  await login(page, "viewer");
  await enterFirstProject(page);
  await page
    .getByRole("navigation", { name: "项目一级导航" })
    .getByRole("button", { name: /^指标管理/ })
    .click();
  await expect(page.getByText(/当前为只读权限/)).toBeVisible();
  await expect(page.getByRole("button", { name: /管理 profile 与目标/ })).toHaveCount(
    0,
  );
  await expect(page.getByText(/SQL/i)).toHaveCount(0);
});
