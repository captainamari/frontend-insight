import { expect, test, type Locator, type Page } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
}

async function openSelect(container: Locator, label: string): Promise<void> {
  await container
    .getByLabel(label)
    .locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')][1]")
    .click();
}

test("admin completes function module, page and workflow metadata in metric center", async ({
  page,
  browserName,
}) => {
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  await page.goto(
    `/projects/${projectId}/metrics?range=7d&tab=analysis-objects&object=modules`,
  );
  await expect(page.getByRole("heading", { name: "指标管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "功能模块" })).toBeVisible();

  const suffix = Date.now();
  const moduleKey = `r1a_module_${suffix}`;
  const moduleName = `R1-A 功能模块 ${suffix}`;
  const observedRoute = `/orders/${browserName}/${suffix}`;
  const normalizedRoute = `/orders/${browserName}/:id`;
  await page.getByRole("button", { name: "新建功能模块" }).click();
  const moduleDialog = page.getByRole("dialog", { name: "新建功能模块" });
  await moduleDialog.getByLabel("moduleKey").fill(moduleKey);
  await moduleDialog.getByLabel("功能模块名称").fill(moduleName);
  await moduleDialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("row").filter({ hasText: moduleKey })).toBeVisible();

  await page.getByRole("tab", { name: "页面" }).click();
  await page.getByRole("button", { name: "新建页面定义" }).click();
  const pageDialog = page.getByRole("dialog", { name: "新建页面定义" });
  await pageDialog.getByLabel("观测或模板 route").fill(observedRoute);
  await expect(pageDialog.getByText(`保存为：${normalizedRoute}`)).toBeVisible();
  await pageDialog.getByLabel("页面名称").fill(`订单详情 ${suffix}`);
  await openSelect(pageDialog, "所属功能模块");
  await page.getByRole("option", { name: moduleName }).click();
  await pageDialog.getByRole("button", { name: "创建" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: normalizedRoute }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "工作流" }).click();
  await page.getByRole("button", { name: "新建工作流" }).click();
  const workflowDialog = page.getByRole("dialog", { name: "新建工作流" });
  await workflowDialog.getByLabel("workflowKey").fill(`order_review_${suffix}`);
  await workflowDialog.getByLabel("工作流名称").fill(`订单审核 ${suffix}`);
  await openSelect(workflowDialog, "所属功能模块");
  await page.getByRole("option", { name: moduleName }).click();
  const firstStep = workflowDialog.locator(".workflow-editor-step").first();
  await openSelect(firstStep, "触发类型");
  await page.getByRole("option", { name: "稳定选择器适配器" }).click();
  await firstStep.getByLabel("选择器").fill(".review-button");
  await expect(workflowDialog.getByText(/普通 class 容易随样式变化/)).toBeVisible();
  await workflowDialog.getByRole("button", { name: "创建工作流" }).click();
  const workflowRow = page
    .getByRole("row")
    .filter({ hasText: `order_review_${suffix}` });
  await expect(workflowRow).toBeVisible();
  await workflowRow.getByRole("button", { name: "激活" }).click();
  await page
    .getByRole("dialog", { name: "激活工作流版本" })
    .getByRole("button", { name: "激活", exact: true })
    .click();
  await expect(workflowRow).toContainText("active");
});

test("viewer sees the same analysis objects but cannot write", async ({ page }) => {
  await login(page, "viewer@example.invalid", "LocalViewer-1234");
  await page.goto(
    `/projects/${projectId}/metrics?range=7d&tab=analysis-objects&object=modules`,
  );
  await expect(page.getByText("当前账号为只读权限")).toBeVisible();
  await expect(page.getByRole("button", { name: "新建功能模块" })).toHaveCount(0);
  await page.getByRole("tab", { name: "页面" }).click();
  await expect(page.getByRole("button", { name: "新建页面定义" })).toHaveCount(0);
  await page.getByRole("tab", { name: "工作流" }).click();
  await expect(page.getByRole("button", { name: "新建工作流" })).toHaveCount(0);

  const status = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/workflow-definitions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionStorage.getItem("fi.access-token")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    return response.status;
  }, projectId);
  expect(status).toBe(403);
});
