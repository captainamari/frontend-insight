import { expect, test } from "@playwright/test";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";

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
  await expect(page.locator(".event-list")).toContainText("error");
  await expect.poll(() => payloads.length).toBeGreaterThanOrEqual(4);

  const events = payloads.flatMap(
    (payload) => (payload.events as Array<Record<string, unknown>>) ?? [],
  );
  expect(events.filter((event) => event.event === "error")).toHaveLength(2);
  expect(events.some((event) => event.event === "api")).toBe(true);
  expect(events.some((event) => event.event === "performance")).toBe(true);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain("operator@example.invalid");
  expect(serialized).not.toContain("private-token");
  expect(serialized).not.toContain("token=secret");
  const apiError = events.find((event) => event.event === "api");
  expect((apiError?.payload as Record<string, unknown>)?.requestPath).toBe(
    "/api/budgets/:id",
  );
});
