import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.M5_WEB_URL ?? "http://127.0.0.1:4173";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
}

test("operation demo emits independently paired v2 terminal events", async ({
  page,
}) => {
  const payloads: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/events") && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (body) payloads.push(body);
    }
  });
  await page.goto(`${demoUrl}/action?acceptance=fast`);
  await page.getByLabel("模拟密码").fill("m6-local-only");
  await page.getByRole("button", { name: "进入场景实验室" }).click();
  const firstOperation = page.locator(".operation-row").first();
  await firstOperation.getByRole("button", { name: "成功" }).click();
  await firstOperation.getByRole("button", { name: "取消" }).click();
  await firstOperation.getByRole("button", { name: "失败" }).click();
  await page.getByRole("button", { name: "立即发送" }).click();
  await expect.poll(() => payloads.length).toBeGreaterThan(0);

  const events = payloads.flatMap(
    (payload) => (payload.events as Array<Record<string, unknown>>) ?? [],
  );
  const operationEvents = events.filter((event) =>
    [
      "feature_started",
      "feature_succeeded",
      "feature_failed",
      "feature_canceled",
    ].includes(String(event.eventName)),
  );
  expect(payloads.some((payload) => payload.schemaVersion === 2)).toBe(true);
  const starts = operationEvents.filter(
    (event) => event.eventName === "feature_started",
  );
  const terminals = operationEvents.filter((event) =>
    ["feature_succeeded", "feature_failed", "feature_canceled"].includes(
      String(event.eventName),
    ),
  );
  expect(new Set(starts.map((event) => event.operationInstanceId)).size).toBe(3);
  expect(terminals).toHaveLength(3);
  for (const start of starts) {
    expect(
      terminals.filter(
        (terminal) => terminal.operationInstanceId === start.operationInstanceId,
      ),
    ).toHaveLength(1);
  }
});

test("admin can follow overview, page detail, index and versioned configuration", async ({
  page,
}) => {
  await login(page, "admin@example.invalid", "LocalAdmin-1234");

  await page.getByRole("button", { name: /运营概览/ }).click();
  await expect(page.getByRole("heading", { name: "运营概览" })).toBeVisible();
  await expect(page.getByText("模块使用")).toBeVisible();
  await expect(page.getByText("核心页面")).toBeVisible();
  await expect(page.getByText("关键任务")).toBeVisible();
  await expect(page.getByText("有效活跃账号")).toBeVisible();
  await expect(page.getByText("活跃日覆盖")).toBeVisible();
  await expect(page.getByText("账号", { exact: true }).first()).toBeVisible();

  const taskEvidence = page.getByRole("button", { name: /报告导出/ });
  if (await taskEvidence.count()) {
    await taskEvidence.first().click();
    await expect(
      page.getByRole("heading", { name: "任务实例与使用效率" }),
    ).toBeVisible();
    await expect(page.getByText("成功耗时 p50 / p75")).toBeVisible();
    await page.getByRole("button", { name: /运营概览/ }).click();
  }

  const reports = page.getByRole("button", { name: /经营分析/ });
  if (await reports.count()) {
    await reports.first().click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();
    await expect(page.getByText("可见时长 p50 / p75")).toBeVisible();
    await expect(page.getByText("时长覆盖率")).toBeVisible();
    await expect(page.getByText("本页 PV 与活跃浏览器趋势")).toBeVisible();
    await expect(page.getByText("会话模块广度 p50 / p75")).toBeVisible();
  }

  await page.getByRole("button", { name: /项目运营指数/ }).click();
  await expect(page.getByRole("heading", { name: "项目运营指数" })).toBeVisible();
  await expect(page.getByText("叶子权重覆盖")).toBeVisible();
  await expect(page.getByText("四维等价明细")).toBeVisible();
  await expect(page.getByText("指数构成")).toBeVisible();
  await expect(page.getByText(/智慧园区运营指数 v1/)).toBeVisible();

  await page.getByRole("button", { name: "配置目标与权重" }).click();
  await expect(page.getByRole("heading", { name: "运营指标配置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模块" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "页面" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "功能与任务元数据" })).toBeVisible();
  await expect(page.getByText("当前：智慧园区运营指数 v1 · v1")).toBeVisible();
  await expect(page.getByText(/历史参考（当前筛选）/)).toBeVisible();
  await expect(page.getByText("实时监测 / 驾驶舱")).toBeVisible();
  await expect(page.getByText("信息分析")).toBeVisible();
  await expect(page.getByText("任务操作")).toBeVisible();
  await expect(page.getByText(/配置叶子权重/)).toBeVisible();

  const moduleName = `E2E 模块 ${Date.now()}`;
  await page.getByRole("button", { name: "新建模块" }).click();
  const dialog = page.getByRole("dialog", { name: "新建模块" });
  await dialog.getByLabel("moduleKey").fill(`e2e_module_${Date.now()}`);
  await dialog.getByLabel("模块名称").fill(moduleName);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByDisplayValue(moduleName)).toBeVisible();
});

test("viewer sees M6 evidence but cannot write operational configuration", async ({
  page,
}) => {
  await login(page, "viewer@example.invalid", "LocalViewer-1234");
  await page.getByRole("button", { name: /项目运营指数/ }).click();
  await expect(page.getByText("配置目标与权重")).toHaveCount(0);

  const url = new URL(page.url());
  await page.goto(
    `${webUrl}/operational-config?project=${url.searchParams.get("project")}&range=7d`,
  );
  await expect(page.getByText("当前账号为只读权限")).toBeVisible();
  await expect(page.getByRole("button", { name: "新建模块" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存为新版本" })).toHaveCount(0);

  const responseStatus = await page.evaluate(async (projectId) => {
    const token = sessionStorage.getItem("fi.access-token");
    const response = await fetch(
      `/api/projects/${projectId}/operational-settings/versions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetAccounts: 99,
          expectedActiveWeekdays: [1, 2, 3, 4, 5],
        }),
      },
    );
    return response.status;
  }, url.searchParams.get("project"));
  expect(responseStatus).toBe(403);
});

test("an unconfigured project keeps the M5 loop and refuses to invent an index", async ({
  page,
}) => {
  await login(page, "admin@example.invalid", "LocalAdmin-1234");
  const projectId = await page.evaluate(async () => {
    const token = sessionStorage.getItem("fi.access-token");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `M6 no-config ${Date.now()}`,
        timezone: "UTC",
        retentionDays: 90,
        origins: ["http://localhost:4174"],
      }),
    });
    if (!response.ok) throw new Error(`project create failed: ${response.status}`);
    return String((await response.json()).id);
  });

  await page.goto(`${webUrl}/features?project=${projectId}&range=7d`);
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
  await expect(page.getByText("这个项目还没有收到事件")).toBeVisible();

  await page.goto(`${webUrl}/operational-index?project=${projectId}&range=7d`);
  await expect(page.getByRole("heading", { name: "项目运营指数" })).toBeVisible();
  await expect(page.getByText("尚未激活 profile")).toBeVisible();
  await expect(page.getByText("尚未激活指标 profile").first()).toBeVisible();
  await expect(page.getByText(/当前不展示总分/)).toBeVisible();
});
