import { expect, test } from "@playwright/test";

interface BrowserState {
  __ready: boolean;
  __batches: Array<{ events: Array<Record<string, unknown>> }>;
  __tracker: {
    track(
      name: string,
      payload?: Record<string, string | number | boolean | null>,
    ): void;
    featureExposed(key: string): void;
    featureSucceeded(key: string): void;
    captureException(error: unknown): void;
    captureApiError(details: {
      method: string;
      url: string;
      statusCode: number;
      durationMs: number;
    }): void;
    flush(): Promise<void>;
    destroy(): void;
    getDiagnostics(): {
      state: string;
      droppedEvents: number;
      sentEvents: number;
      queueSize: number;
    };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/orders/123?token=must-not-leak#private");
  await page.waitForFunction(() => (window as unknown as BrowserState).__ready);
});

test("captures lifecycle and feature events without URL credentials", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const state = window as unknown as BrowserState;
    history.pushState({}, "", "/reports/456?account=private#hidden");
    state.__tracker.featureExposed("sales_dashboard");
    state.__tracker.featureSucceeded("sales_dashboard");
    await state.__tracker.flush();
    return state.__batches;
  });
  const serialized = JSON.stringify(result);
  const events = result.flatMap((batch) => batch.events);
  expect(
    events.map(
      (event) =>
        (event.payload as Record<string, unknown> | undefined)?.name ?? event.event,
    ),
  ).toEqual([
    "page_view",
    "page_leave",
    "page_view",
    "feature_exposed",
    "feature_succeeded",
  ]);
  expect(events[0]?.pageRoute).toBe("/orders/:id");
  expect(serialized).not.toContain("must-not-leak");
  expect(serialized).not.toContain("private");
});

test("destroy removes navigation listeners", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const state = window as unknown as BrowserState;
    await state.__tracker.flush();
    state.__tracker.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = state.__batches.flatMap((batch) => batch.events).length;
    history.pushState({}, "", "/after-destroy");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      before,
      after: state.__batches.flatMap((batch) => batch.events).length,
      diagnostics: state.__tracker.getDiagnostics(),
    };
  });
  expect(result.diagnostics.state).toBe("destroyed");
  expect(result.after).toBe(result.before);
});

test("sanitizes explicit M8 errors in a real browser before transport", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const state = window as unknown as BrowserState;
    const error = new TypeError("failed for browser@example.invalid Bearer secret");
    error.stack =
      "TypeError: failed\n at loadBudget (https://host.invalid/assets/app.js:10:20?token=secret)";
    state.__tracker.captureException(error);
    state.__tracker.captureApiError({
      method: "GET",
      url: "https://host.invalid/api/budgets/123456?token=secret",
      statusCode: 503,
      durationMs: 120,
    });
    await state.__tracker.flush();
    return state.__batches;
  });
  const events = result
    .flatMap((batch) => batch.events)
    .filter((event) => ["error", "api"].includes(String(event.event)));
  const serialized = JSON.stringify(events);
  expect(events.map((event) => event.event)).toEqual(["error", "api"]);
  expect(serialized).not.toContain("browser@example.invalid");
  expect(serialized).not.toContain("Bearer secret");
  expect(serialized).not.toContain("token=secret");
  expect(serialized).not.toContain("host.invalid");
  expect((events[1]?.payload as Record<string, unknown>).requestPath).toBe(
    "/api/budgets/:id",
  );
});

test("synchronous event processing stays within the 2 ms p95 budget", async ({
  page,
}, testInfo) => {
  const result = await page.evaluate(async () => {
    const state = window as unknown as BrowserState;
    await state.__tracker.flush();
    const before = state.__tracker.getDiagnostics();
    const firstBatch = state.__batches.length;
    const samples: number[] = [];
    let enqueuedSamples = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const startedAt = performance.now();
      state.__tracker.featureExposed("sales_dashboard");
      samples.push(performance.now() - startedAt);
      if (state.__tracker.getDiagnostics().queueSize === 1) enqueuedSamples += 1;
      // Drain outside the timed call so all samples exercise enqueue, not overflow.
      await state.__tracker.flush();
    }
    samples.sort((left, right) => left - right);
    const events = state.__batches.slice(firstBatch).flatMap((batch) => batch.events);
    const diagnostics = state.__tracker.getDiagnostics();
    return {
      sampleCount: samples.length,
      warmups: 0,
      rawMs: samples,
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY,
      enqueuedSamples,
      emittedSamples: events.filter((event) => {
        const payload = event.payload as Record<string, unknown>;
        return (
          event.event === "custom" &&
          payload.name === "feature_exposed" &&
          payload.featureKey === "sales_dashboard"
        );
      }).length,
      uniqueEventIds: new Set(events.map((event) => event.eventId)).size,
      sentEventsDelta: diagnostics.sentEvents - before.sentEvents,
      droppedEventsDelta: diagnostics.droppedEvents - before.droppedEvents,
      diagnostics,
    };
  });
  await testInfo.attach("sdk-sync-budget.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    `artifacts/r8-sdk-${testInfo.project.name}.json`,
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? null,
        browser: testInfo.project.name,
        measurement:
          "real browser synchronous normalization and enqueue; transport stub drains outside measurement",
        budgetMs: 2,
        ...result,
      },
      null,
      2,
    ),
  );
  expect(result.p95Ms).toBeLessThanOrEqual(2);
  expect(result.sampleCount).toBe(2_000);
  expect(result.enqueuedSamples).toBe(result.sampleCount);
  expect(result.emittedSamples).toBe(result.sampleCount);
  expect(result.uniqueEventIds).toBe(result.sampleCount);
  expect(result.sentEventsDelta).toBe(result.sampleCount);
  expect(result.droppedEventsDelta).toBe(0);
  expect(result.diagnostics.queueSize).toBe(0);
});
