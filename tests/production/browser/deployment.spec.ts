import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test("production TLS login, SDK storage and retained volumes", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const credentials = JSON.parse(readFileSync(process.env.FI_BOOTSTRAP_INPUT!, "utf8"));
  const phase = process.env.FI_PRODUCTION_PHASE ?? "initial";
  const artifact = `artifacts/production-${info.project.name}.json`;
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/projects/);
  const cookie = (await context.cookies()).find((item) => item.name === "fi_refresh");
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  // The browser sends the Secure cookie over the TLS edge, including after restart.
  const refreshed = await context.request.post("/api/auth/refresh");
  expect(refreshed.status()).toBe(200);
  const tokens = await refreshed.json();
  const headers = { authorization: `Bearer ${tokens.accessToken}` };
  let project: { id: string; appId: string; name: string };
  if (phase === "initial") {
    const response = await context.request.post("/api/projects", {
      headers,
      data: {
        name: `PRODUCTION CI TEST ONLY ${info.project.name} ${randomUUID()}`,
        timezone: "Asia/Shanghai",
        origins: ["https://127.0.0.1:8443"],
      },
    });
    expect(response.status()).toBe(201);
    project = await response.json();
  } else {
    project = JSON.parse(readFileSync(artifact, "utf8")).project;
  }
  const access = await context.request.get(`/api/projects/${project.id}/access`, {
    headers,
  });
  expect(access.status()).toBe(200);
  const saved = await access.json();
  expect(saved.name).toBe(project.name);
  expect(saved.timezone).toBe("Asia/Shanghai");
  expect(saved.origins).toEqual(["https://127.0.0.1:8443"]);
  await page.goto(`/projects/${project.id}/settings?env=prod&range=7d&tab=integration`);
  await expect(page.getByTestId("settings-app-id")).toHaveText(project.appId);
  const settings = `/api/projects/${project.id}/settings`;
  if (phase === "initial") {
    await page.getByRole("button", { name: "发送测试事件", exact: true }).click();
    await expect(page.getByTestId("test-receipt")).toContainText("可查询：已证实", {
      timeout: 45000,
    });
    const snippet = await page.getByTestId("settings-snippet").innerText();
    expect(snippet).toContain('env: "prod"');
    await page.route("**/production-host.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: snippet }),
    );
    const accepted = page.waitForResponse(
      (r) =>
        r.url().endsWith("/v1/events") &&
        r.request().method() === "POST" &&
        r.status() === 202,
    );
    await page.addScriptTag({ url: "/production-host.js", type: "module" });
    await accepted;
  }
  await expect
    .poll(
      async () => {
        const response = await context.request.get(
          settings + "/probe-versions?env=prod&range=7d",
          { headers },
        );
        expect(response.status()).toBe(200);
        return (await response.json()).denominator;
      },
      { timeout: 45000 },
    )
    .toBeGreaterThanOrEqual(2);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    artifact,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        browser: info.project.name,
        project,
        tlsLogin: true,
        secureRefresh: true,
        sdkQueryable: true,
        retainedAfterRestart: phase === "retained" || phase === "restored",
        restoredFromBackup: phase === "restored",
        phase,
      },
      null,
      2,
    ),
  );
});
