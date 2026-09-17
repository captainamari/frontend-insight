import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { OverviewResponse } from "../../../apps/web/src/overview-types";
import { defaultScoreTemplate } from "../../../packages/server-core/src/score-templates";
import { resolveProjectCalendar } from "../../../packages/event-contract/src/project-range";
import { scoreExamples } from "../../../packages/server-core/src/score-examples";
const { projectId, projectName } = JSON.parse(
  readFileSync("artifacts/r3-integration.json", "utf8"),
) as { projectId: string; projectName: string };
async function login(page: Page, role: "admin" | "viewer") {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(role + "@example.invalid");
  await page
    .getByLabel("密码")
    .fill(role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "全部项目", exact: true }),
  ).toBeVisible();
}
async function ready(page: Page) {
  await expect(
    page.getByRole("heading", { name: "项目概览", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("正在加载项目概览…", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "链路与数据状态", exact: true }),
  ).toBeVisible();
}
async function request(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, {
        method,
        headers: {
          authorization: "Bearer " + sessionStorage.getItem("fi.access-token"),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, method, body },
  );
}
for (const role of ["admin", "viewer"] as const) {
  test(`${role}: real entry, project path, five modules, public context, read-only evidence and return`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(120000);
    await login(page, role);
    await page
      .getByRole("searchbox", { name: "项目名称", exact: true })
      .fill(projectName);
    const card = page.locator(".project-entry-card").filter({ hasText: projectName });
    await expect(card).toHaveCount(1);
    const entry = page.url();
    const start = performance.now();
    await card.getByRole("button", { name: "进入项目", exact: true }).click();
    await ready(page);
    const usableMs = performance.now() - start;
    console.log(
      JSON.stringify({
        testedCommit: process.env.GITHUB_SHA,
        browserName,
        role,
        projectId,
        firstUsableMs: usableMs,
      }),
    );
    expect(new URL(page.url()).pathname).toBe(`/projects/${projectId}/overview`);
    expect(new URL(page.url()).searchParams.has("project")).toBe(false);
    const original = new URL(page.url());
    expect(original.searchParams.get("from")).toBeTruthy();
    const nav = page.getByRole("navigation", { name: "项目导航" });
    await expect(nav.getByRole("button")).toHaveCount(5);
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveCount(0);
    await expect(page.getByText("环境健康未验证", { exact: false })).toBeVisible();
    for (const [name, suffix] of [
      ["业务分析", "business"],
      ["页面分析", "pages"],
      ["设置", "settings"],
    ]) {
      await nav.getByRole("button", { name, exact: true }).click();
      expect(new URL(page.url()).pathname).toBe(`/projects/${projectId}/${suffix}`);
      await expect(
        page.getByText("当前阶段尚未开放正文功能", { exact: false }),
      ).toBeVisible();
    }
    await nav.getByRole("button", { name: "指标管理", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "指标管理", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "指标管理区域" })
      .getByRole("button", { name: "运营指标", exact: true })
      .click();
    const bindings = page.locator(".bindings");
    await bindings.locator("summary").click();
    const pvBinding = bindings.getByRole("checkbox", { name: / · pv · / });
    await expect(pvBinding).toBeChecked();
    if (role === "admin") {
      const activeBefore = await request(page, `/api/projects/${projectId}/overview`);
      const saved = page.waitForResponse(
        (r) => r.url().endsWith("/overview-bindings") && r.request().method() === "PUT",
      );
      await bindings
        .getByRole("button", { name: "保存概览展示到草稿", exact: true })
        .click();
      const savedResponse = await saved;
      expect(savedResponse.status()).toBe(200);
      const draft = await savedResponse.json();
      expect(draft.version.status).toBe("draft");
      expect(draft.metricKeys).toContain("pv");
      const activeAfter = await request(page, `/api/projects/${projectId}/overview`);
      expect(activeAfter.body.operational.version.id).toBe(
        activeBefore.body.operational.version.id,
      );
      expect(activeAfter.body.quality.version.id).toBe(
        activeBefore.body.quality.version.id,
      );
    } else {
      await expect(pvBinding).toBeDisabled();
      await expect(
        bindings.getByRole("button", { name: "保存概览展示到草稿", exact: true }),
      ).toHaveCount(0);
    }
    await nav.getByRole("button", { name: "项目概览", exact: true }).click();
    await ready(page);
    expect(new URL(page.url()).searchParams.get("from")).toBe(
      original.searchParams.get("from"),
    );
    await page.getByLabel("项目环境", { exact: true }).selectOption("dev");
    await ready(page);
    await expect(page.getByRole("region", { name: "链路与数据状态" })).toContainText(
      "dev",
    );
    const dev = page.url();
    await page.reload();
    await ready(page);
    expect(page.url()).toBe(dev);
    await page.getByLabel("选择时间范围", { exact: true }).selectOption("90d");
    await ready(page);
    await expect(page.locator(".project-window")).toContainText("week");
    await page.goBack();
    await ready(page);
    expect(page.url()).toBe(dev);
    await page.goForward();
    await ready(page);
    await expect(page.locator(".project-window")).toContainText("week");
    await page.getByLabel("选择时间范围", { exact: true }).selectOption("365d");
    await ready(page);
    await expect(page.locator(".project-window")).toContainText("month");
    await page
      .getByRole("button", { name: "查看运营分数解释与血缘", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "概览解释与证据" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "查看运营分数解释与血缘", exact: true }),
    ).toBeFocused();
    const response = await request(page, `/api/projects/${projectId}/overview`);
    expect(response.status).toBe(200);
    if (role === "viewer") {
      const forged = await request(
        page,
        `/api/projects/${projectId}/metrics/versions/${response.body.operational.version.id}/overview-bindings`,
        "PUT",
        { metricKeys: ["pv"] },
      );
      expect(forged.status).toBe(403);
      expect(forged.body.requestId).toBeTruthy();
      await expect(
        page.getByRole("button", { name: "配置概览展示指标", exact: true }),
      ).toHaveCount(0);
    }
    await page.getByRole("button", { name: "返回全部项目", exact: true }).click();
    await expect(page).toHaveURL(entry);
    await page.goto("/projects/99999999-0000-4000-8000-000000000000/overview");
    await expect(page.getByText("无项目权限", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "项目概览", exact: true }),
    ).toHaveCount(0);
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      `artifacts/r3-browser-${browserName}-${role}.json`,
      JSON.stringify({
        testedCommit: process.env.GITHUB_SHA,
        browserName,
        role,
        projectId,
        firstUsableMs: usableMs,
        scope: "real authorized entry to overview render",
        syntheticProject: true,
      }),
    );
  });

  test(`${role}: isolated normal scores, radar display, zero/null, units, evidence, stale and request races`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await login(page, role);
    const real = await request(page, `/api/projects/${projectId}/overview`);
    expect(real.status).toBe(200);
    const fixture = real.body as OverviewResponse;
    fixture.identity = "ISOLATED-R3-FIXTURE-v1";
    fixture.project.name = "隔离 fixture：非真实业务数据";
    fixture.data.reason = "ISOLATED_FIXTURE_ONLY";
    for (const type of ["operational", "quality"] as const) {
      const result = scoreExamples(defaultScoreTemplate(type).configuration).normal!;
      fixture[type].result = result as unknown as NonNullable<
        OverviewResponse[typeof type]["result"]
      >;
      fixture[type].lowest = [...result.dimensions].sort(
        (a, b) => a.score! - b.score!,
      )[0] as OverviewResponse[typeof type]["lowest"];
      fixture[type].reason = null;
    }
    const base = fixture.metrics.cards[0]!;
    fixture.metrics.cards = Array.from({ length: 6 }, (_, i) => ({
      ...base,
      definition: {
        ...base.definition,
        metricKey: `fixture_${i}`,
        displayName: `隔离指标${i}`,
        unit: i === 5 ? "milliseconds" : "views",
        businessDescription: "隔离 fixture，不来自真实业务",
      },
      value: i === 0 ? 0 : i === 1 ? null : i * 10,
      rawValue: null,
      reason: i === 1 ? "NO_EVENTS_IN_BUCKET" : null,
      status: i === 1 ? "missing" : "available",
      sampleSize: 100,
    }));
    fixture.metrics.selected = [
      "fixture_0",
      "fixture_2",
      "fixture_3",
      "fixture_4",
      "fixture_5",
    ];
    fixture.metrics.trends = fixture.query.buckets.slice(0, 4).map((b, i) => ({
      ...b,
      versionId: i < 2 ? "fixture-old" : "fixture-new",
      segment: i < 2 ? "old" : "new",
      reason: null,
      metrics: fixture.metrics.cards.map((c) => ({
        metricKey: c.definition.metricKey,
        value: i === 1 ? null : i === 0 ? 0 : i * 10,
        rawValue: null,
        sampleSize: i === 1 ? null : 100,
        status: i === 1 ? "missing" : "available",
        reason: i === 1 ? "NO_EVENTS_IN_BUCKET" : null,
      })),
    }));
    fixture.alerts = {
      status: "alerts_observed",
      reason: "ISOLATED_FIXTURE_ONLY",
      scope: { projectId, env: "prod" },
      rules: { error_spike: "隔离固定规则证据：20次" },
      items: [
        {
          id: "isolated-error",
          title: "隔离错误证据",
          evidence: "20次，隔离fixture",
          ruleKey: "error_spike",
          severity: "high",
          sample: 20,
          definitionVersion: "isolated",
          triggeredAt: fixture.query.to,
          scope: {
            projectId,
            env: "prod",
            from: fixture.query.from,
            to: fixture.query.to,
          },
          detail: { occurrences: 20, affectedUsers: 5 },
        },
      ],
    };
    fixture.alerts.items.push({
      ...fixture.alerts.items[0]!,
      id: "isolated-project-pipeline",
      title: "隔离项目级链路证据",
      scope: {
        projectId,
        env: null,
        scope: "project",
        from: fixture.query.from,
        to: fixture.query.to,
      },
    });
    let mode: "normal" | "hold" | "failure" = "normal";
    let release: (() => void) | undefined;
    let revision = 1;
    await page.route(`**/api/projects/${projectId}/overview?*`, async (route) => {
      const url = new URL(route.request().url());
      const response = structuredClone(fixture);
      response.query = resolveProjectCalendar(
        {
          range: (url.searchParams.get("range") ?? "7d") as "7d",
          env: (url.searchParams.get("env") ?? "prod") as "prod",
          from: url.searchParams.get("from") ?? fixture.query.from,
          to: url.searchParams.get("to") ?? fixture.query.to,
        },
        fixture.project.timezone,
      );
      response.identity = `ISOLATED-R3-FIXTURE-v${revision}-${response.query.env}`;
      if (revision > 1 && response.operational.version && response.operational.result) {
        response.operational.version.id = "isolated-active-v" + revision;
        response.operational.result.context.metricSetVersion =
          response.operational.version.id;
      }
      if (url.searchParams.has("metrics"))
        response.metrics.selected = url.searchParams
          .get("metrics")!
          .split(",")
          .filter(Boolean);
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      try {
        if (mode === "failure")
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              code: "R3_FIXTURE_REFRESH_FAILED",
              requestId: "r3-failure-id",
            }),
          });
        else await route.fulfill({ json: response });
      } catch {
        /* The browser may cancel an obsolete request; assertions below check identity. */
      }
    });
    await page.goto(
      `/projects/${projectId}/overview?range=7d&env=prod&from=${fixture.query.from}&to=${fixture.query.to}`,
    );
    await ready(page);
    await expect(
      page.getByRole("region", { name: "运营分数", exact: true }),
    ).toContainText("76.15");
    await expect(
      page.getByRole("region", { name: "质量分数", exact: true }),
    ).toContainText("72.95");
    await expect(page.getByRole("table", { name: "运营分数维度等价表" })).toBeVisible();
    const operational = page.getByRole("region", { name: "运营分数", exact: true });
    await expect(operational.locator("svg circle")).toHaveCount(4);
    for (const dimension of fixture.operational.result!.dimensions) {
      const row = operational
        .getByRole("row")
        .filter({ hasText: dimension.displayName });
      await expect(row.getByRole("cell").nth(1)).toHaveText(
        dimension.score!.toFixed(2),
      );
      await expect(row.getByRole("cell").nth(2)).toHaveText(
        dimension.contribution!.toFixed(2),
      );
    }
    await operational.getByText("雷达展示设置", { exact: true }).click();
    await operational.getByRole("checkbox").last().uncheck();
    await expect(page).toHaveURL(/operationalRadar=/);
    await expect(operational.locator("svg circle")).toHaveCount(3);
    await expect(operational).toContainText("76.15");
    await page.reload();
    await ready(page);
    await expect(operational).toContainText("76.15");
    const cards = page.locator(".metric-card");
    await expect(cards.first().locator("strong")).toHaveText("0");
    await expect(cards.nth(1).locator("strong")).toHaveText("—");
    await expect(
      page
        .locator(".trend-selection")
        .getByRole("checkbox", { name: "隔离指标1（views）" }),
    ).toBeDisabled();
    await expect(page.locator(".trend-group")).toHaveCount(2);
    const views = page.locator(".trend-group").first();
    await expect(views.locator("polyline")).toHaveCount(8);
    await expect(views.locator("circle")).toHaveCount(12);
    await views.locator("summary").click();
    await expect(views.getByRole("table")).toContainText("NO_EVENTS_IN_BUCKET");
    await expect(views.getByRole("table")).toContainText("fixture-old");
    await expect(views.getByRole("table")).toContainText("fixture-new");
    await page
      .getByRole("region", { name: "运营指标卡片，可用左右方向键滚动" })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.locator(".metric-scroll").evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    const button = cards.first().getByRole("button");
    await button.click();
    await expect(page.getByRole("dialog")).toContainText("fixture_0");
    await page.keyboard.press("Escape");
    await expect(button).toBeFocused();
    await page
      .locator("article")
      .filter({ hasText: "隔离错误证据" })
      .getByRole("button", { name: "查看告警证据", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("20");
    await expect(page.getByRole("dialog")).toContainText("环境 prod");
    await page.keyboard.press("Escape");
    await page
      .locator("article")
      .filter({ hasText: "隔离项目级链路证据" })
      .getByRole("button", { name: "查看告警证据", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "项目级链路证据，未验证当前环境健康",
    );
    await page.keyboard.press("Escape");
    mode = "hold";
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(
      page.getByText("正在刷新，暂保留上次数据", { exact: false }),
    ).toBeVisible();
    await expect(operational).toContainText("76.15");
    await expect.poll(() => Boolean(release)).toBe(true);
    mode = "failure";
    release!();
    await expect(page.getByRole("alert")).toContainText("r3-failure-id");
    await expect(
      page.getByText("刷新失败，保留上次数据", { exact: false }),
    ).toBeVisible();
    mode = "normal";
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await ready(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    mode = "hold";
    release = undefined;
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const oldRelease = release!;
    mode = "normal";
    await page.getByLabel("项目环境", { exact: true }).selectOption("dev");
    await ready(page);
    oldRelease();
    await expect(page.getByRole("region", { name: "链路与数据状态" })).toContainText(
      "dev",
    );
    await page.getByText("范围、来源与版本身份", { exact: true }).click();
    await expect(page.getByRole("region", { name: "链路与数据状态" })).toContainText(
      "ISOLATED-R3-FIXTURE-v1-dev",
    );

    // A new active snapshot at the same query identity must win over an older refresh.
    mode = "hold";
    release = undefined;
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const priorVersion = release!;
    revision = 2;
    mode = "normal";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(operational).toContainText("isolated-active-v2");
    priorVersion();
    await expect(operational).toContainText("isolated-active-v2");
    await expect(
      page.getByRole("region", { name: "质量分数", exact: true }),
    ).toContainText(fixture.quality.version!.id);
    // Changing context during a drill closes its old evidence; old range data cannot reappear.
    await cards.first().getByRole("button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    mode = "hold";
    release = undefined;
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const priorRange = release!;
    mode = "normal";
    await page.getByLabel("选择时间范围", { exact: true }).selectOption("30d");
    await ready(page);
    priorRange();
    await expect(page).toHaveURL(/range=30d/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await cards.first().getByRole("button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goBack();
    await ready(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await ready(page);
    // Project navigation destroys the old resource, including pending responses.
    mode = "hold";
    release = undefined;
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const priorProject = release!;
    mode = "normal";
    await page.goto("/projects/11111111-1111-4111-8111-111111111111/overview");
    await ready(page);
    priorProject();
    await expect(
      page.getByRole("region", { name: "链路与数据状态" }),
    ).not.toContainText("隔离 fixture");
  });
}
