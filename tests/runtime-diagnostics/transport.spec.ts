import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
test("D0 real browser SDK → ingestion → Kafka → consumer → authorized detail", async ({
  page,
  request,
}, info) => {
  const login = await request.post("/api/auth/login", {
    data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
  });
  const auth = await login.json(),
    headers = { authorization: `Bearer ${auth.accessToken}` };
  const made = await request.post("/api/projects", {
    headers,
    data: {
      name: `D0 browser ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(made.status()).toBe(201);
  const p = await made.json();
  await page.route("**/d0-sdk.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: readFileSync("packages/web-tracker/dist/index.js", "utf8"),
    }),
  );
  await page.route("**/d0-fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><p>Synthetic D0</p>" }),
  );
  const wire: { events: { eventId: string; diagnostic?: unknown }[] }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events") && r.postData())
      wire.push(JSON.parse(r.postData()!));
  });
  await page.goto("http://127.0.0.1:4174/d0-fixture");
  const expected = await page.evaluate(async (appId) => {
    const modulePath = "/d0-sdk.js";
    const { createTracker } = await import(modulePath);
    const tracker = createTracker({
      appId,
      env: "dev",
      release: "d0-browser",
      endpoint: location.origin + "/v1/events",
      beforeSend: ({ event }: { event: unknown }) => event,
    });
    const diagnostic = {
      diagnosticVersion: 1,
      contentType: "application/json",
      source: "explicit",
      policyVersion: "d0-1",
      status: "complete",
      omittedBytes: 0,
      suppressed: 0,
      correlation: { requestId: "req_synthetic" },
      raw: {
        message: "token=FI_D0_SYNTHETIC\nnew line",
        url: "https://fixture.invalid/a?token=synthetic#b",
        nested: {
          password: "synthetic",
          values: [1, { authorization: "Bearer synthetic" }],
        },
        padding: "a".repeat(60000),
      },
    };
    tracker.captureDiagnostic(diagnostic);
    tracker.captureDiagnostic(diagnostic);
    tracker.captureDiagnostic(diagnostic);
    await tracker.flush();
    tracker.destroy();
    return diagnostic;
  }, p.appId);
  const sent = wire.flatMap((b) => b.events).filter((e) => e.diagnostic);
  expect(sent).toHaveLength(3);
  expect(wire.length).toBeGreaterThan(1);
  for (const event of sent) {
    const url = `/api/projects/${p.id}/diagnostics/instances/${event.eventId}`;
    await expect
      .poll(
        async () => {
          const r = await request.get(url, { headers });
          expect(r.status()).toBe(200);
          return (await r.json()).state;
        },
        { timeout: 45000 },
      )
      .toBe("ready");
    const response = await request.get(url, { headers });
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect((await response.json()).diagnostic).toEqual(expected);
  }
  const list = await request.get(
    `/api/projects/${p.id}/observability/occurrences?env=dev&range=7d&mode=all`,
    { headers },
  );
  expect(await list.text()).not.toContain("FI_D0_SYNTHETIC");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/d0-${info.project.name}.json`,
    JSON.stringify({
      testedCommit: process.env.GITHUB_SHA,
      browser: info.project.name,
      projectId: p.id,
      events: sent.length,
      rawRoundtrip: true,
      splitBatches: true,
    }),
  );
});
