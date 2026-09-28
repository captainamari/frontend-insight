import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

test("real browser SDK → API → Kafka → consumer → workflow analysis → UI", async ({
  page,
  request,
}, info) => {
  const login = await request.post("/api/auth/login", {
    data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
  });
  expect(login.status()).toBe(200);
  const token = (await login.json()).accessToken as string;
  const headers = { authorization: `Bearer ${token}` };
  async function post(path: string, data: unknown) {
    const r = await request.post(path, { headers, data });
    expect(r.status(), path).toBe(201);
    return r.json();
  }
  const project = await post("/api/projects", {
    name: `R4-B isolated ${info.project.name} ${randomUUID()}`,
    timezone: "UTC",
    origins: ["http://127.0.0.1:4174", "http://localhost:4174"],
  });
  const root = `/api/projects/${project.id}`;
  const module = await post(root + "/modules", {
    moduleKey: "workflow_demo",
    name: "Workflow demo",
  });
  await post(root + "/page-definitions", {
    moduleId: module.id,
    name: "Demo",
    pageRoute: "/",
    templateKey: "task_operation",
    isCore: true,
    criticalityWeight: 1,
    expectedFrequency: "daily",
  });
  await post(root + "/features", {
    featureKey: "model_download",
    name: "Synthetic transfer",
    featureType: "action",
    operationLifecycleEnabled: true,
  });
  for (const [workflowKey, keys] of [
    [
      "dashboard_property_view",
      ["property_selected", "data_loaded", "property_rendered"],
    ],
    [
      "admin_model_download",
      [
        "download_requested",
        "request_accepted",
        "transfer_started",
        "transfer_completed",
      ],
    ],
  ] as const) {
    const workflow = await post(root + "/workflow-definitions", {
      moduleId: module.id,
      workflowKey,
      name: workflowKey,
      startPolicy: "explicit_sdk",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: keys.at(-1),
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: keys.map((stepKey, i) => ({
        stepKey,
        name: stepKey,
        stepOrder: i + 1,
        triggerKind:
          stepKey === "transfer_completed" ? "operation_terminal" : "explicit_sdk",
        triggerConfig:
          stepKey === "transfer_completed"
            ? { operationKey: "model_download", state: "succeeded" }
            : {},
      })),
    });
    await post(root + `/workflow-definitions/${workflow.id}/activate`, {
      versionId: workflow.latestVersion.id,
    });
  }
  const from = new Date().toISOString();
  const payloads: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData()) payloads.push(r.postData()!);
  });
  await page.goto(
    `http://127.0.0.1:4174/?workflowAppId=${project.appId}&private=FI_PRIVATE_QUERY_SENTINEL`,
  );
  await page.getByRole("button", { name: "加载工作流配置", exact: true }).click();
  await expect(page.getByText("示例SDK已就绪", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择属性并加载渲染", exact: true }).click();
  await expect(page.getByText("属性数据已校验并渲染", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "并发三个传输", exact: true }).click();
  await expect(
    page.getByText("响应流已全部接收；不代表浏览器保存或操作系统落盘", { exact: true }),
  ).toBeVisible();
  const to = new Date(Date.now() + 1000).toISOString();
  const query = new URLSearchParams({
    env: "dev",
    range: "custom",
    from,
    to,
    moduleId: module.id,
  });
  const analysisPath = root + "/business?" + query;
  await expect
    .poll(
      async () => {
        const r = await request.get(analysisPath, { headers });
        if (r.status() !== 200) return -1;
        const b = await r.json();
        return b.workflowAnalysis?.definitions.reduce(
          (n: number, d: { completed: number }) => n + d.completed,
          0,
        );
      },
      { timeout: 45000, intervals: [500, 1000, 2000] },
    )
    .toBe(4);
  const response = await request.get(analysisPath, { headers });
  const result = await response.json();
  expect(
    result.workflowAnalysis.definitions
      .map((d: { started: number; completed: number }) => [d.started, d.completed])
      .sort(),
  ).toEqual([
    [1, 1],
    [3, 3],
  ]);
  expect(result.workflowAnalysis.evidence).toHaveLength(4);
  expect(payloads.length).toBeGreaterThan(0);
  expect(payloads.join("\n")).not.toContain("FI_PRIVATE_QUERY_SENTINEL");
  expect(payloads.join("\n")).not.toContain("Synthetic transfer fixture");
  expect(JSON.stringify(result.workflowAnalysis)).not.toContain(
    "demo-workflow-reference",
  );
  const forbidden = await request.get(analysisPath);
  expect(forbidden.status()).toBe(401);
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "全部项目", exact: true }),
  ).toBeVisible();
  const began = Date.now();
  await page.goto(`/projects/${project.id}/business?${query}`);
  await expect(
    page.getByRole("heading", { name: "工作流追踪", exact: true }),
  ).toBeVisible();
  const firstUsableMs = Date.now() - began;
  await page
    .getByRole("button", { name: "查看 admin_model_download v1", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "阶段漏斗与相邻阶段耗时", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("有效成功样本 3", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r4b-sdk-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: info.project.name,
        source:
          "real browser SDK through API Kafka consumer ClickHouse and product API/UI; no direct fact insert",
        completed: 4,
        firstUsableMs,
        fullMilestoneAcceptance: false,
      },
      null,
      2,
    ),
  );
});
