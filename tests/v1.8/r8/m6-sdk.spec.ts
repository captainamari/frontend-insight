import { expect, test } from "@playwright/test";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";

test("operation demo emits independently paired v3 terminal events", async ({
  page,
}) => {
  const payloads: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/events") && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (body) payloads.push(body);
    }
  });
  await page.goto(`${demoUrl}/action?acceptance=fast`);
  await page.getByLabel("模拟密码").fill("m6-local-only");
  await page.getByRole("button", { name: "进入场景实验室" }).click();
  const firstOperation = page.locator(".operation-row").first();
  await firstOperation.getByRole("button", { name: "成功" }).click();
  await firstOperation.getByRole("button", { name: "取消" }).click();
  await firstOperation.getByRole("button", { name: "失败" }).click();
  await expect(page.locator(".event-list")).toContainText("operation_failed");
  await page.getByRole("button", { name: "立即发送" }).click();
  await expect.poll(() => payloads.length).toBeGreaterThan(0);

  const events = payloads.flatMap(
    (payload) => (payload.events as Array<Record<string, unknown>>) ?? [],
  );
  const operationEvents = events.filter((event) =>
    [
      "feature_started",
      "feature_succeeded",
      "feature_failed",
      "feature_canceled",
    ].includes(String((event.payload as Record<string, unknown> | undefined)?.name)),
  );
  expect(payloads.some((payload) => payload.schemaVersion === 3)).toBe(true);
  const starts = operationEvents.filter(
    (event) =>
      (event.payload as Record<string, unknown> | undefined)?.name ===
      "feature_started",
  );
  const terminals = operationEvents.filter((event) =>
    ["feature_succeeded", "feature_failed", "feature_canceled"].includes(
      String((event.payload as Record<string, unknown> | undefined)?.name),
    ),
  );
  const operationId = (event: Record<string, unknown>) =>
    (event.payload as Record<string, unknown> | undefined)?.operationInstanceId;
  expect(new Set(starts.map(operationId)).size).toBe(3);
  expect(terminals).toHaveLength(3);
  for (const start of starts) {
    expect(
      terminals.filter((terminal) => operationId(terminal) === operationId(start)),
    ).toHaveLength(1);
  }
});
