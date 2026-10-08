import { expect, test } from "@playwright/test";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";

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
