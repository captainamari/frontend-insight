import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { BusinessResponse } from "../../../apps/web/src/business-types";
const evidence = JSON.parse(readFileSync("artifacts/r4a-integration.json", "utf8")) as {
  project: { id: string; name: string };
  moduleId: string;
  alternateModuleId: string;
  query: Record<string, string>;
  versions: { operational: string };
};
const projectId = evidence.project.id;
const url = `/projects/${projectId}/business?` + new URLSearchParams(evidence.query);
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
    page.getByRole("heading", { name: "业务分析", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新业务分析", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("工作流事实将在 R4-B 接入", { exact: true }),
  ).toBeVisible();
}
async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const r = await fetch(path, {
        method,
        headers: {
          authorization: "Bearer " + sessionStorage.getItem("fi.access-token"),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, method, body },
  );
}
for (const role of ["admin", "viewer"] as const)
  test(`${role}: entry overview business definition and return context`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(120000);
    await login(page, role);
    await page
      .getByRole("searchbox", { name: "项目名称", exact: true })
      .fill(evidence.project.name);
    const card = page
      .locator(".project-entry-card")
      .filter({ hasText: evidence.project.name });
    await expect(card).toHaveCount(1);
    const entry = page.url();
    await card.getByRole("button", { name: "进入项目", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "项目概览", exact: true }),
    ).toBeVisible();
    const nav = page.getByRole("navigation", { name: "项目导航" });
    await expect(nav.getByRole("button")).toHaveCount(5);
    const start = Date.now();
    await nav.getByRole("button", { name: "业务分析", exact: true }).click();
    await ready(page);
    const firstUsableMs = Date.now() - start;
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/business`));
    const defaultModule = new URL(page.url()).searchParams.get("moduleId");
    expect([evidence.moduleId, evidence.alternateModuleId]).toContain(defaultModule);
    await expect(page.getByLabel("功能模块", { exact: true })).toHaveValue(
      defaultModule!,
    );
    await page.getByLabel("功能模块", { exact: true }).selectOption(evidence.moduleId);
    await ready(page);
    await expect(page.getByLabel("功能模块", { exact: true })).toHaveValue(
      evidence.moduleId,
    );
    await page.getByRole("button", { name: "返回全部项目", exact: true }).click();
    await expect(page).toHaveURL(entry);
    await page.goto(url);
    await ready(page);
    await expect(page.locator(".cards article")).toHaveCount(3);
    await page.getByLabel("显示观察值趋势（非正式指标）", { exact: true }).check();
    await expect(page).toHaveURL(/businessValues=observed/);
    await page.goBack();
    await ready(page);
    await expect(
      page.getByLabel("显示观察值趋势（非正式指标）", { exact: true }),
    ).not.toBeChecked();
    await page.getByLabel("项目环境", { exact: true }).selectOption("dev");
    await ready(page);
    await expect(page).toHaveURL(/env=dev/);
    await page.goBack();
    await ready(page);
    await expect(page).toHaveURL(/env=prod/);
    await page
      .getByLabel("功能模块", { exact: true })
      .selectOption(evidence.alternateModuleId);
    await ready(page);
    await expect(page).toHaveURL(new RegExp("moduleId=" + evidence.alternateModuleId));
    await page.goBack();
    await ready(page);
    await expect(page.getByLabel("功能模块", { exact: true })).toHaveValue(
      evidence.moduleId,
    );
    const analysis = page.url();
    await page.locator(".cards article").first().getByRole("button").click();
    await expect(page.getByRole("dialog", { name: "模块指标解释" })).toBeVisible();
    await page.getByRole("button", { name: "进入对应指标定义与版本" }).click();
    await expect(
      page.getByRole("heading", { name: "指标管理", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("metric-library")).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "指标定义", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("metric-definition")).toContainText("pv");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "指标定义", exact: true }),
    ).not.toBeVisible();
    const binding = page
      .locator(".bindings")
      .filter({ hasText: "业务分析展示指标（版本化）" });
    await binding.locator("summary").click();
    if (role === "viewer") {
      await expect(
        binding.getByRole("button", { name: "保存业务分析展示到草稿", exact: true }),
      ).toHaveCount(0);
      const forged = await api(
        page,
        `/api/projects/${projectId}/metrics/versions/${evidence.versions.operational}/business-bindings`,
        "PUT",
        { metricKeys: ["pv"] },
      );
      expect(forged.status).toBe(403);
    }
    await page.getByRole("button", { name: "返回原业务分析", exact: true }).click();
    await ready(page);
    await expect(page).toHaveURL(analysis);
    await page.reload();
    await ready(page);
    await expect(page.getByLabel("功能模块", { exact: true })).toHaveValue(
      evidence.moduleId,
    );
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      `artifacts/r4a-browser-${browserName}-${role}.json`,
      JSON.stringify({
        testedCommit: process.env.GITHUB_SHA,
        role,
        browserName,
        firstUsableMs,
        source: "real integration fixture project, no production capacity claim",
      }),
    );
  });
test("isolated normal values null zero version gaps keyboard stale retry and permission revocation", async ({
  page,
}) => {
  await login(page, "viewer");
  await page.goto(url);
  await ready(page);
  const real = (
    await api(
      page,
      `/api/projects/${projectId}/business?` + new URLSearchParams(evidence.query),
    )
  ).body as BusinessResponse;
  const fixture = structuredClone(real);
  fixture.identity = "explicit-isolated-r4a-fixture";
  fixture.metrics.cards = Array.from({ length: 6 }, (_, i) => ({
    ...real.metrics.cards[0]!,
    definition: {
      ...real.metrics.cards[0]!.definition,
      metricKey: "fixture_" + i,
      displayName: "隔离模块指标" + i,
      unit: i === 5 ? "milliseconds" : "views",
    },
    value: i === 0 ? 0 : i === 1 ? null : i * 10,
    rawValue: null,
    reason: i === 1 ? "NOT_COLLECTED" : null,
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
  fixture.metrics.trends = Array.from({ length: 3 }, (_, i) => ({
    ...fixture.metrics.trends[0]!,
    from: new Date(Date.UTC(2026, 8, 15 + i)).toISOString(),
    to: new Date(Date.UTC(2026, 8, 16 + i)).toISOString(),
    segment: i === 2 ? "new-segment" : "old-segment",
    metrics: fixture.metrics.selected.map((k) => ({
      metricKey: k,
      value: i === 1 ? null : 0,
      rawValue: null,
      status: i === 1 ? "missing" : "available",
      sampleSize: 100,
      reason: i === 1 ? "GAP" : null,
    })),
  }));
  let failure = false;
  await page.route("**/api/projects/*/business?**", async (r) => {
    if (failure)
      await r.fulfill({
        status: 503,
        json: { code: "FACT_STORE_UNAVAILABLE", requestId: "isolated" },
      });
    else await r.fulfill({ json: fixture });
  });
  await page.getByRole("button", { name: "刷新业务分析", exact: true }).click();
  await ready(page);
  await expect(page.locator(".cards article")).toHaveCount(6);
  await expect(page.locator(".cards article").first()).toContainText("0 views");
  await expect(page.locator(".cards article").nth(1)).toContainText("— views");
  const cards = page.getByRole("region", { name: "模块指标卡片" });
  await cards.focus();
  await page.keyboard.press("End");
  await expect.poll(() => cards.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  await page.getByText("views 趋势等价表与缺口原因", { exact: true }).click();
  await expect(page.getByText("GAP", { exact: true }).first()).toBeVisible();
  failure = true;
  await page.getByRole("button", { name: "刷新业务分析", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("FACT_STORE_UNAVAILABLE");
  await expect(page.getByText("stale：", { exact: false })).toBeVisible();
  failure = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await ready(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/api/projects/*/business?**");
  await page.route("**/api/projects/*/business?**", (r) =>
    r.fulfill({
      status: 403,
      json: { code: "PROJECT_FORBIDDEN", requestId: "isolated-denied" },
    }),
  );
  await page.getByRole("button", { name: "刷新业务分析", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "无项目权限", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("隔离模块指标0", { exact: true })).toHaveCount(0);
});
test("late responses cannot overwrite a changed env or an open drill context", async ({
  page,
}) => {
  await login(page, "viewer");
  await page.goto(url);
  await ready(page);
  await page.getByLabel("项目环境", { exact: true }).selectOption("dev");
  await ready(page);
  await page.goBack();
  await ready(page);
  let release: () => void = () => {},
    started: () => void = () => {},
    completed: () => void = () => {};
  const hold = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (started = r)),
    done = new Promise<void>((r) => (completed = r));
  let first = true;
  await page.route("**/api/projects/*/business?**", async (route) => {
    const old = first;
    first = false;
    const response = await route.fetch();
    if (old) {
      started();
      await hold;
    }
    try {
      await route.fulfill({ response });
    } finally {
      if (old) completed();
    }
  });
  await page.getByRole("button", { name: "刷新业务分析", exact: true }).click();
  await start;
  await page.locator(".cards article").first().getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "模块指标解释" })).toBeVisible();
  await page.goForward();
  await ready(page);
  await expect(page.getByRole("dialog", { name: "模块指标解释" })).not.toBeVisible();
  release();
  await done;
  await expect(page).toHaveURL(/env=dev/);
  await expect(page.getByText("所选范围无事实", { exact: false })).toBeVisible();
});
