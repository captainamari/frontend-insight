import { expect, test, type Locator, type Page } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
}

async function choose(page: Page, select: Locator, option: string): Promise<void> {
  await select.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("admin manages a controlled business metric while system definitions stay read-only", async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  await page.goto(`/projects/${projectId}/metrics?range=7d&tab=operational-metrics`);

  await expect(page.getByRole("heading", { name: "系统默认指标" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "用户业务指标" })).toBeVisible();
  const systemTable = page.getByTestId("system-metrics");
  await expect(systemTable.getByText("pv", { exact: true })).toBeVisible();
  await expect(systemTable.getByText("uv", { exact: true })).toBeVisible();
  await expect(systemTable.getByText("未采集", { exact: true }).first()).toBeVisible();

  const pvRow = systemTable
    .getByRole("row")
    .filter({ has: page.getByText("pv", { exact: true }) });
  await pvRow.getByRole("button", { name: "定义" }).click();
  const definitionDrawer = page.getByRole("dialog", { name: "指标定义" });
  await expect(definitionDrawer).toContainText("formulaDescription");
  await expect(definitionDrawer).toContainText("eventId");
  await page.keyboard.press("Escape");

  const suffix = `${browserName}_${Date.now()}`;
  const metricKey = `pages_per_visit_${suffix}`;
  await page.getByRole("button", { name: "新建业务指标" }).click();
  const editor = page.getByRole("dialog", { name: "语义化业务指标编辑器" });
  await expect(editor).toContainText("不会保存 SQL、代码、任意字段或任意函数");
  await editor.getByLabel("指标 key").fill(metricKey);
  await editor.getByLabel("中文名").fill(`单会话页面数 ${suffix}`);
  await editor.getByLabel("业务说明").fill("页面浏览量除以会话数");
  await choose(page, editor.getByLabel("输入指标 A"), "pv · 页面浏览量 · 部分实现");
  await choose(page, editor.getByLabel("输入指标 B"), "vv · 会话数（VV）");
  await editor.getByLabel("目标单位").fill("views_per_session");
  await editor.getByLabel("分子说明").fill("PV");
  await editor.getByLabel("分母说明").fill("VV");
  await editor.getByRole("button", { name: "保存并由服务端校验" }).click();
  await expect(
    page.getByText("业务指标已保存；服务端校验结果已更新", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("business-metrics")).toContainText(metricKey);
  await expect(page.getByText("服务端权威校验通过", { exact: true })).toBeVisible();

  const businessRow = page
    .getByTestId("business-metrics")
    .getByRole("row")
    .filter({ hasText: metricKey });
  await businessRow.getByRole("button", { name: "血缘" }).click();
  const lineageDrawer = page.getByRole("dialog", { name: "指标血缘" });
  await expect(lineageDrawer).toContainText(metricKey);
  await expect(lineageDrawer).toContainText("pv");
  await expect(lineageDrawer).toContainText("vv");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "版本库", exact: true }).click();
  await expect(page).toHaveURL(/tab=versions/);
  await expect(page.getByRole("heading", { name: "版本库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "服务端校验" })).toBeVisible();
  await page.getByRole("button", { name: "查看 diff / 影响" }).click();
  await expect(page.getByText(/^Diff /)).toBeVisible();
  await expect(page.getByText(/^影响范围 /)).toBeVisible();
});

test("viewer can inspect definitions, versions and lineage but has no writes", async ({
  page,
}) => {
  await login(page, "viewer@example.invalid", "LocalViewer-1234");
  await page.goto(`/projects/${projectId}/metrics?range=7d&tab=quality-metrics`);
  await expect(page.getByText(/当前账号为 viewer/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "系统默认指标" })).toBeVisible();
  await expect(page.getByTestId("system-metrics")).toContainText("lcp");
  await expect(page.getByRole("button", { name: "复制为草稿" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建业务指标" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "激活", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "废弃草稿" })).toHaveCount(0);

  const metricRow = page
    .getByTestId("system-metrics")
    .getByRole("row")
    .filter({ has: page.getByText("lcp", { exact: true }) });
  await metricRow.getByRole("button", { name: "定义" }).click();
  await expect(page.getByRole("dialog", { name: "指标定义" })).toContainText("R5-A");
});
