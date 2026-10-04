import { FORBIDDEN_ALIASES } from "../../../packages/event-contract/src/generated/canonical-names.js";
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

test("R5-A actual optional SDK, safe payloads, Kafka facts and quality API", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const auth = await request.post("/api/auth/login", {
    data: { email: "admin@example.invalid", password: "LocalAdmin-1234" },
  });
  expect(auth.status()).toBe(200);
  const headers = { authorization: `Bearer ${(await auth.json()).accessToken}` };
  const created = await request.post("/api/projects", {
    headers,
    data: {
      name: `R5-A ${info.project.name} ${randomUUID()}`,
      timezone: "UTC",
      origins: ["http://127.0.0.1:4174"],
    },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const root = `/api/projects/${project.id}`;
  const mod = await (
    await request.post(root + "/modules", {
      headers,
      data: { moduleKey: "quality_fixture", name: "Quality fixture" },
    })
  ).json();
  expect(
    (
      await request.post(root + "/page-definitions", {
        headers,
        data: {
          moduleId: mod.id,
          name: "Quality fixture",
          pageRoute: "/r5a-fixture",
          templateKey: "task_operation",
          isCore: true,
          criticalityWeight: 1,
          expectedFrequency: "daily",
        },
      })
    ).status(),
  ).toBe(201);
  await page.route("**/r5a-index.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: readFileSync("packages/web-tracker/dist/index.js", "utf8"),
    }),
  );
  await page.route("**/r5a-quality.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: readFileSync("packages/web-tracker/dist/quality.js", "utf8"),
    }),
  );
  await page.route("**/r5a-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="root"><button id="action">Test action</button></div>',
    }),
  );
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/v1/events")) sent.push(r.postData() ?? "");
  });
  const started = Date.now();
  await page.goto("http://127.0.0.1:4174/r5a-fixture");
  const sdk = await page.evaluate(async (appId) => {
    const sdkPath = "/r5a-index.js",
      qualityPath = "/r5a-quality.js";
    const { createTracker } = await import(sdkPath),
      { createQualityCollectors } = await import(qualityPath);
    const quality = createQualityCollectors({
      api: true,
      resources: true,
      firstScreen: true,
      lists: true,
      jsErrors: true,
      breadcrumbs: true,
      vitals: true,
      longtasks: true,
      blankScreen: { routes: { "/r5a-fixture": "#root" } },
    });
    const config = {
      appId,
      env: "dev",
      release: "r5a-browser",
      endpoint: location.origin + "/v1/events",
      quality: quality.factory,
      initialUserId: "u_quality_opaque_fixture",
    };
    const tracker = createTracker(config);
    if (createTracker(config) !== tracker) throw new Error("DUPLICATE_INSTALLATION");
    const costs: number[] = [];
    for (let i = 0; i < 110; i++) {
      const t = performance.now();
      quality.action();
      const finish = quality.startList(99);
      finish();
      if (i >= 10) costs.push(performance.now() - t);
    }
    await tracker.flush();
    for (let i = 0; i < 5; i++) {
      await quality.observeApi("/controlled/save", async () => ({
        status: i === 0 ? 500 : 200,
        body: "FI_R5_PRIVATE_BODY",
      }));
      try {
        await quality.observeResource(async () => {
          if (i === 0) throw new Error("FI_R5_RESOURCE_BODY");
          return true;
        });
      } catch {
        /* expected host error */
      }
    }
    quality.captureException(
      new Error("token=FI_R5_PRIVATE_TOKEN DOM_SENTINEL FORM_SENTINEL"),
    );
    quality.firstScreen();
    quality.firstScreen();
    for (const rows of [100, 1000, 1001]) {
      const end = quality.startList(rows);
      end();
      end();
    }
    await new Promise((r) => setTimeout(r, 3200));
    tracker.destroy();
    await tracker.flush();
    costs.sort((a, b) => a - b);
    return {
      p95: costs[Math.ceil(costs.length * 0.95) - 1],
      sampleCount: costs.length,
      diagnostics: tracker.getDiagnostics(),
      supported:
        typeof PerformanceObserver === "undefined"
          ? []
          : PerformanceObserver.supportedEntryTypes,
    };
  }, project.appId);
  expect(sdk.p95).toBeLessThanOrEqual(16);
  expect(sdk.diagnostics.droppedEvents).toBe(0);
  expect(sdk.diagnostics.failedBatches).toBe(0);
  const q = new URLSearchParams({
    env: "dev",
    from: new Date(started - 1000).toISOString(),
    to: new Date(Date.now()).toISOString(),
  });
  let result: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const r = await request.get(root + "/observability/quality?" + q, { headers });
        expect(r.status()).toBe(200);
        result = await r.json();
        return (result.metrics as Record<string, { denominator: number }>)
          .api_error_rate?.denominator;
      },
      { timeout: 30000 },
    )
    .toBe(5);
  const metrics = result.metrics as Record<
    string,
    {
      observedValue: number;
      value: number | null;
      reason: string;
      denominator: number;
      percentiles: unknown;
    }
  >;
  expect(metrics.api_error_rate!.observedValue).toBe(0.2);
  expect(metrics.resource_error_rate!.observedValue).toBe(0.2);
  expect(metrics.blank_screen_rate!.observedValue).toBe(0);
  expect(metrics.api_error_rate!.value).toBeNull();
  expect(metrics.api_error_rate!.reason).toBe("LATENESS_WINDOW_OPEN");
  expect((result.statistics as { clickHouseQueries: number }).clickHouseQueries).toBe(
    1,
  );
  const wire = sent.join("\n");
  expect(wire).not.toMatch(
    /FI_R5_PRIVATE|DOM_SENTINEL|FORM_SENTINEL|FI_R5_RESOURCE_BODY/,
  );
  const original = JSON.parse(sent[0]!) as { events: Record<string, unknown>[] };
  for (const key of ["token", "headers", "body", "form", "dom"]) {
    const poison = structuredClone(original);
    poison.events = [
      { ...poison.events[0], payload: { [key]: "FI_R5_REJECTED_PAYLOAD" } },
    ];
    const r = await request.post("http://127.0.0.1:4174/v1/events", {
      headers: { origin: "http://127.0.0.1:4174" },
      data: poison,
    });
    expect(r.status()).toBe(400);
  }
  const alias = await request.get(
    root + "/observability/quality?" + q + "&metric=" + FORBIDDEN_ALIASES.metricKeys[0],
    { headers },
  );
  expect(alias.status()).toBe(400);
  // The refresh endpoint can mutate only a quality draft; active snapshots remain byte-identical.
  const catalog = await (
    await request.get(root + "/metrics/catalog?type=quality", { headers })
  ).json();
  // A new isolated project deliberately has no auto-activated quality version.
  expect(catalog.activeVersion).toBeNull();
  const initialResponse = await request.post(root + "/metrics/versions", {
    headers,
    data: { type: "quality" },
  });
  expect(initialResponse.status()).toBe(201);
  const initial = await initialResponse.json();
  const activation = await request.post(
    root + `/metrics/versions/${initial.id}/activate`,
    { headers },
  );
  expect(activation.status(), await activation.text()).toBe(201);
  const active = initial.id;
  const before = await (
    await request.get(root + `/metrics/versions/${active}`, { headers })
  ).json();
  expect(
    (
      await request.post(root + `/metrics/versions/${active}/quality-facts`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(409);
  const createdDraft = await request.post(root + "/metrics/versions", {
    headers,
    data: { type: "quality", sourceVersionId: active },
  });
  expect(createdDraft.status()).toBe(201);
  const draft = await createdDraft.json();
  expect(
    (
      await request.post(root + `/metrics/versions/${draft.id}/quality-facts`, {
        headers,
        data: {},
      })
    ).status(),
  ).toBe(201);
  const after = await (
    await request.get(root + `/metrics/versions/${active}`, { headers })
  ).json();
  expect(after).toEqual(before);
  const versioned = await (
    await request.get(root + "/observability/quality?" + q + "&versionId=" + draft.id, {
      headers,
    })
  ).json();
  expect(versioned.binding.versionId).toBe(draft.id);
  expect(versioned.binding.mode).toBe("preview");
  expect(versioned.binding.inputs.api_error_rate.reason).toBe("LATENESS_WINDOW_OPEN");
  const lineage = await (
    await request.get(root + `/metrics/versions/${draft.id}/lineage/api_error_rate`, {
      headers,
    })
  ).json();
  expect(lineage.nodes[0].atomicSources).toContain(
    "Kafka consumer raw_events payload_json",
  );
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r5a-${info.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        browser: info.project.name,
        p95Ms: sdk.p95,
        sampleCount: sdk.sampleCount,
        budgetMs: 16,
        supported: sdk.supported,
        apiRequests: 5,
        apiErrors: 1,
        resourceRequests: 5,
        resourceErrors: 1,
        blankDetected: false,
        privacy: "passed",
        realIntegration: "passed",
        statistics: result.statistics,
      },
      null,
      2,
    ),
  );
});
