import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { EntrySummary, EntryCard } from "../../../../apps/web/src/project-entry";
const seed = "11111111-1111-4111-8111-111111111111";
async function login(page: Page, role: "admin" | "viewer", url = "/login") {
  await page.goto(url);
  await page.getByLabel("邮箱").fill(role + "@example.invalid");
  await page
    .getByLabel("密码")
    .fill(role === "admin" ? "LocalAdmin-1234" : "LocalViewer-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}
async function ready(page: Page) {
  await expect(
    page.getByRole("heading", { name: "全部项目", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("正在加载项目…")).toHaveCount(0);
}
async function search(page: Page, text: string) {
  await page.getByRole("searchbox", { name: "项目名称", exact: true }).fill(text);
  await expect(page).toHaveURL(
    new RegExp("search=" + encodeURIComponent(text).replace(/%20/g, "(?:%20|\\+)")),
  );
  await expect(page.getByText("正在加载项目…")).toHaveCount(0);
}
async function api<T>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: T }> {
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

test("admin real login, search, paging, failed create retention, templates and project entry", async ({
  page,
  browserName,
}) => {
  test.setTimeout(120000);
  await login(page, "admin");
  await ready(page);
  await expect(page).toHaveURL(/\/projects\?/);
  await expect(page.getByLabel("选择项目", { exact: true })).toHaveCount(0);
  await search(page, "R2 入口验收");
  await expect(page.locator(".project-entry-card")).toHaveCount(12);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(".project-entry-card")).toHaveCount(8);
  await page.reload();
  await ready(page);
  await expect(page).toHaveURL(/page=2/);
  await page.getByLabel("每页项目数").selectOption("24");
  await expect(page.locator(".project-entry-card")).toHaveCount(20);
  await expect(page).toHaveURL(/page=1/);
  await page.getByLabel("每页项目数").selectOption("48");
  await expect(page.locator(".project-entry-card")).toHaveCount(20);
  await page.goBack();
  await ready(page);
  await expect(page.getByLabel("每页项目数")).toHaveValue("24");
  await page.goForward();
  await ready(page);
  await expect(page.getByLabel("每页项目数")).toHaveValue("48");
  await search(page, "不存在的项目xyz");
  await expect(page.getByRole("heading", { name: "没有符合条件的项目" })).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "项目名称", exact: true }),
  ).toHaveValue("不存在的项目xyz");
  await page.getByRole("button", { name: "清空搜索", exact: true }).first().click();
  await expect(
    page.getByRole("searchbox", { name: "项目名称", exact: true }),
  ).toHaveValue("");
  await expect(page).toHaveURL(/search=(?:&|$)/);
  await search(page, "不存在的项目xyz");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(dialog.getByLabel("项目名称", { exact: true })).toBeFocused();
  const name = "R2 浏览器新项目 " + browserName + Date.now();
  await dialog.getByLabel("项目名称", { exact: true }).fill(name);
  await dialog.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await dialog.getByLabel("允许 Origin").fill("https://example.com/path");
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("项目名称", { exact: true })).toHaveValue(name);
  await dialog.getByLabel("允许 Origin").fill("http://localhost:5173");
  let failed = false;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TEST_NETWORK_FAILURE",
          requestId: "r2-test-only",
        }),
      });
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("TEST_NETWORK_FAILURE");
  await expect(dialog.getByLabel("项目名称", { exact: true })).toHaveValue(name);
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".located")).toBeFocused();
  await expect(
    page.getByRole("searchbox", { name: "项目名称", exact: true }),
  ).toHaveValue(name);
  const card = page.locator(".located"),
    id = (await card.getAttribute("id"))!.replace("project-", "");
  await expect(card.locator(".entry-score strong")).toHaveText(["—", "—"]);
  const op = await api<{ id: string; status: string }[]>(
      page,
      `/api/projects/${id}/metrics/versions?type=operational`,
    ),
    quality = await api<{ id: string; status: string }[]>(
      page,
      `/api/projects/${id}/metrics/versions?type=quality`,
    );
  expect(op.body[0]!.status).toBe("draft");
  expect(quality.body[0]!.status).toBe("draft");
  expect(op.body[0]!.id).not.toBe(quality.body[0]!.id);
  const entryUrl = page.url();
  await card.getByRole("button", { name: "进入项目", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}/metrics`));
  await expect(
    page.getByRole("heading", { name: "分数管理", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/env=prod/);
  await page.getByRole("button", { name: "返回全部项目", exact: true }).click();
  await expect(page).toHaveURL(entryUrl);
  await ready(page);
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeFocused();
});
test("viewer real authorized search, denied direct project, forged create, safe deep link and root", async ({
  page,
}) => {
  await login(
    page,
    "viewer",
    `/login?redirect=${encodeURIComponent(`/projects/${seed}/metrics?tab=scores&env=dev`)}`,
  );
  await expect(page).toHaveURL(/\/metrics\?/);
  await expect(page).toHaveURL(/env=dev/);
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("button", { name: "新建项目" })).toHaveCount(0);
  await search(page, "R2 入口验收");
  await expect(page.locator(".project-entry-card")).toHaveCount(12);
  const forged = await api(page, "/api/projects", "POST", {
    name: "forged",
    timezone: "UTC",
    origins: ["https://example.com"],
  });
  expect(forged.status).toBe(403);
  await search(page, "R2 secret");
  await expect(page.getByRole("heading", { name: "没有符合条件的项目" })).toBeVisible();
  await page.goto("/projects/99999999-0000-4000-8000-000000000000/metrics");
  await expect(page.getByRole("heading", { name: "无项目权限" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "指标管理", exact: true }),
  ).toHaveCount(0);
  await page.goto("/login");
  await ready(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await login(page, "viewer", "/login?redirect=https%3A%2F%2Fevil.example");
  await ready(page);
  expect(new URL(page.url()).pathname).toBe("/projects");
});
test("request generations isolate delayed search and env responses", async ({
  page,
}) => {
  await login(page, "admin");
  await ready(page);
  let held: (() => void) | undefined;
  let oldStarted: (() => void) | undefined;
  let completed: (() => void) | undefined;
  const done = new Promise<void>((r) => (completed = r));
  const start = new Promise<void>((r) => (oldStarted = r));
  const hold = new Promise<void>((r) => (held = r));
  await page.route("**/api/projects/summary?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("search") === "旧搜索") {
      const result = await route.fetch();
      oldStarted?.();
      await hold;
      await route.fulfill({ response: result });
      completed?.();
    } else await route.continue();
  });
  await page.getByRole("searchbox", { name: "项目名称", exact: true }).fill("旧搜索");
  await start;
  await search(page, "R2 入口验收");
  await page.getByLabel("环境", { exact: true }).selectOption("staging");
  await expect(page).toHaveURL(/env=staging/);
  await ready(page);
  held?.();
  await done;
  await expect(
    page.getByRole("searchbox", { name: "项目名称", exact: true }),
  ).toHaveValue("R2 入口验收");
  await expect(page.locator(".project-entry-card")).toHaveCount(12);
  await expect(page.getByText("没有符合条件的项目")).toHaveCount(0);
});
test("isolated old active-version response cannot overwrite a newer env and page selection", async ({
  page,
}) => {
  await login(page, "admin");
  await ready(page);
  const real = (await api<EntrySummary>(page, "/api/projects/summary")).body;
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const held = new Promise<void>((r) => (release = r)),
    pending = new Promise<void>((r) => (started = r));
  let completed: (() => void) | undefined;
  const done = new Promise<void>((r) => (completed = r));
  let first = true;
  await page.route("**/api/projects/summary?**", async (route) => {
    const old = first;
    first = false;
    const q = new URL(route.request().url()).searchParams;
    const body = structuredClone(real);
    body.page = Number(q.get("page") ?? 1);
    body.total = 24;
    body.query.env = q.get("env") ?? "prod";
    body.items = [structuredClone(real.items[0]!)];
    const card = body.items[0]!;
    card.name = "合成版本响应隔离";
    card.operational.version = old ? 101 : 102;
    card.operational.versionId = old ? "isolated-old-op" : "isolated-new-op";
    card.quality.version = 201;
    card.quality.versionId = "isolated-quality";
    if (old) {
      started?.();
      await held;
    }
    await route.fulfill({ json: body });
    if (old) completed?.();
  });
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await pending;
  await page.getByLabel("环境", { exact: true }).selectOption("dev");
  await expect(page.getByRole("heading", { name: "合成版本响应隔离" })).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  release?.();
  await done;
  await expect(page.locator(".project-entry-card")).toContainText("102");
  await expect(page.locator(".project-entry-card")).toContainText("201");
  await expect(page.locator(".project-entry-card")).not.toContainText("101");
  await expect(page.getByLabel("环境", { exact: true })).toHaveValue("dev");
});
test("300ms debounce, loading, error retry and controlled visual state fixtures", async ({
  page,
}) => {
  await login(page, "admin");
  await ready(page);
  const real = await api<EntrySummary>(page, "/api/projects/summary");
  expect(real.status).toBe(200);
  const template = real.body.items[0]!;
  function fixture(
    value: number | null,
    pipeline: string,
    reason: string,
    name: string,
  ): EntryCard {
    const card = structuredClone(template);
    card.id = crypto.randomUUID();
    card.name = name;
    card.operational = {
      ...card.operational,
      value,
      status: value === null ? "unavailable" : "available",
      color:
        value === null
          ? "gray"
          : value >= 85
            ? "green"
            : value >= 60
              ? "yellow"
              : "red",
      reasons: reason ? [reason] : [],
      versionId: "fixture-op",
      version: 1,
    };
    card.quality = {
      ...card.operational,
      scoreKey: "quality_score",
      versionId: "fixture-quality",
    };
    card.pipeline.state = pipeline;
    card.state =
      pipeline === "broken" || pipeline === "delayed" || (value !== null && value <= 80)
        ? "alert"
        : reason === "MISSING_CONFIGURATION"
          ? "missing_configuration"
          : value !== null && pipeline === "healthy"
            ? "normal"
            : "insufficient_data";
    card.reasons = reason ? [reason] : [];
    card.data.reason = reason;
    card.data.state =
      reason === "FIRST_NOT_CONNECTED" || reason === "NO_EVENTS_IN_RANGE"
        ? "no_data"
        : "partial";
    return card;
  }
  const cards = [
    fixture(0, "healthy", "", "合成真实零"),
    fixture(60, "healthy", "", "合成六十"),
    fixture(80, "healthy", "", "合成八十"),
    fixture(80.01, "healthy", "", "合成略高八十"),
    fixture(85, "healthy", "", "合成八十五"),
    fixture(null, "no_data", "MISSING_CONFIGURATION", "合成待配置"),
    fixture(null, "unknown", "SCORE_MINIMUM_SAMPLE_NOT_MET", "合成样本不足"),
    fixture(null, "broken", "MISSING_CONFIGURATION", "合成链路异常"),
    fixture(null, "delayed", "INGESTION_BEHIND_RECEIVE", "合成链路延迟"),
    fixture(null, "unknown", "NO_EVENTS_IN_RANGE", "合成范围无访问"),
    fixture(null, "no_data", "FIRST_NOT_CONNECTED", "合成首次未接入"),
    fixture(null, "unknown", "ENV_EXPOSURE_NOT_VERIFIED", "合成部分事实"),
  ];
  let requests = 0,
    fail = true;
  await page.route("**/api/projects/summary?**", async (route) => {
    requests++;
    if (fail) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "R2_TEST_FAILURE",
          requestId: "isolated-fixture",
        }),
      });
      return;
    }
    const q = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: {
        ...real.body,
        items: cards,
        total: cards.length,
        page: 1,
        search: q.get("search") ?? "",
        query: { ...real.body.query, env: q.get("env") ?? "prod" },
      },
    });
  });
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目加载失败" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "合成真实零" })).toBeVisible();
  for (const [name, color, value, state] of [
    ["合成真实零", "red", "0.00", "告警"],
    ["合成六十", "yellow", "60.00", "告警"],
    ["合成八十", "yellow", "80.00", "告警"],
    ["合成略高八十", "yellow", "80.01", "正常"],
    ["合成八十五", "green", "85.00", "正常"],
    ["合成待配置", "gray", "—", "待配置"],
  ]) {
    const card = page.getByRole("article", { name: name!, exact: true });
    await expect(card.locator(".entry-score").first()).toHaveClass(new RegExp(color!));
    await expect(card.locator(".entry-score strong").first()).toHaveText(value!);
    await expect(card.locator(".project-state")).toHaveText(state!);
  }
  const before = requests;
  await page.clock.install();
  await page.getByRole("searchbox", { name: "项目名称", exact: true }).fill("中");
  await page.clock.fastForward(100);
  await page.getByRole("searchbox", { name: "项目名称", exact: true }).fill("中文");
  await page.clock.fastForward(299);
  expect(requests).toBe(before);
  await page.clock.fastForward(1);
  await expect.poll(() => requests).toBe(before + 1);
  await page.screenshot({
    path: `test-results/r2-${test.info().project.name}-fixture-cards.png`,
    fullPage: true,
  });
});
test("20 project first usable browser p95 including navigation, script and single summary", async ({
  page,
  browserName,
  browser,
}) => {
  test.setTimeout(120000);
  await login(page, "viewer");
  await ready(page);
  const times: number[] = [],
    requests: number[] = [];
  for (let i = 0; i < 23; i++) {
    let count = 0;
    const listener = (r: { url: () => string }) => {
      if (r.url().includes("/api/projects/summary?")) count++;
    };
    page.on("request", listener);
    const start = Date.now();
    await page.goto(
      "/projects?search=" +
        encodeURIComponent("R2 入口验收") +
        "&page=1&pageSize=24&env=prod&range=7d&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-08T00%3A00%3A00.000Z",
    );
    await expect(page.locator(".project-entry-card")).toHaveCount(20);
    await expect(page.locator(".enter-project").first()).toBeEnabled();
    if (i >= 3) {
      times.push(Date.now() - start);
      requests.push(count);
    }
    page.off("request", listener);
  }

  const sorted = [...times].sort((a, b) => a - b),
    p95 = sorted[Math.ceil(times.length * 0.95) - 1]!;

  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r2-browser-performance-${browserName}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: browserName,
        browserVersion: browser.version(),
        viewport: page.viewportSize(),
        projects: 20,
        pageSize: 24,
        method:
          "3 warmups + 20 full navigations, all 20 cards usable; nearest-rank p95",
        durationsMs: times,
        summaryRequests: requests,
        p95Ms: p95,
        passed: p95 <= 2000,
      },
      null,
      2,
    ),
  );
  expect(requests.every((n) => n === 1)).toBe(true);
  console.log(
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      browser: browserName,
      p95Ms: p95,
      durationsMs: times,
      summaryRequests: requests,
    }),
  );
  expect(p95).toBeLessThanOrEqual(2000);
});
