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

test("admin completes the R1-A lifecycle, master-detail and workflow UX", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  await page.goto(
    `/projects/${projectId}/metrics?range=7d&tab=analysis-objects&object=modules`,
  );
  await expect(page.getByRole("heading", { name: "指标管理" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "功能模块" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "页面" }).click();
  await expect(page).toHaveURL(/object=pages/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "页面定义" })).toBeVisible();
  await page.getByRole("tab", { name: "工作流" }).click();
  await expect(page).toHaveURL(/object=workflows/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "页面定义" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "工作流定义" })).toBeVisible();
  await page.getByRole("tab", { name: "功能模块" }).click();

  const suffix = `${browserName}_${Date.now()}`;
  const moduleKey = `r1a_module_${suffix}`;
  const moduleName = `R1-A 功能模块 ${suffix}`;
  const observedRoute = `/orders/${browserName}/${Date.now()}`;
  const normalizedRoute = `/orders/${browserName}/:id`;

  await page.getByRole("button", { name: "新建功能模块" }).click();
  const moduleDialog = page.getByRole("dialog", { name: "新建功能模块" });
  await expect(moduleDialog.getByText(/关键度/)).toHaveCount(0);
  await moduleDialog.getByLabel("moduleKey").fill(moduleKey);
  await moduleDialog.getByLabel("功能模块名称").fill(moduleName);
  await moduleDialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("功能模块已创建", { exact: true })).toBeVisible();
  const moduleRow = page.getByRole("row").filter({ hasText: moduleKey });
  await expect(moduleRow).toContainText(moduleName);

  await page.getByRole("button", { name: "新建功能模块" }).click();
  await moduleDialog.getByLabel("moduleKey").fill(moduleKey);
  await moduleDialog.getByLabel("功能模块名称").fill(`${moduleName} 重复`);
  await moduleDialog.getByRole("button", { name: "创建" }).click();
  await expect(
    page.getByText("创建失败：moduleKey 已存在，请使用唯一的 key。", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(moduleDialog).toBeVisible();
  await moduleDialog.getByRole("button", { name: "取消" }).click();

  await page.getByRole("tab", { name: "页面" }).click();
  await expect(page).toHaveURL(/object=pages/);
  await expect(page.getByRole("heading", { name: "页面定义" })).toBeVisible();
  await openSelect(page.locator(".page-master-controls"), "功能模块");
  await page.getByRole("option", { name: new RegExp(moduleName) }).click();
  await expect(page.getByText("未归类 route 临时入口")).toBeVisible();
  await expect(page.getByText("R6 交付后迁移到")).not.toBeVisible();

  await page.getByRole("button", { name: "新建页面定义" }).click();
  const pageDrawer = page.getByRole("dialog", { name: "新建页面定义" });
  await expect(
    pageDrawer.locator(".el-select__selected-item").filter({ hasText: moduleName }),
  ).toBeVisible();
  await pageDrawer.getByLabel("观测或模板 route").fill(observedRoute);
  await expect(pageDrawer.getByText(`保存为：${normalizedRoute}`)).toBeVisible();
  await pageDrawer.getByLabel("页面名称").fill(`订单详情 ${suffix}`);
  await pageDrawer.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("页面定义已创建", { exact: true })).toBeVisible();
  let pageRow = page.getByRole("row").filter({ hasText: normalizedRoute });
  await expect(pageRow).toBeVisible();
  await expect(pageRow).toContainText("信息分析");

  await pageRow.getByRole("button", { name: "编辑", exact: true }).click();
  const editPageDrawer = page.getByRole("dialog", { name: "编辑页面定义" });
  await expect(editPageDrawer.getByLabel("观测或模板 route")).toBeDisabled();
  await openSelect(editPageDrawer, "页面模板");
  await page.getByRole("option", { name: "实时监测 / 驾驶舱" }).click();
  await expect(editPageDrawer.getByText("不建议频繁修改该字段")).toBeVisible();
  await expect(editPageDrawer.getByLabel("页面模板")).toBeEnabled();
  await editPageDrawer.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/页面定义已保存并创建新 revision/)).toBeVisible();
  pageRow = page.getByRole("row").filter({ hasText: normalizedRoute });
  await expect(pageRow).toContainText("实时监测 / 驾驶舱");

  await pageRow.getByRole("button", { name: "停用", exact: true }).click();
  await expect(page.getByText("页面定义已停用", { exact: true })).toBeVisible();
  await pageRow.getByRole("button", { name: "归档", exact: true }).click();
  await page
    .getByRole("dialog", { name: "归档页面定义" })
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await expect(page.getByText("页面定义已归档", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: normalizedRoute })).toHaveCount(
    0,
  );
  await page.getByRole("checkbox", { name: "显示已归档" }).check();
  pageRow = page.getByRole("row").filter({ hasText: normalizedRoute });
  await expect(pageRow).toContainText("已归档");
  await pageRow.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByText(/页面定义已恢复/)).toBeVisible();
  await expect(pageRow).toContainText("停用");

  await page.getByRole("tab", { name: "工作流" }).click();
  await page.getByRole("button", { name: "新建工作流" }).click();
  const workflowDialog = page.getByRole("dialog", { name: "新建工作流" });
  await workflowDialog.getByLabel("workflowKey").fill(`order_review_${suffix}`);
  await workflowDialog.getByLabel("工作流名称").fill(`订单审核 ${suffix}`);
  await openSelect(workflowDialog, "所属功能模块");
  await page.getByRole("option", { name: moduleName, exact: true }).click();
  await expect(workflowDialog.getByText("actionKey", { exact: true })).toHaveCount(0);
  await expect(workflowDialog.getByText("受控值", { exact: true })).toHaveCount(0);
  await expect(workflowDialog.getByLabel("元素交互范围说明")).toHaveCount(0);
  await expect(workflowDialog.getByText(/tracker.startWorkflow/).first()).toBeVisible();
  await expect(workflowDialog.getByText(/reachStep/).first()).toBeVisible();

  const firstStep = workflowDialog.locator(".workflow-editor-step").first();
  await openSelect(firstStep, "步骤达成条件");
  await page.getByRole("option", { name: "元素交互", exact: true }).click();
  await expect(firstStep.getByLabel("元素交互范围说明")).toBeVisible();
  await openSelect(firstStep, "交互事件");
  await expect(page.getByRole("option", { name: "click", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "change", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "click", exact: true }).click();
  await firstStep.getByLabel("选择器").fill(".review-button");
  await expect(firstStep.getByText(/普通 class 容易随样式变化/)).toBeVisible();
  await expect(firstStep.getByText(/当用户点击 .review-button/)).toBeVisible();
  await expect(
    workflowDialog.locator(".condition-context").getByText("主体"),
  ).toBeVisible();
  await expect(
    workflowDialog.locator(".condition-context").getByText("不能推断"),
  ).toBeVisible();

  const secondStep = workflowDialog.locator(".workflow-editor-step").nth(1);
  await openSelect(secondStep, "步骤达成条件");
  await page.getByRole("option", { name: "operation 终态", exact: true }).click();
  await expect(secondStep.getByLabel("匹配的 operation")).toBeVisible();
  await expect(secondStep.getByLabel("operation 终态")).toBeVisible();
  await expect(secondStep.getByText(/当前 R1-A 只配置定义/)).toBeVisible();
  await expect(secondStep.getByText(/独立 tracker.startOperation/)).toBeVisible();
  await openSelect(secondStep, "operation 终态");
  await expect(
    page.getByRole("option", { name: "succeeded", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: "failed", exact: true })).toBeVisible();
  await expect(
    page.getByRole("option", { name: "canceled", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "succeeded", exact: true }).click();
  await expect(workflowDialog.getByText("appeared", { exact: true })).toHaveCount(0);

  await workflowDialog.getByRole("button", { name: "创建工作流" }).click();
  await expect(page.getByText("工作流已创建", { exact: true })).toBeVisible();
  let workflowRow = page.getByRole("row").filter({ hasText: `order_review_${suffix}` });
  await workflowRow.getByRole("button", { name: "激活", exact: true }).click();
  await page
    .getByRole("dialog", { name: "激活工作流版本" })
    .getByRole("button", { name: "激活", exact: true })
    .click();
  await expect(workflowRow).toContainText("active");
  await workflowRow.getByRole("button", { name: "编辑草稿" }).click();
  const editWorkflowDialog = page.getByRole("dialog", { name: "编辑工作流草稿" });
  await expect(editWorkflowDialog.getByText(/已激活版本不可原地修改/)).toBeVisible();
  await editWorkflowDialog.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/工作流新草稿已保存/)).toBeVisible();
  workflowRow = page.getByRole("row").filter({ hasText: `order_review_${suffix}` });
  await expect(workflowRow).toContainText("v2 · draft");

  await workflowRow.getByRole("button", { name: "停用", exact: true }).click();
  await workflowRow.getByRole("button", { name: "归档", exact: true }).click();
  await page
    .getByRole("dialog", { name: "归档工作流" })
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await expect(workflowRow).toContainText("已归档");
  await workflowRow.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(workflowRow).toContainText("停用");

  await page.getByRole("tab", { name: "功能模块" }).click();
  await moduleRow.getByRole("button", { name: "停用", exact: true }).click();
  await moduleRow.getByRole("button", { name: "归档", exact: true }).click();
  await page
    .getByRole("dialog", { name: "归档功能模块" })
    .getByRole("button", { name: "归档", exact: true })
    .click();
  await expect(page.getByText(/归档失败：仍有 2 个依赖/)).toBeVisible();
  await expect(moduleRow).toContainText("停用");
});

