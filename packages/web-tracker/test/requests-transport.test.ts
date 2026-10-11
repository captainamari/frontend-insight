// @vitest-environment happy-dom
import { it, expect, vi } from "vitest";
import { createTracker } from "../src/index.js";
import { createRequestDiagnostics } from "../src/requests.js";
import { createQualityCollectors } from "../src/quality.js";
import { validateTransportBatch } from "@frontend-insight/event-contract";
it("keeps request evidence with operation/workflow and quality valid through actual tracker transport", async () => {
  const appId = "fi_request_transport";
  const batches: unknown[] = [];
  const diagnostics = createRequestDiagnostics({ scope: { appId } });
  const quality = createQualityCollectors({ api: true, jsErrors: true });
  const tracker = createTracker({
    appId,
    env: "dev",
    release: "d3",
    endpoint: "https://collector.test/v1/events",
    errorDiagnostics: diagnostics.errorDiagnostics,
    quality: quality.factory,
    registeredFeatures: ["report_export"],
    workflowDefinitions: [
      {
        workflowKey: "report",
        version: 1,
        timeoutSeconds: 30,
        steps: ["submit", "done"].map((stepKey, i) => ({
          stepKey,
          stepOrder: i + 1,
          triggerKind: "explicit_sdk" as const,
          triggerConfig: {},
        })),
        terminalPolicy: {
          completedStepKey: "done",
          failedStepKey: null,
          canceledStepKey: null,
        },
      },
    ],
    observability: { enabled: true, captureWebVitals: false, captureApiErrors: false },
    runtime: {
      window,
      document,
      navigator: { userAgent: "Chrome", sendBeacon: () => false },
      crypto,
      now: Date.now,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: vi.fn(async (_url, init) => {
        batches.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    },
  });
  try {
    const workflow = tracker.startWorkflow("report");
    workflow.reachStep("submit");
    const op = workflow.startOperation("report_export");
    const binding = diagnostics.bind({
      ...op.getContext!(),
      ...workflow.getContext!(),
      stepKey: "submit",
      attemptId: "try1",
      traceId: "trace_synthetic",
      requestId: "server_synthetic",
    });
    binding.action("submit report", "export-button", { token: "synthetic" });
    const wrapped = binding.wrapFetch(
      async () => new Response("text", { status: 503 }),
    );
    const response = await quality.observeApi(
      "/failure",
      () =>
        wrapped("/failure?token=synthetic", {
          method: "POST",
          body: "token=synthetic",
        }),
      "POST",
    );
    diagnostics.responseText(response, await response.text());
    op.fail("technical_failure");
    const error = new TypeError("token=synthetic");
    error.stack =
      "TypeError: failed\n at renderReport (/assets/d3.js?token=synthetic:40:7)";
    binding.capture(tracker, error);
    await tracker.flush();
    for (const body of ["small", "中\n😀".repeat(20000)]) {
      const r = await wrapped("/later");
      diagnostics.responseText(r, body);
      binding.capture(tracker, new Error("token=again"));
      await tracker.flush();
    }
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      const v = validateTransportBatch(batch);
      expect(v.ok, JSON.stringify(v.ok ? {} : v.errors)).toBe(true);
    }
  } finally {
    tracker.destroy();
  }
});
