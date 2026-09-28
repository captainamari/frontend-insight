import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

test("real browser SDK → API → Kafka → consumer → workflow analysis → UI", async ({
  page,
  request,
  browser,
}, info) => {
  test.setTimeout(180000);
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
      timeoutSeconds: workflowKey === "dashboard_property_view" ? 10 : 600,
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
          stepKey === "transfer_completed"
            ? "operation_terminal"
            : stepKey === "data_loaded"
              ? "network_request"
              : stepKey === "property_rendered"
                ? "page_lifecycle"
                : "explicit_sdk",
        triggerConfig:
          stepKey === "transfer_completed"
            ? { operationKey: "model_download", state: "succeeded" }
            : stepKey === "data_loaded"
              ? { method: "GET", pathPattern: "/workflow-demo-data.json" }
              : stepKey === "property_rendered"
                ? { event: "loaded" }
                : {},
      })),
    });
    await post(root + `/workflow-definitions/${workflow.id}/activate`, {
      versionId: workflow.latestVersion.id,
    });
  }
  const selector = await post(root + "/workflow-definitions", {
    moduleId: module.id,
    workflowKey: "dashboard_selector_view",
    name: "Selector verification",
    startPolicy: "explicit_sdk",
    timeoutSeconds: 30,
    terminalPolicy: {
      completedStepKey: "property_rendered",
      failedStepKey: null,
      canceledStepKey: null,
      timeoutState: "approximate_abandoned",
    },
    steps: ["property_selected", "data_loaded", "property_rendered"].map(
      (stepKey, i) => ({
        stepKey,
        stepOrder: i + 1,
        name: stepKey,
        triggerKind: i ? "explicit_sdk" : "selector",
        triggerConfig: i
          ? {}
          : { event: "click", selector: '[data-fi-action="r4b-select"]' },
      }),
    ),
  });
  await post(root + `/workflow-definitions/${selector.id}/activate`, {
    versionId: selector.latestVersion.id,
  });
  await post(root + "/operational-settings/versions", {
    targetUsers: 3,
    expectedActiveWeekdays: [1, 2, 3, 4, 5, 6, 7],
  });
  const versionsResponse = await request.get(
    root + "/metrics/versions?type=operational",
    { headers },
  );
  const options = await (
    await request.get(root + "/score-management/business-options", { headers })
  ).json();
  const template = await (
    await request.get(root + "/score-management/templates?type=operational", {
      headers,
    })
  ).json();
  const weights = Object.fromEntries(
    options.workflows.map((w: { id: string; workflowKey: string }) => [
      w.id,
      w.workflowKey === "admin_model_download"
        ? 3
        : w.workflowKey === "dashboard_selector_view"
          ? 2
          : 1,
    ]),
  );
  const reviewQuery = {
    env: "dev",
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date().toISOString(),
    granularity: "day",
  };
  const initialActive = (await versionsResponse.json()).find(
    (v: { status: string }) => v.status === "draft",
  );
  const initialSaved = await request.put(
    root + `/score-management/versions/${initialActive.id}`,
    {
      headers,
      data: {
        configuration: template.configuration,
        business: {
          confirmed: true,
          scopeId: project.id,
          optionsDigest: options.optionsDigest,
          workflowWeights: weights,
          durationMinimumSample: 5,
        },
      },
    },
  );
  expect(initialSaved.status()).toBe(200);
  await post(
    root + `/score-management/versions/${initialActive.id}/review`,
    reviewQuery,
  );
  await post(root + `/metrics/versions/${initialActive.id}/activate`, undefined);
  expect(
    (
      await request.post(
        root + `/metrics/versions/${initialActive.id}/workflow-facts`,
        { headers, data: {} },
      )
    ).status(),
  ).toBe(409);
  const activeBefore = await (
    await request.get(root + `/metrics/versions/${initialActive.id}`, { headers })
  ).json();
  const draft = await post(root + "/metrics/versions", {
    type: "operational",
    sourceVersionId: initialActive.id,
  });
  await post(root + `/metrics/versions/${draft.id}/workflow-facts`, {});
  const saved = await request.put(root + `/score-management/versions/${draft.id}`, {
    headers,
    data: {
      configuration: template.configuration,
      business: {
        confirmed: true,
        scopeId: project.id,
        optionsDigest: options.optionsDigest,
        workflowWeights: weights,
        durationMinimumSample: 5,
      },
    },
  });
  expect(saved.status()).toBe(200);
  const activeAfter = await (
    await request.get(root + `/metrics/versions/${initialActive.id}`, { headers })
  ).json();
  expect(activeAfter.definitions).toEqual(activeBefore.definitions);
  await post(root + `/score-management/versions/${draft.id}/review`, reviewQuery);
  await post(root + `/metrics/versions/${draft.id}/activate`, undefined);
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
  const to = new Date().toISOString();
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
      .filter((d: { started: number }) => d.started > 0)
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
  await page.getByText("隔离验收场景（专用项目）", { exact: true }).click();
  await page.getByRole("button", { name: "验证独立操作隔离", exact: true }).click();
  await expect(
    page.getByText("独立操作未达成工作流步骤", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "验证显式失败与主动取消", exact: true })
    .click();
  await expect(
    page.getByText("已上报显式失败与主动取消", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "准备selector任务", exact: true }).click();
  await page.getByRole("button", { name: "触发selector步骤", exact: true }).click();
  await expect(page.getByText("selector受控任务已完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始超时观察", exact: true }).click();
  await expect(
    page.getByText("任务进行中；10秒后仅推导近似超时", { exact: true }),
  ).toBeVisible();
  const liveAnalysis = async () => {
    const q = new URLSearchParams(query);
    q.set("to", new Date().toISOString());
    const response = await request.get(root + "/business?" + q, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  await expect
    .poll(
      async () =>
        (await liveAnalysis()).workflowAnalysis.definitions.find(
          (d: { workflowKey: string }) => d.workflowKey === "dashboard_property_view",
        ).inProgress,
      { timeout: 7000, intervals: [250, 500] },
    )
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await liveAnalysis()).workflowAnalysis.definitions.find(
          (d: { workflowKey: string }) => d.workflowKey === "dashboard_property_view",
        ).approximate_abandoned,
      { timeout: 14000, intervals: [500] },
    )
    .toBe(1);
  const live = await liveAnalysis();
  const transfer = live.workflowAnalysis.definitions.find(
    (d: { workflowKey: string }) => d.workflowKey === "admin_model_download",
  );
  expect(transfer).toMatchObject({
    completed: 3,
    failed: 1,
    canceled: 1,
    inProgress: 1,
  });
  expect(
    live.workflowAnalysis.definitions.find(
      (d: { workflowKey: string }) => d.workflowKey === "dashboard_selector_view",
    ).completed,
  ).toBe(1);
  expect(payloads.join("\n")).not.toContain("FI_PRIVATE_QUERY_SENTINEL");
  const scoreQuery = new URLSearchParams({
    env: "dev",
    from,
    to: new Date().toISOString(),
    granularity: "day",
  });
  const scoreResponse = await request.get(
    root + `/score-management/versions/${draft.id}/result?${scoreQuery}`,
    { headers },
  );
  expect(scoreResponse.status()).toBe(200);
  const score = await scoreResponse.json();
  expect(score.value).toBeNull();
  expect(score.workflowObservation.values.completionRate).toBeCloseTo(12 / 22);
  expect(score.workflowObservation.values.adverseRate).toBeCloseTo(7 / 22);
  const pooled = live.workflowAnalysis.evidence
    .filter((e: { state: string }) => e.state === "completed")
    .flatMap((e: { workflowKey: string; durationMs: number }) =>
      Array(
        e.workflowKey === "admin_model_download"
          ? 3
          : e.workflowKey === "dashboard_selector_view"
            ? 2
            : 1,
      ).fill(e.durationMs),
    )
    .sort((a: number, b: number) => a - b);
  expect(score.workflowObservation.values.p50).toBe(
    pooled[Math.ceil(pooled.length / 2) - 1],
  );
  expect(score.workflowObservation.facts.key_task_completion_rate.status).toBe(
    "partial",
  );
  expect(score.samples.total).toBeNull();
  // Keep the independently started v1 instance alive across v2 activation and
  // object disable/archive. Its terminal still uses the frozen v1 definition.
  const oldDefinition = await (
    await request.get(
      root + `/workflow-definitions/${transfer.id}/versions/${transfer.versionId}`,
      { headers },
    )
  ).json();
  const revisionResponse = await request.put(
    root + `/workflow-definitions/${transfer.id}/draft`,
    {
      headers,
      data: {
        moduleId: module.id,
        name: "admin_model_download",
        startPolicy: oldDefinition.startPolicy,
        terminalPolicy: oldDefinition.terminalPolicy,
        timeoutSeconds: 300,
        steps: oldDefinition.steps,
      },
    },
  );
  expect(revisionResponse.status()).toBe(200);
  const revision = await revisionResponse.json();
  await post(root + `/workflow-definitions/${transfer.id}/activate`, {
    versionId: revision.latestVersion.id,
  });
  const runtime = async () => {
    const r = await request.post("/v1/events/workflow-config", {
      headers: { origin: "http://127.0.0.1:4174" },
      data: { appId: project.appId, env: "dev" },
    });
    expect(r.status()).toBe(200);
    return (await r.json()).definitions.filter(
      (d: { workflowKey: string }) => d.workflowKey === "admin_model_download",
    );
  };
  expect(
    (await runtime())
      .filter((d: { canStart: boolean }) => d.canStart)
      .map((d: { version: number }) => d.version),
  ).toEqual([2]);
  expect(
    (
      await request.patch(root + `/workflow-definitions/${transfer.id}`, {
        headers,
        data: { status: "disabled" },
      })
    ).status(),
  ).toBe(200);
  expect((await runtime()).every((d: { canStart: boolean }) => !d.canStart)).toBe(true);
  expect(
    (
      await request.post(root + `/workflow-definitions/${transfer.id}/archive`, {
        headers,
      })
    ).status(),
  ).toBe(204);
  await page.getByRole("button", { name: "完成在途旧版本任务", exact: true }).click();
  await expect(
    page.getByText("已完成1个在途旧版本任务", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await liveAnalysis()).workflowAnalysis.definitions.find(
          (d: { versionId: string }) => d.versionId === transfer.versionId,
        ).completed,
      { timeout: 15000 },
    )
    .toBe(4);
  await post(root + `/workflow-definitions/${transfer.id}/restore`, undefined);
  expect(
    (
      await request.patch(root + `/workflow-definitions/${transfer.id}`, {
        headers,
        data: { status: "active" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await runtime())
      .filter((d: { canStart: boolean }) => d.canStart)
      .map((d: { version: number }) => d.version),
  ).toEqual([2]);
  const poison = JSON.parse(payloads.find((p) => p.includes("workflow_started"))!);
  poison.events = [
    poison.events.find(
      (e: { payload: { name: string } }) => e.payload.name === "workflow_started",
    ),
  ];
  poison.events[0].payload.labels = { token: "FI_PRIVATE_NEGATIVE" };
  const negative = await request.post("/v1/events", {
    headers: { origin: "http://127.0.0.1:4174" },
    data: poison,
  });
  expect(negative.status()).toBe(400);
  expect(await negative.text()).not.toContain("FI_PRIVATE_NEGATIVE");
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
  const detailBegan = Date.now();
  await page
    .getByRole("button", { name: "查看 admin_model_download v1", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "阶段漏斗与相邻阶段耗时", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("有效成功样本 3", { exact: false })).toBeVisible();
  const detailFirstUsableMs = Date.now() - detailBegan;
  await page.getByRole("button", { name: "查看工作流定义与版本", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "分析引用的工作流版本" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回原业务分析", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "阶段漏斗与相邻阶段耗时", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Scale definition/step counts without per-definition fact requests. Facts remain
  // the actual SDK sample above, not a claim about production event capacity.
  for (let i = 0; i < 17; i++) {
    const keys = Array.from({ length: i % 2 ? 20 : 2 }, (_, n) => `stage_${n + 1}`);
    const w = await post(root + "/workflow-definitions", {
      moduleId: module.id,
      workflowKey: `scale_${i}`,
      name: `Scale ${i}`,
      startPolicy: "explicit_sdk",
      timeoutSeconds: 600,
      terminalPolicy: {
        completedStepKey: keys.at(-1),
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      },
      steps: keys.map((stepKey, n) => ({
        stepKey,
        stepOrder: n + 1,
        name: stepKey,
        triggerKind: "explicit_sdk",
        triggerConfig: {},
      })),
    });
    await post(root + `/workflow-definitions/${w.id}/activate`, {
      versionId: w.latestVersion.id,
    });
  }
  const performanceSamples: unknown[] = [];
  for (const range of ["7d", "30d", "90d", "365d"]) {
    const samples: number[] = [];
    let measured: typeof result;
    for (let n = 0; n < 23; n++) {
      const start = performance.now();
      const r = await request.get(
        root + `/business?env=dev&range=${range}&moduleId=${module.id}`,
        { headers },
      );
      expect(r.status()).toBe(200);
      measured = await r.json();
      if (n >= 3) samples.push(performance.now() - start);
    }
    const p95 = [...samples].sort((a, b) => a - b)[
      Math.ceil(samples.length * 0.95) - 1
    ]!;
    expect(measured!.workflowAnalysis.totalDefinitions).toBe(21);
    expect(measured!.diagnostics.clickHouseQueries).toBe(
      result.diagnostics.clickHouseQueries,
    );
    expect(p95).toBeLessThanOrEqual(2000);
    performanceSamples.push({
      range,
      warmup: 3,
      count: samples.length,
      rawMs: samples,
      p95,
      algorithm: "nearest_rank_ceil_0.95n",
      httpQueriesPerSample: 1,
      diagnostics: measured!.diagnostics,
      workflowDiagnostics: measured!.workflowAnalysis.diagnostics,
      workflows: 20,
      definitionVersions: 21,
      stepsPerDefinition: [2, 20],
      sdkInstances: 9,
      concurrentSdkInstances: 3,
      qualification: "sparse controlled sample, not production capacity",
    });
  }
  const viewerLogin = await request.post("/api/auth/login", {
    data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
  });
  const viewerHeaders = {
    authorization: `Bearer ${(await viewerLogin.json()).accessToken}`,
  };
  const denied = await request.get(analysisPath, { headers: viewerHeaders });
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain("admin_model_download");
  const membership = await request.put(
    root + "/members/88888888-8888-4888-8888-888888888888",
    { headers, data: { role: "viewer" } },
  );
  expect(membership.status()).toBe(200);
  expect((await request.get(analysisPath, { headers: viewerHeaders })).status()).toBe(
    200,
  );
  expect(
    (
      await request.post(root + "/workflow-definitions", {
        headers: viewerHeaders,
        data: {},
      })
    ).status(),
  ).toBe(403);
  const frozen = result.workflowAnalysis.definitions[0];
  expect(
    (
      await request.get(
        root + `/workflow-definitions/${frozen.id}/versions/${frozen.versionId}`,
        { headers: viewerHeaders },
      )
    ).status(),
  ).toBe(200);
  const viewerContext = await browser.newContext({
    baseURL: process.env.M5_WEB_URL ?? "http://127.0.0.1:4173",
  });
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto("/login");
  await viewerPage.getByLabel("邮箱").fill("viewer@example.invalid");
  await viewerPage.getByLabel("密码").fill("LocalViewer-1234");
  await viewerPage.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    viewerPage.getByRole("heading", { name: "全部项目", exact: true }),
  ).toBeVisible();
  await viewerPage.goto(`/projects/${project.id}/business?${query}`);
  await viewerPage
    .getByRole("button", { name: "查看 admin_model_download v1", exact: true })
    .click();
  await expect(
    viewerPage.getByRole("heading", { name: "阶段漏斗与相邻阶段耗时", exact: true }),
  ).toBeVisible();
  await viewerPage
    .getByRole("button", { name: "查看工作流定义与版本", exact: true })
    .click();
  await expect(
    viewerPage.getByRole("region", { name: "分析引用的工作流版本" }),
  ).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "新建工作流", exact: true }),
  ).toHaveCount(0);
  await viewerContext.close();
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r4b-sdk-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: info.project.name,
        source:
          "real browser SDK through API Kafka consumer ClickHouse and product API/UI; no direct fact insert",
        initialCompleted: 4,
        controlledOutcomeEvidence: {
          completed: 5,
          failed: 1,
          canceled: 1,
          inProgress: 1,
          approximate_abandoned: 1,
        },
        firstUsableMs,
        detailFirstUsableMs,
        performanceSamples,
        fullMilestoneAcceptance: false,
      },
      null,
      2,
    ),
  );
});
