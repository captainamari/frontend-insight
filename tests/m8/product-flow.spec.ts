import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.M5_WEB_URL ?? "http://127.0.0.1:4173";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";
const projectId = "11111111-1111-4111-8111-111111111111";

async function login(page: Page): Promise<void> {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "全部项目" })).toBeVisible();
  await page.goto(
    `${webUrl}/projects/${projectId}/page-analysis/errors?range=7d`,
  );
}

test("viewer can triage errors, Web Vitals, releases and fixed alerts", async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "页面分析" })).toBeVisible();
  await expect(page.getByText("项目运营指数仍为 v1")).toBeVisible();
  await expect(page.getByText("SourceMap 暂未启用")).toBeVisible();
  await expect(page.getByText("错误发生次数")).toBeVisible();
  await expect(page.getByRole("heading", { name: "错误组与影响范围" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "页面性能 p75" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "固定告警证据" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "发布版本关联" })).toBeVisible();
  await expect(page.getByText("2026.08.1", { exact: true }).first()).toBeVisible();

  await page.locator(".clickable-table .el-table__row").first().click();
  const drawer = page.getByRole("dialog", { name: "错误组证据" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "页面 × 发布版本" })).toBeVisible();
  await expect(drawer.getByText(/仅展示 SDK 截断并脱敏/)).toBeVisible();
});

test("controlled demo proves all four M8 events are sanitized before send", async ({
  page,
}) => {
  const payloads: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/events") && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown> | null;
      if (payload) payloads.push(payload);
    }
  });
  await page.goto(`${demoUrl}/observability?acceptance=fast`);
  await page.getByLabel("模拟密码").fill("m8-local-only");
  await page.getByRole("button", { name: "进入场景实验室" }).click();
  await page.getByRole("button", { name: "模拟 JS 异常" }).click();
  await page.getByRole("button", { name: "模拟 API 503" }).click();
  await page.getByRole("button", { name: "模拟资源失败" }).click();
  await page.getByRole("button", { name: "模拟 LCP poor" }).click();
  await expect(page.locator(".event-list")).toContainText("error_js");
  const capturedEvents = () =>
    payloads.flatMap(
      (payload) => (payload.events as Array<Record<string, unknown>>) ?? [],
    );
  await expect
    .poll(
      () =>
        new Set(
          capturedEvents()
            .map((event) => String(event.eventName))
            .filter((eventName) =>
              ["error_js", "error_api", "error_resource", "web_vital"].includes(
                eventName,
              ),
            ),
        ).size,
      { timeout: 8_000 },
    )
    .toBe(4);

  const events = capturedEvents();
  for (const eventName of ["error_js", "error_api", "error_resource", "web_vital"]) {
    expect(events.some((event) => event.eventName === eventName)).toBe(true);
  }
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain("operator@example.invalid");
  expect(serialized).not.toContain("private-token");
  expect(serialized).not.toContain("token=secret");
  const apiError = events.find((event) => event.eventName === "error_api");
  expect((apiError?.properties as Record<string, unknown>)?.requestPath).toBe(
    "/api/budgets/:id",
  );
});
