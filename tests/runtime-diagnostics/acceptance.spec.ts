import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

test("D7 mounted Vue event → raw SDK → services → export; offline bounded queue drains", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180000);
  const auth = await (
    await request.post("/api/auth/login", {
      data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
    })
  ).json();
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  const project = await (
    await request.post("/api/projects", {
      headers,
      data: {
        name: `D7 framework ${info.project.name} ${randomUUID()}`,
        timezone: "UTC",
        origins: ["http://127.0.0.1:4174"],
      },
    })
  ).json();
  const wire: {
    eventId: string;
    diagnostic?: { source: string; raw: Record<string, unknown> };
  }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData())
      wire.push(...JSON.parse(r.postData()!).events);
  });
  await page.route("**/d7-framework-fixture?*", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="app"></div><script type="module" src="/d7/framework.js"></script>',
    }),
  );
  await page.goto(`http://127.0.0.1:4174/d7-framework-fixture?appId=${project.appId}`);
  await page.getByRole("button", { name: "触发真实 Vue 组件异常" }).click();
  await page.evaluate(async () => {
    const w = window as unknown as { d7: { tracker: { flush(): Promise<void> } } };
    await w.d7.tracker.flush();
  });
  await expect
    .poll(() => wire.filter((e) => e.diagnostic?.source === "vue").length)
    .toBe(1);
  const event = wire.find((e) => e.diagnostic?.source === "vue")!;
  expect(JSON.stringify(event.diagnostic)).toContain("原文框架异常");
  expect(JSON.stringify(event.diagnostic?.raw.console)).toContain("Vue action");
  const root = `/api/projects/${project.id}/diagnostics`;
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(root + `/instances/${event.eventId}`, { headers })
          ).json()
        ).state,
      { timeout: 45000 },
    )
    .toBe("ready");
  const detail = await (
    await request.get(root + `/instances/${event.eventId}`, { headers })
  ).json();
  expect(detail.diagnostic).toEqual(event.diagnostic);
  const exported = await request.post(root + `/instances/${event.eventId}/export`, {
    headers,
    data: { format: "json" },
  });
  expect(exported.status()).toBe(201);
  expect(await exported.text()).toContain("原文框架异常");
  // Actual network failure. No simulated successful transport while offline.
  await page.route("**/v1/events", (r) => r.abort("internetdisconnected"));
  const offline = await page.evaluate(async () => {
    const w = window as unknown as {
      d7: {
        tracker: {
          captureException(e: Error): void;
          flush(): Promise<void>;
          getDiagnostics(): {
            queueSize: number;
            failedBatches: number;
            droppedEvents: number;
          };
        };
      };
    };
    for (let i = 0; i < 15; i++)
      w.d7.tracker.captureException(new Error(`FI_D7_SYNTHETIC offline ${i}`));
    await w.d7.tracker.flush();
    return w.d7.tracker.getDiagnostics();
  });
  expect(offline.queueSize).toBe(15);
  expect(offline.failedBatches).toBeGreaterThan(0);
  await page.unroute("**/v1/events");
  await page.evaluate(async () => {
    const w = window as unknown as { d7: { tracker: { flush(): Promise<void> } } };
    await w.d7.tracker.flush();
  });
  const queued = [
    ...new Map(
      wire
        .filter((e) => e.diagnostic && JSON.stringify(e.diagnostic).includes("offline"))
        .map((e) => [e.eventId, e]),
    ).values(),
  ];
  expect(queued).toHaveLength(15);
  for (const e of queued)
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(root + `/instances/${e.eventId}`, { headers })
            ).json()
          ).state,
        { timeout: 45000 },
      )
      .toBe("ready");
  await page.evaluate(() => {
    (window as unknown as { d7: { stop(): void } }).d7.stop();
  });
  const synchronous = await page.evaluate(() =>
    (
      window as unknown as {
        d7Benchmark(): {
          result: Record<string, { p95Ms: number; samples: number; warmups: number }>;
          envelopeBytes: number;
          method: string;
        };
      }
    ).d7Benchmark(),
  );
  expect(synchronous.envelopeBytes).toBe(65536);
  for (const sample of Object.values(synchronous.result))
    expect(sample.p95Ms).toBeLessThanOrEqual(2);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d7-framework-${info.project.name}.json`,
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      actualBrowser: info.project.name,
      mountedVue: true,
      rawRoundtrip: true,
      export: true,
      offlineUniqueEvents: queued.length,
      offlineQueueSize: offline.queueSize,
      synchronous,
    }),
  );
});
