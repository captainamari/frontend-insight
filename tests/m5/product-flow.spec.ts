import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.M5_WEB_URL ?? "http://127.0.0.1:4173";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";
const configuredProjectId = "11111111-1111-4111-8111-111111111111";

function projectNavigationButton(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "项目一级导航" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
}

test("three controlled scenarios keep simulated credentials out of telemetry", async ({
  page,
}) => {
  const payloads: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/events") && request.method() === "POST") {
      payloads.push(request.postData() ?? "");
    }
  });

  await page.goto(`${demoUrl}/data?acceptance=fast`);
  await page.getByLabel("模拟密码").fill("local-demo-only");
  await page.getByRole("button", { name: "进入场景实验室" }).click();
  const simulatedToken = await page.evaluate(
    () =>
      (
        window as unknown as {
          __fiDemo: { simulatedToken: string };
        }
      ).__fiDemo.simulatedToken,
  );

  await page.getByRole("button", { name: /请求成功 \+ 渲染成功/ }).click();
  await expect(page.locator(".event-list")).toContainText("feature_succeeded");

  await page.getByRole("button", { name: /业务操作/ }).click();
  const firstOperation = page.locator(".operation-row").first();
  await firstOperation.getByRole("button", { name: "成功" }).click();
  await firstOperation.getByRole("button", { name: "取消" }).click();
  await firstOperation.getByRole("button", { name: "失败" }).click();
  await expect(page.locator(".event-list")).toContainText("只表示开始，不计入成功使用");
  await expect(page.locator(".event-list")).toContainText("用户明确取消");
  await expect(page.locator(".event-list")).toContainText("未计入成功");

  await page.getByRole("button", { name: /持续展示/ }).click();
  await page.getByRole("button", { name: "开始持续展示" }).click();
  await expect(page.locator(".event-list")).toContainText("达到前台可见阈值", {
    timeout: 8_000,
  });
  await page.getByRole("button", { name: "结束并结算" }).click();
  await page.getByRole("button", { name: "立即发送" }).click();

  await expect.poll(() => payloads.length, { timeout: 8_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => payloads.join("\n"), { timeout: 8_000 })
    .toContain("feature_long_view_ended");
  const serialized = payloads.join("\n");
  expect(serialized).not.toContain(simulatedToken);
  expect(serialized).not.toContain("local-demo-only");
  expect(serialized).not.toContain("Authorization");
  expect(serialized).toContain("feature_started");
  expect(serialized).toContain("feature_succeeded");
  expect(serialized).toContain("feature_failed");
  expect(serialized).toContain("feature_canceled");
  expect(serialized).toContain("feature_long_view_ended");
});

test("admin can finish the URL-preserving product loop", async ({ page }) => {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("heading", { name: "全部项目" })).toBeVisible();
  const projectCard = page.getByRole("button", { name: /Frontend Insight M5 Demo/ });
  await expect(projectCard).toBeVisible({ timeout: 15_000 });
  await projectCard.click();
  await expect(
    page.getByRole("heading", { name: "Frontend Insight M5 Demo" }),
  ).toBeVisible();
  await page.goto(
    `${webUrl}/projects/${configuredProjectId}/business-analysis/features?range=7d`,
  );
  await expect(page.getByRole("heading", { name: "功能采用" })).toBeVisible();
  await expect(page.getByText("曝光后使用率（账号）")).toBeVisible();
  await expect(page.getByText("重复账号 / 浏览器")).toBeVisible();

  const url = new URL(page.url());
  expect(url.pathname).toBe(
    `/projects/${configuredProjectId}/business-analysis/features`,
  );
  expect(url.searchParams.get("range")).toBe("7d");
  const preservedQuery = url.search;
  await page.reload();
  await expect.poll(() => new URL(page.url()).search).toBe(preservedQuery);
  await expect(page.getByText("销售数据看板")).toBeVisible();

  await projectNavigationButton(page, "页面分析").click();
  await expect(page.getByText("昨日同时段", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("归一化路由", { exact: true })).toBeVisible();

  await projectNavigationButton(page, "设置").click();
  await expect(page.getByText("fi_public_m1demo001", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送测试事件" })).toBeVisible();
  await expect(
    page.getByText("SDK 不读取 Authorization", { exact: false }),
  ).toBeVisible();
});

test("viewer sees project evidence but cannot mutate configuration", async ({
  page,
}) => {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("邮箱").fill("viewer@example.invalid");
  await page.getByLabel("密码").fill("LocalViewer-1234");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "全部项目" })).toBeVisible();
  const projectCard = page.getByRole("button", { name: /Frontend Insight M5 Demo/ });
  await expect(projectCard).toBeVisible({ timeout: 15_000 });
  await projectCard.click();
  await expect(
    page.getByRole("heading", { name: "Frontend Insight M5 Demo" }),
  ).toBeVisible();
  await projectNavigationButton(page, "设置").click();
  await expect(page.getByText("当前账号为只读权限")).toBeVisible();
  await expect(page.getByRole("button", { name: "创建项目" })).toHaveCount(0);
  await expect(page.getByLabel("项目名称")).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存项目配置" })).toHaveCount(0);
});
