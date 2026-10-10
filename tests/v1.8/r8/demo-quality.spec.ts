import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const project = "11111111-1111-4111-8111-111111111111";
const demoUrl = process.env.M5_DEMO_URL ?? "http://127.0.0.1:4174";

test("scenario JS error becomes visible after quality refresh, only in its environment", async ({
  page,
  context,
  request,
}, info) => {
  test.setTimeout(90000);
  const query = new URLSearchParams({
    env: "dev",
    range: "7d",
    from: new Date(Date.now() - 6 * 86400000).toISOString(),
    to: new Date(Date.now() - 60000).toISOString(),
    pageRoute: "/observability",
    category: "js",
    mode: "all",
  });
  const oldTo = query.get("to")!;
  await page.goto(`/projects/${project}/pages?${query}`);
  await page.getByLabel("邮箱").fill("admin@example.invalid");
  await page.getByLabel("密码").fill("LocalAdmin-1234");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();

  const demo = await context.newPage();
  await demo.goto(`${demoUrl}/observability?acceptance=fast`);
  await demo.getByLabel("模拟密码").fill("r8-demo-only");
  await demo.getByRole("button", { name: "进入场景实验室" }).click();
  await expect(demo.locator(".scenario-stage .privacy-proof")).toContainText(
    "环境 dev",
  );
  const received = demo.waitForResponse((response) => {
    const req = response.request();
    if (!req.url().endsWith("/v1/events") || req.method() !== "POST") return false;
    return req
      .postDataJSON()
      .events.some((event: { event: string }) => event.event === "error");
  });
  await demo.getByRole("button", { name: "模拟 JS 异常" }).click();
  const response = await received;
  expect(response.status()).toBe(202);
  const event = response
    .request()
    .postDataJSON()
    .events.find((value: { event: string }) => value.event === "error");
  expect(event.env).toBe("dev");
  expect(event.appId).toBe("fi_public_m1demo001");
  expect(event.timestamp).toBeGreaterThan(Date.parse(oldTo));
  const occurrence = createHash("sha256").update(event.eventId).digest("hex");
  const buttonName = `打开复现条件 ${occurrence.slice(0, 8)}`;
  await expect(page.getByRole("button", { name: buttonName })).toHaveCount(0);

  const auth = await request.post("/api/auth/login", {
    data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
  });
  expect(auth.status()).toBe(200);
  const headers = { authorization: `Bearer ${(await auth.json()).accessToken}` };
  const fresh = new URLSearchParams(query);
  fresh.set("to", new Date(Date.now() + 1000).toISOString());
  const endpoint = `/api/projects/${project}/observability/occurrences?`;
  // Do not treat HTTP 202 or a mocked response as proof of storage.
  await expect
    .poll(
      async () => {
        const result = await request.get(endpoint + fresh, { headers });
        expect(result.status()).toBe(200);
        return (await result.json()).items.some(
          (item: { occurrenceId: string }) => item.occurrenceId === occurrence,
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.bringToFront();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: buttonName })).toBeVisible();
  expect(Date.parse(new URL(page.url()).searchParams.get("to")!)).toBeGreaterThan(
    event.timestamp,
  );
  for (const env of ["prod", "staging", "dev"]) {
    await page.getByLabel("项目环境").selectOption(env);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: buttonName })).toHaveCount(
      env === "dev" ? 1 : 0,
    );
    fresh.set("env", env);
    const result = await request.get(endpoint + fresh, { headers });
    expect(result.status()).toBe(200);
    expect(
      (await result.json()).items.some(
        (item: { occurrenceId: string }) => item.occurrenceId === occurrence,
      ),
    ).toBe(env === "dev");
  }
  // Explicit historical dates must remain reproducible even when refreshing.
  query.set("range", "custom");
  await page.goto(`/projects/${project}/pages?${query}`);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get("to")).toBe(oldTo);
  await expect(page.getByRole("button", { name: buttonName })).toHaveCount(0);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r8-demo-quality-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: info.project.name,
        realDemoIngestionAndStorage: true,
        refreshShowsNewError: true,
        environmentIsolation: ["dev", "staging", "prod"],
        customRangePreserved: true,
      },
      null,
      2,
    ),
  );
  await demo.close();
});