test("viewer sees analysis objects but every representative write remains forbidden", async ({
  page,
}) => {
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

  for (const [path, method] of [
    [`/api/projects/${projectId}/modules`, "POST"],
    [
      `/api/projects/${projectId}/modules/10111111-1111-4111-8111-111111111111/archive`,
      "POST",
    ],
    [
      `/api/projects/${projectId}/page-definitions/20111111-1111-4111-8111-111111111111/restore`,
      "POST",
    ],
    [`/api/projects/${projectId}/workflow-definitions`, "POST"],
  ] as const) {
    const status = await page.evaluate(
      async ({ endpoint, httpMethod }) => {
        const response = await fetch(endpoint, {
          method: httpMethod,
          headers: {
            authorization: `Bearer ${sessionStorage.getItem("fi.access-token")}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        return response.status;
      },
      { endpoint: path, httpMethod: method },
    );
    expect(status).toBe(403);
  }
});

test("narrow screens fold the current condition context below its step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  await page.goto(
    `/projects/${projectId}/metrics?range=7d&tab=analysis-objects&object=workflows`,
  );
  await page.getByRole("button", { name: "新建工作流" }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作流" });
  await expect(dialog.locator(".condition-context")).toBeHidden();
  const folded = dialog
    .locator(".workflow-editor-step")
    .first()
    .locator(".mobile-condition-context");
  await expect(folded).toBeVisible();
  await expect(folded).toContainText("主体：");
  await expect(folded).toContainText("不能推断：");
});
