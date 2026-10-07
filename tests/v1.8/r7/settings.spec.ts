import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, totalmem, platform, arch } from "node:os";

test("R7 real SDK, collector, storage, settings permissions and external credential lifecycle", async ({
  page,
  request,
  browser,
}, info) => {
  test.setTimeout(240000);
  const login = async (role: string) =>
    await (
      await request.post("/api/auth/login", {
        data: {
          email: role + "@example.invalid",
          password: role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234",
        },
      })
    ).json();
  const admin = await login("admin"),
    viewer = await login("viewer"),
    headers = { authorization: `Bearer ${admin.accessToken}` },
    vh = { authorization: `Bearer ${viewer.accessToken}` };
  const created = await request.post("/api/projects", {
    headers,
    data: {
      name: `R7 TEST ONLY ${info.project.name} ${randomUUID()}`,
      timezone: "Asia/Shanghai",
      origins: ["http://127.0.0.1:4173"],
    },
  });
  expect(created.status()).toBe(201);
  const project = await created.json(),
    root = `/api/projects/${project.id}`,
    settings = root + "/settings";
  const other = await (
    await request.post("/api/projects", {
      headers,
      data: {
        name: `R7 other ${randomUUID()}`,
        timezone: "UTC",
        origins: ["http://127.0.0.1:4173"],
      },
    })
  ).json();
  expect(
    (
      await request.put(root + `/members/${viewer.user.userId}`, {
        headers,
        data: { role: "viewer" },
      })
    ).status(),
  ).toBe(200);
  const from = new Date(Date.now() - 3600000).toISOString(),
    to = () => new Date(Date.now()).toISOString();
  expect(
    (await request.get(settings + "/export-interfaces", { headers })).status(),
  ).toBe(200);
  expect(
    (await (await request.get(settings + "/export-interfaces", { headers })).json())
      .items,
  ).toEqual([]);
  expect(
    (
      await request.get(`/api/projects/${other.id}/settings/integration`, {
        headers: vh,
      })
    ).status(),
  ).toBe(403);
  for (const path of ["/export-interfaces", "/abnormal-rules", "/test-event"])
    expect(
      (await request.post(settings + path, { headers: vh, data: {} })).status(),
    ).toBe(403);
  expect(
    (
      await request.put(settings + "/probe-versions", { headers: vh, data: {} })
    ).status(),
  ).toBe(403);
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/projects/);
  const url = `/projects/${project.id}/settings?env=dev&range=7d&tab=integration`;
  await page.goto(url);
  await expect(page.getByTestId("settings-app-id")).toHaveText(project.appId);
  await page.getByRole("button", { name: "发送测试事件", exact: true }).click();
  await expect(page.getByTestId("test-receipt")).toContainText("可查询：已证实", {
    timeout: 35000,
  });
  const snippet = await page.getByTestId("settings-snippet").innerText();
  expect(snippet).toContain('env: "dev"');
  expect(snippet).toContain("/api/sdk/0.8.0/index.js");
  expect(snippet).not.toContain("setAccount");
  // Only the host business script is test-served; the SDK, collector, Kafka, storage and APIs are real.
  await page.route("**/r7-host-snippet.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: snippet + "\nwindow.r7Tracker=tracker;",
    }),
  );
  const sent = page.waitForResponse(
    (r) =>
      r.url().endsWith("/v1/events") &&
      r.request().method() === "POST" &&
      r.status() === 202,
    { timeout: 15000 },
  );
  await page.addScriptTag({ url: "/r7-host-snippet.js", type: "module" });
  await sent;
  await expect
    .poll(async () => {
      const d = await (
        await request.get(
          settings +
            "/probe-versions?" +
            new URLSearchParams({ env: "dev", range: "custom", from, to: to() }),
          { headers },
        )
      ).json();
      return d.denominator;
    })
    .toBeGreaterThanOrEqual(2);
  const policy = {
    version: "0.8.0",
    status: "blocked",
    contractVersion: 3,
    releaseNotes: "TEST ONLY block fixture",
    upgradeAdvice: "TEST ONLY restore supported",
    confirmBlocked: false,
  };
  expect(
    (
      await request.put(settings + "/probe-versions", { headers, data: policy })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.put(settings + "/probe-versions", {
        headers,
        data: { ...policy, confirmBlocked: true },
      })
    ).status(),
  ).toBe(200);
  const now = Date.now(),
    eventId = "evt_" + randomUUID().replaceAll("-", "");
  const batch = {
    schemaVersion: 3,
    sentAt: now,
    sdk: { name: "r7-test", version: "0.8.0" },
    events: [
      {
        eventId,
        event: "page_view",
        appId: project.appId,
        env: "dev",
        release: "r7-fixture",
        timestamp: now,
        pageUrl: "http://127.0.0.1:4173/r7-test",
        pageRoute: "/r7-test",
        userId: null,
        deptId: null,
        roleId: null,
        deviceId: "dev_" + randomUUID().replaceAll("-", ""),
        sessionId: "ses_" + randomUUID().replaceAll("-", ""),
        pageViewId: "pv_" + randomUUID().replaceAll("-", ""),
        ua: "Other",
        os: "Other",
        browser: "Other",
        payload: {},
      },
    ],
  };
  const ingest = () =>
    request.post("/v1/events", {
      headers: { origin: "http://127.0.0.1:4173" },
      data: batch,
    });
  expect((await ingest()).status()).toBe(403);
  expect(
    (
      await request.put(settings + "/probe-versions", {
        headers,
        data: { ...policy, status: "supported", confirmBlocked: false },
      })
    ).status(),
  ).toBe(200);
  expect((await ingest()).status()).toBe(202);
  expect((await ingest()).status()).toBe(202);
  // Real registered operation facts for the approved TEST ONLY investigation fixture.
  expect(
    (
      await request.post(root + "/features", {
        headers,
        data: {
          featureKey: "r7_action",
          name: "R7 fixture operation",
          featureType: "action",
          operationLifecycleEnabled: true,
        },
      })
    ).status(),
  ).toBe(201);
  await page.evaluate(async (appId) => {
    const modulePath = "/api/sdk/0.8.0/index.js";
    const { createTracker } = await import(modulePath);
    const t = createTracker({
      appId,
      env: "dev",
      release: "r7-operations",
      endpoint: location.origin + "/v1/events",
      registeredFeatures: ["r7_action"],
      normalizePageRoute: () => "/r7-operation",
    });
    t.setUser("u_r7testopaqueidentity000001");
    t.startOperation("r7_action").succeed();
    t.startOperation("r7_action").succeed();
    await t.flush();
    t.destroy();
  }, project.appId);
  const scope = {
    env: "dev",
    from,
    to: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    maxRangeDays: 2,
    rateLimit: 600,
  };
  const issued: Record<string, { id: string; token: string }> = {};
  for (const kind of [
    "metric_snapshot",
    "metric_trend",
    "quality_summary",
    "prometheus",
  ]) {
    const r = await request.post(settings + "/export-interfaces", {
      headers,
      data: { kind, scope },
    });
    expect(r.status()).toBe(201);
    const item = await r.json();
    expect(item.enabled).toBe(false);
    const enable = await request.post(
      settings + `/export-interfaces/${item.id}/enable`,
      { headers, data: {} },
    );
    expect(enable.status()).toBe(201);
    const credential = await enable.json();
    expect(credential.shownOnce).toBe(true);
    expect(credential.token).toMatch(/^fi_/);
    issued[kind] = { id: item.id, token: credential.token };
  }
  const external = (
    kind: string,
    token = issued[kind]!.token,
    pid = project.id,
    extra: Record<string, string> = {},
  ) =>
    request.get(
      `/api/external/projects/${pid}/${kind}?` +
        new URLSearchParams({ env: "dev", from, to: to(), ...extra }),
      { headers: { authorization: `Bearer ${token}` } },
    );
  for (const kind of Object.keys(issued)) {
    const r = await external(kind);
    expect(r.status(), kind).toBe(200);
    expect(r.headers()["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
    const text = await r.text();
    if (kind === "prometheus") {
      expect(r.headers()["content-type"]).toContain("text/plain");
      expect(text).toContain("frontend_insight_score_available");
      expect(text).not.toMatch(/pageRoute|userId|account|error.message/);
      for (const labels of text.matchAll(/\{([^}]+)\}/g))
        for (const label of labels[1]!.split(","))
          expect(["service", "env", "state", "type"]).toContain(label.split("=")[0]);
    } else {
      const d = JSON.parse(text);
      expect(d.projectId).toBe(project.id);
      expect(d).toHaveProperty("version");
    }
  }
  expect(
    (
      await external("metric_snapshot", issued.metric_snapshot!.token, other.id)
    ).status(),
  ).toBe(401);
  expect((await external("metric_snapshot", project.appId)).status()).toBe(401);
  expect(
    (
      await external("metric_snapshot", issued.metric_snapshot!.token, project.id, {
        env: "prod",
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await external("metric_snapshot", issued.metric_snapshot!.token, project.id, {
        from: new Date(Date.parse(from) - 86400000).toISOString(),
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await external("metric_snapshot", issued.metric_snapshot!.token, project.id, {
        sql: "SELECT secret",
      })
    ).status(),
  ).toBe(400);
  const target = issued.metric_snapshot!;
  const rotate = await request.post(
    settings + `/export-interfaces/${target.id}/rotate`,
    { headers, data: {} },
  );
  expect(rotate.status()).toBe(201);
  const next = await rotate.json();
  expect((await external("metric_snapshot", target.token)).status()).toBe(403);
  target.token = next.token;
  expect((await external("metric_snapshot")).status()).toBe(200);
  const listing = await (
    await request.get(settings + "/export-interfaces", { headers })
  ).text();
  expect(listing).not.toContain(target.token);
  expect(listing).not.toContain("token_hash");
  expect(
    (
      await request.post(settings + `/export-interfaces/${target.id}/rotate`, {
        headers: vh,
        data: {},
      })
    ).status(),
  ).toBe(403);
  for (const action of ["disable", "revoke"]) {
    expect(
      (
        await request.post(settings + `/export-interfaces/${target.id}/${action}`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(201);
    expect((await external("metric_snapshot")).status()).toBe(403);
  }
  // Test approval is explicit, attached only to this isolated TEST ONLY project.
  const config = {
    env: "dev",
    threshold: 2,
    minimumSample: 2,
    baselineDays: 7,
    minimumBaselineDays: 2,
    multiplier: 2,
    workStart: 9,
    workEnd: 18,
    workDays: [(new Date().getUTCDay() + 3) % 7],
    visibleRoles: ["owner"],
    sharedSubjects: [],
    exceptions: [],
  };
  for (const key of [
    "outside_hours",
    "historical_volume",
    "multi_device",
    "multi_ip",
    "permission_denied",
  ]) {
    const r = await request.post(settings + "/abnormal-rules", {
      headers,
      data: { ruleKey: key, config },
    });
    expect(r.status()).toBe(201);
    const rule = await r.json();
    expect(
      (
        await request.post(settings + `/abnormal-rules/${rule.id}/enable`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.post(settings + `/abnormal-rules/${rule.id}/approve`, {
          headers,
          data: {
            managementApprover: "TEST FIXTURE MANAGEMENT",
            securityApprover: "TEST FIXTURE SECURITY",
            approvedAt: to(),
            source: "TEST ONLY automated fixture; not real approval",
            attested: true,
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await request.post(settings + `/abnormal-rules/${rule.id}/enable`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(201);
  }
  const ev = await (
    await request.get(settings + "/abnormal-evidence?env=dev&range=7d&export=json", {
      headers,
    })
  ).json();
  expect(ev.items).toHaveLength(5);
  expect(
    ev.items.filter((i: { status: string }) => i.status === "not_collected"),
  ).toHaveLength(2);
  await expect
    .poll(async () => {
      const observed = await (
        await request.get(settings + "/abnormal-evidence?env=dev&range=7d", { headers })
      ).json();
      return observed.items
        .find((v: { ruleKey: string }) => v.ruleKey === "outside_hours")
        ?.items?.some((v: { status: string }) => v.status === "hit");
    })
    .toBe(true);
  const viewerEvidence = await (
    await request.get(settings + "/abnormal-evidence?env=dev&range=7d&export=json", {
      headers: vh,
    })
  ).json();
  expect(viewerEvidence.items).toEqual([]);
  const audit = await (await request.get(settings + "/audit", { headers })).text();
  expect(audit).toContain("abnormal.export");
  expect(audit).not.toContain(target.token);
  expect(JSON.parse(audit).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "abnormal.export",
        metadata: expect.objectContaining({ state: "NO_VISIBLE_APPROVED_RULE" }),
      }),
    ]),
  );
  // URL context, reload, latest project wins; data endpoints are never mocked.
  await page.goto(url.replace("tab=integration", "tab=probes"));
  await page.reload();
  await expect(page.getByText("实际观测版本", { exact: true })).toBeVisible();
  await page.goto(`/projects/${other.id}/settings?env=staging&range=7d`);
  await page.goto(url);
  await expect(page.getByTestId("settings-app-id")).toHaveText(project.appId);
  await page.getByRole("tab", { name: "接口管理", exact: true }).click();
  await page.getByRole("button", { name: "启用", exact: true }).first().click();
  await expect(page.getByTestId("issued-token")).toBeVisible();
  await page.getByRole("button", { name: "隐藏凭证", exact: true }).click();
  await expect(page.getByTestId("issued-token")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("issued-token")).toHaveCount(0);
  const vc = await browser.newContext(),
    vp = await vc.newPage();
  await vp.goto("http://127.0.0.1:4173/login");
  await vp.getByLabel("邮箱").fill("viewer@example.invalid");
  await vp.getByLabel("密码").fill("LocalViewer-1234");
  await vp.getByRole("button", { name: "登录", exact: true }).click();
  await expect(vp).toHaveURL(/projects/);
  await vp.goto("http://127.0.0.1:4173" + url);
  await expect(vp.getByTestId("settings-app-id")).toHaveText(project.appId);
  await expect(
    vp.getByRole("button", { name: "发送测试事件", exact: true }),
  ).toHaveCount(0);
  await expect(
    vp.getByRole("button", { name: "保存项目配置", exact: true }),
  ).toHaveCount(0);
  await vc.close();
  const samples: number[] = [];
  let statistics: unknown;
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    const r = await request.get(settings + "/probe-versions?env=dev&range=7d", {
      headers,
    });
    expect(r.status()).toBe(200);
    const d = await r.json();
    statistics = d.statistics;
    if (i >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r7-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        browser: info.project.name,
        realServices: true,
        sdkSnippetExecuted: true,
        acceptedStoredQueryable: true,
        blockedCollector: true,
        warmups: 5,
        sampleCount: 20,
        p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
        statistics,
        environment: {
          platform: platform(),
          arch: arch(),
          cpus: cpus().length,
          memoryBytes: totalmem(),
        },
        ruleApproval: "test fixture only",
        missingFacts: ["multi_ip", "permission_denied"],
      },
      null,
      2,
    ),
  );
});
