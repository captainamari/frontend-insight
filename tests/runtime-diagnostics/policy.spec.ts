import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { FrontendInsightEventV3 } from "@frontend-insight/event-contract";
test("D6 settings publication → deployed SDK → storage, shutdown, deletion and health", async ({
  page,
  context,
  request,
}, info) => {
  test.setTimeout(240000);
  const admin = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${admin.accessToken}` };
  const made = await request.post("/api/projects", {
    headers,
    data: {
      name: `D6 ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const project = await made.json(),
    root = `/api/projects/${project.id}/diagnostics`;
  const initial = await (await request.get(root + "/settings", { headers })).json();
  expect(initial.revision).toBe(0);
  await page.goto(`/projects/${project.id}/settings?tab=diagnostics&env=dev`);
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码", { exact: true }).fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "诊断策略与维护" })).toBeVisible();
  await page.getByLabel("新证据保留天数").fill("2");
  await page.getByRole("button", { name: "保存并发布诊断策略" }).click();
  await expect(
    page.getByRole("region", { name: "诊断策略与维护" }).getByRole("status"),
  ).toContainText("发布成功");
  expect(
    (
      await request.put(root + "/policy", {
        headers,
        data: { revision: 0, policy: initial.policy },
      })
    ).status(),
  ).toBe(409);
  const published = await (await request.get(root + "/settings", { headers })).json();
  expect(published.policy.retentionDays).toBe(2);
  expect(published.revision).toBe(1);
  const demo = await context.newPage(),
    captured: FrontendInsightEventV3[] = [];
  let firstBatch: Record<string, unknown> | undefined;
  demo.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData()) {
      const b = JSON.parse(r.postData()!);
      if (
        !firstBatch &&
        b.events.some(
          (e: FrontendInsightEventV3) => e.release === "d6-lab" && e.diagnostic,
        )
      )
        firstBatch = structuredClone(b);
      captured.push(
        ...b.events.filter(
          (e: FrontendInsightEventV3) => e.release === "d6-lab" && e.diagnostic,
        ),
      );
    }
  });
  await demo.goto(`http://127.0.0.1:4174/observability?d6AppId=${project.appId}`);
  await demo.getByRole("button", { name: "初始化 D6 SDK" }).click();
  await expect(demo.getByTestId("d6-policy-state")).toContainText('"state": "active"');
  await demo.getByRole("button", { name: "同步 D6 策略" }).click();
  await expect(demo.getByTestId("d6-policy-state")).toContainText('"version": "d6-1"');
  const send = async () => {
    const n = captured.length;
    await demo.getByRole("button", { name: "D6 日志后错误", exact: true }).click();
    await expect
      .poll(async () => ({
        count: captured.length,
        state:
          captured.length === n + 1
            ? "sent"
            : await demo.getByTestId("d6-policy-state").innerText(),
      }))
      .toEqual({ count: n + 1, state: "sent" });
    return captured[n]!;
  };
  const first = await send();
  expect(first.diagnostic?.policyVersion).toBe("d6-1");
  expect(JSON.stringify(first.diagnostic?.raw)).toContain("D6 synthetic context");
  const detail = async (id: string) =>
    await (await request.get(root + `/instances/${id}`, { headers })).json();
  await expect
    .poll(async () => (await detail(first.eventId)).state, { timeout: 45000 })
    .toBe("ready");
  expect((await detail(first.eventId)).diagnostic).toEqual(first.diagnostic);
  // Real configuration network failure, while the business/ingestion channel remains alive.
  await demo.getByLabel("模拟策略网络失败", { exact: false }).check();
  await demo.getByRole("button", { name: "同步 D6 策略" }).click();
  await expect(demo.getByTestId("d6-policy-state")).toContainText(
    '"sync": "last_valid"',
  );
  await page.getByLabel("启用诊断采集", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存并发布诊断策略" }).click();
  await expect(
    page.getByRole("region", { name: "诊断策略与维护" }).getByRole("status"),
  ).toContainText("发布成功");
  // Offline SDK still holds the old policy; server admission already enforces shutdown.
  const offlineEvent = await send();
  await expect
    .poll(async () => (await detail(offlineEvent.eventId)).state, { timeout: 45000 })
    .toBe("disabled");
  await demo.getByLabel("模拟策略网络失败", { exact: false }).uncheck();
  await demo.getByRole("button", { name: "同步 D6 策略" }).click();
  await expect(demo.getByTestId("d6-policy-state")).toContainText('"enabled": []');
  const off = await send();
  expect(off.diagnostic?.raw).toEqual({});
  await page.getByLabel("启用诊断采集", { exact: true }).check();
  await page.getByRole("button", { name: "保存并发布诊断策略" }).click();
  await expect(
    page.getByRole("region", { name: "诊断策略与维护" }).getByRole("status"),
  ).toContainText("发布成功");
  await demo.getByRole("button", { name: "同步 D6 策略" }).click();
  const restored = await send();
  await expect
    .poll(async () => (await detail(restored.eventId)).state, { timeout: 45000 })
    .toBe("ready");
  expect(JSON.stringify(restored.diagnostic?.raw)).toContain("D6 synthetic context");
  const viewer = await (
    await request.post("/api/auth/login", {
      data: { email: "viewer@example.invalid", password: "LocalViewer-1234" },
    })
  ).json();
  const vh = { authorization: `Bearer ${viewer.accessToken}` };
  const memberAdded = await request.put(
    `/api/projects/${project.id}/members/${viewer.user.userId}`,
    {
      headers,
      data: { role: "viewer" },
    },
  );
  expect(memberAdded.status()).toBe(200);
  expect((await request.get(root + "/settings", { headers: vh })).status()).toBe(403);
  expect(
    (
      await request.delete(root + `/instances/${first.eventId}`, { headers: vh })
    ).status(),
  ).toBe(403);
  const granted = await request.put(root + `/grants/${viewer.user.userId}`, {
    headers,
    data: { read: true, export: false },
  });
  expect(granted.status()).toBe(200);
  expect(
    (await request.get(root + `/instances/${first.eventId}`, { headers: vh })).status(),
  ).toBe(200);
  expect(
    (
      await request.put(root + "/policy", {
        headers: vh,
        data: { revision: 3, policy: initial.policy },
      })
    ).status(),
  ).toBe(403);
  await request.put(root + `/grants/${viewer.user.userId}`, {
    headers,
    data: { read: false, export: false },
  });
  expect(
    (await request.get(root + `/instances/${first.eventId}`, { headers: vh })).status(),
  ).toBe(403);
  await page.getByLabel("实例 eventId", { exact: true }).fill(first.eventId);
  await page.getByLabel("确认删除此项目此实例的原文").check();
  await page.getByRole("button", { name: "删除指定原始证据" }).click();
  await expect(
    page.getByRole("region", { name: "诊断策略与维护" }).getByRole("status"),
  ).toContainText("已逻辑删除");
  expect((await detail(first.eventId)).state).toBe("deleted");
  expect((await detail(first.eventId)).diagnostic).toBeUndefined();
  expect(
    (
      await request.post(root + `/instances/${first.eventId}/export`, {
        headers,
        data: { format: "json" },
      })
    ).status(),
  ).toBe(410);
  const replay = await request.post("/v1/events", {
    headers: { origin: "http://127.0.0.1:4174" },
    data: {
      ...firstBatch,
      sentAt: Date.now(),
      events: [first],
    },
  });
  expect(replay.status()).toBe(202);
  expect((await detail(first.eventId)).state).toBe("deleted");
  const searched = await request.post(root + "/search", {
    headers,
    data: {
      env: "dev",
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date(Date.now() + 1000).toISOString(),
      term: "D6 policy synthetic",
      field: "raw",
      category: "all",
    },
  });
  expect(searched.status()).toBe(201);
  expect(
    (await searched.json()).items.some(
      (e: { eventId: string }) => e.eventId === first.eventId,
    ),
  ).toBe(false);
  const again = await request.delete(root + `/instances/${first.eventId}`, { headers });
  expect(again.status()).toBe(200);
  const health = await (await request.get(root + "/maintenance", { headers })).json();
  expect(health.health.length).toBeGreaterThan(0);
  expect(health.diskBytes).toBeNull();
  expect(JSON.stringify(health)).not.toContain("D6 synthetic context");
  expect(JSON.stringify(health)).not.toContain("token=fixture");
  await demo.getByRole("button", { name: "销毁 D6 SDK" }).click();
  await expect(demo.getByTestId("d6-policy-state")).toContainText(
    '"sync": "destroyed"',
  );
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d6-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        projectId: project.id,
        deletedEvent: first.eventId,
        readyEvent: restored.eventId,
        viewerId: viewer.user.userId,
        policyRevision: 3,
        actualBrowser: info.project.name,
        publication: true,
        offlineServerAdmission: true,
        disableResume: true,
        health: true,
        deletion: true,
        baseEventIds: captured.map((e) => e.eventId),
      },
      null,
      2,
    ),
  );
});
