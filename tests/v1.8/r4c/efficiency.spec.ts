import { spawn, type ChildProcess } from "node:child_process";
import { mintBusinessObjectReference } from "../../../packages/server-core/src/object-reference.js";
import type { EfficiencyFactStore } from "../../../packages/server-core/src/efficiency-facts.js";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
let referenceHost: ChildProcess | undefined;
test.afterEach(async () => {
  if (referenceHost && referenceHost.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      referenceHost!.once("exit", () => resolve()),
    );
    referenceHost.kill();
    await exited;
  }
  referenceHost = undefined;
});
test("R4-C directory publication and real SDK counters through Kafka and ClickHouse", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const login = await request.post("/api/auth/login", {
    data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
  });
  expect(login.status()).toBe(200);
  const headers = { authorization: `Bearer ${(await login.json()).accessToken}` };
  async function post(path: string, data: unknown) {
    const r = await request.post(path, { headers, data });
    expect(r.status(), path).toBe(201);
    return r.json();
  }
  const project = await post("/api/projects", {
    name: `R4-C isolated ${info.project.name} ${randomUUID()}`,
    timezone: "UTC",
    origins: ["http://127.0.0.1:4174", "http://localhost:4174"],
  });
  const root = `/api/projects/${project.id}`;
  const module = await post(root + "/modules", {
    moduleKey: "efficiency_demo",
    name: "Efficiency fixture",
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
  for (const featureKey of ["edit", "save"])
    await post(root + "/features", {
      featureKey,
      name: featureKey,
      featureType: "action",
      operationLifecycleEnabled: featureKey === "save",
    });
  const directory = await post(root + "/directory", {
    env: "dev",
    sourceKey: "isolated_fixture",
    coverage: "complete",
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    entries: [
      {
        userId: "u_isolated_opaque_0001",
        deptId: "dept_fixture",
        roleId: "role_fixture",
        eligible: true,
      },
    ],
  });
  await post(root + `/directory/${directory.id}/publish`, {});
  const immutable = await request.post(root + `/directory/${directory.id}/publish`, {
    headers,
    data: {},
  });
  expect(immutable.status()).toBe(409);
  const metadata = await (await request.get(root + "/directory", { headers })).json();
  expect(metadata[0].status).toBe("published");
  expect(JSON.stringify(metadata)).not.toContain("u_isolated_opaque");
  expect(metadata[0].entries).toBeUndefined();
  // Trusted Node test host obtains signing material; only the signed reference enters the browser.
  const keyResponse = await post(root + "/object-reference-keys", { env: "dev" });
  referenceHost = spawn(process.execPath, ["examples/r4c-reference-host.mjs"], {
    env: {
      ...process.env,
      FI_PROJECT_ID: project.id,
      FI_ADMIN_TOKEN: headers.authorization.slice(7),
      FI_API_URL: "http://127.0.0.1:3000",
    },
    stdio: "ignore",
  });
  await expect
    .poll(
      async () => {
        try {
          return (
            await request.get("http://127.0.0.1:4180/reference", {
              headers: { Origin: "http://127.0.0.1:4174" },
            })
          ).status();
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events")) sent.push(r.postData() ?? "");
  });
  await page.goto(`http://127.0.0.1:4174/?efficiencyAppId=${project.appId}`);
  await page.getByRole("button", { name: "从隔离后端获取引用" }).click();
  await expect(
    page.getByText("短期引用已加载；秘密只在隔离后端", { exact: true }),
  ).toBeVisible();
  const reference = await page.getByLabel("可信后端短期对象引用（可选）").inputValue();
  expect(reference).toMatch(/^or1_/);
  await page.getByRole("button", { name: "安装效率SDK" }).click();
  await expect(page.getByText("R4-C SDK已就绪", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "执行表单与业务结果" }).click();
  await expect(page.getByText("R4-C受控场景已发送", { exact: true })).toBeVisible();
  const query = new URLSearchParams({ env: "dev", range: "7d", moduleId: module.id });
  let result!: {
    efficiency: Awaited<ReturnType<EfficiencyFactStore["read"]>>;
    diagnostics: unknown;
  };
  await expect
    .poll(
      async () => {
        const r = await request.get(root + "/business?" + query, { headers });
        expect(r.status()).toBe(200);
        result = await r.json();
        return result.efficiency?.operation_fail_rate.observations.started;
      },
      { timeout: 30000 },
    )
    .toBe(3);
  await expect
    .poll(
      async () => {
        result = await (
          await request.get(root + "/business?" + query, { headers })
        ).json();
        return result.efficiency.repeated_operation_rate.observedValue;
      },
      { timeout: 30000 },
    )
    .toBe(1);
  expect(result.efficiency.repeated_operation_rate).toMatchObject({
    numerator: 1,
    denominator: 1,
    value: null,
    reason: "REPEATED_LATENESS_WINDOW_OPEN",
  });
  expect(sent.join("")).not.toContain("isolated-order-fixture");
  expect(JSON.parse(sent[0]!).sdk).toMatchObject({
    version: "0.8.0",
    usageCoverage: { droppedEvents: 0, failedBatches: 0 },
  });
  expect(JSON.stringify(result)).not.toContain(reference);
  expect(result.efficiency.form_efficiency.observations).toMatchObject([
    { changes: 3, resets: 1, submits: 2, validationFailures: 1 },
  ]);
  expect(result.efficiency.operation_fail_rate.observations).toMatchObject({
    started: 3,
    success: 1,
    rejected: 1,
    unknown: 1,
  });
  expect(result.efficiency.operation_fail_rate.value).toBeNull();
  expect(result.efficiency.form_efficiency.value).toBeNull();
  expect(result.efficiency.form_efficiency.results[0]?.reason).toBe(
    "INSUFFICIENT_SAMPLE",
  );
  expect(result.efficiency.operation_fail_rate.reason).toBe("BUSINESS_RESULT_UNKNOWN");
  expect(sent.join("")).not.toMatch(
    /isolated_network|inputValue|validationMessage|bizRef/,
  );
  expect(JSON.stringify(result)).not.toMatch(
    /u_isolated_opaque|dept_fixture|role_fixture|payload_json/,
  );
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "执行表单与业务结果" }).click();
    await expect
      .poll(
        async () => {
          const response = await request.get(root + "/business?" + query, { headers });
          expect(response.status()).toBe(200);
          result = await response.json();
          return result.efficiency.form_efficiency.observations[0]?.submits;
        },
        { timeout: 30000 },
      )
      .toBe(4 + i * 2);
  }
  expect(result.efficiency.form_efficiency.results[0]).toMatchObject({
    changesPerSubmit: 1.5,
    resetRate: 0.5,
    validationErrorRate: 0.5,
    sampleSize: 6,
  });
  expect(result.efficiency.operation_fail_rate.observedValue).toBeNull();
  expect(result.efficiency.definitionVersion).toBe("r4c-facts-2026-10-03.3");
  expect(result.efficiency.form_efficiency.value).toMatchObject([
    { formId: "edit", changesPerSubmit: 1.5, resetRate: 0.5, validationErrorRate: 0.5 },
  ]);
  const knownScopeFrom = new Date().toISOString();
  // Four additional actual SDK installations in distinct browser session cohorts.
  // First two share the original object; last two each have one distinct object operation.
  for (let index = 0; index < 4; index++) {
    await page.goto(`http://127.0.0.1:4174/?efficiencyAppId=${project.appId}`);
    await page.evaluate(() => sessionStorage.clear());
    const currentReference =
      index < 2
        ? reference
        : mintBusinessObjectReference({
            projectId: project.id,
            env: "dev",
            objectType: "order",
            rawObjectId: `isolated-distinct-${index}`,
            issuedAt: Date.now(),
            keys: keyResponse.keys.map((k: { epoch: number; secret: string }) => ({
              epoch: k.epoch,
              secret: Buffer.from(k.secret, "hex"),
            })),
          });
    await page.getByLabel("可信后端短期对象引用（可选）").fill(currentReference);
    await page.getByRole("button", { name: "安装效率SDK" }).click();
    await page.getByRole("button", { name: "执行一次受控操作", exact: true }).click();
    await expect(page.getByText("单次受控操作已发送", { exact: true })).toBeVisible();
    if (index === 0)
      await page.getByRole("button", { name: "执行一次受控操作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const r = await (
            await request.get(root + "/business?" + query, { headers })
          ).json();
          return r.efficiency.operation_fail_rate.observations.started;
        },
        { timeout: 30000 },
      )
      .toBe(11 + index);
  }
  await expect
    .poll(
      async () => {
        result = await (
          await request.get(root + "/business?" + query, { headers })
        ).json();
        return result.efficiency.repeated_operation_rate.observedValue;
      },
      { timeout: 30000 },
    )
    .toBe(0.6);
  expect(result.efficiency.repeated_operation_rate).toMatchObject({
    numerator: 3,
    denominator: 5,
    value: null,
  });
  const knownQuery = new URLSearchParams({
    env: "dev",
    moduleId: module.id,
    range: "custom",
    from: knownScopeFrom,
    to: new Date().toISOString(),
  });
  const known = await (
    await request.get(root + "/business?" + knownQuery, { headers })
  ).json();
  expect(known.efficiency.operation_fail_rate).toMatchObject({
    value: 0,
    numerator: 0,
    denominator: 5,
    status: "available",
  });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "全部项目", exact: true }),
  ).toBeVisible();
  const began = performance.now();
  await page.goto(`/projects/${project.id}/business?${query}`);
  await expect(
    page.getByRole("heading", { name: "操作效率", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "组织维度", exact: true }),
  ).toBeVisible();
  const firstUsableMs = performance.now() - began;
  await page.getByRole("link", { name: "查看组织目录配置与版本" }).click();
  await expect(
    page.getByRole("heading", { name: "组织目录", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(directory.id, { exact: true })).toBeVisible();
  const sourcePanel = page.locator('section[aria-labelledby="usage-sources-title"]');
  await expect(
    sourcePanel.getByRole("heading", { name: "全量接入声明", exact: true }),
  ).toBeVisible();
  await sourcePanel.getByLabel("已部署 release（逗号分隔）").fill("r4c-demo");
  await sourcePanel.getByLabel("我已核实上述范围及覆盖状态").check();
  await sourcePanel.getByRole("button", { name: "校验并保存声明草稿" }).click();
  await sourcePanel.getByRole("button", { name: "发布此接入声明" }).click();
  await expect(
    sourcePanel.getByRole("cell", { name: "published", exact: true }),
  ).toBeVisible();
  const sourceRows = await (
    await request.get(root + "/usage-sources", { headers })
  ).json();
  expect(sourceRows[0].scope.pageCount).toBe(1);
  expect(sourceRows[0].sdkVersion).toBe("0.8.0");
  await page.getByRole("button", { name: "返回原业务分析", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/business\\?`));
  expect(new URL(page.url()).searchParams.get("moduleId")).toBe(module.id);
  expect(new URL(page.url()).searchParams.get("env")).toBe("dev");
  const values: number[] = [];
  for (let i = 0; i < 23; i++) {
    const t = performance.now();
    const r = await request.get(root + "/business?" + query, { headers });
    expect(r.status()).toBe(200);
    await r.json();
    if (i >= 3) values.push(performance.now() - t);
  }
  const p95 = [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
  expect(p95).toBeLessThanOrEqual(2000);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r4c-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? "local",
        scope:
          "real SDK0.8 form/business/coverage diagnostics, directory and source publication UI",
        warmups: 3,
        sampleCount: 20,
        firstUsableMs,
        p95Algorithm: "nearest-rank",
        p95,
        rawMs: values,
        diagnostics: result.diagnostics,
        repeatedOperation: {
          numerator: 3,
          denominator: 5,
          observedValue: 0.6,
          source: "actual SDK across five browser session cohorts; window remains open",
        },
        privacyPolicy:
          "approved k=5; fixed closed calendar buckets; whole-family suppression",
        coverageDeclarationPublished: true,
      },
      null,
      2,
    ),
  );
});
