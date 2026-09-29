// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTracker, type Tracker, type TrackerRuntime } from "../src/index.js";
import { validateForIngestion } from "@frontend-insight/event-contract";
const trackers: Tracker[] = [];
afterEach(() => {
  for (const t of trackers) t.destroy();
  trackers.length = 0;
  vi.useRealTimers();
});
function fixture(enabled = true) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T01:00:00Z"));
  const sent: unknown[] = [];
  const runtime: TrackerRuntime = {
    window,
    document,
    navigator: { userAgent: "Chrome", sendBeacon: () => false },
    fetch: vi.fn(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
    crypto: globalThis.crypto,
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const tracker = createTracker({
    appId: `fi_${crypto.randomUUID().slice(0, 8)}`,
    env: "dev",
    release: "r4c",
    endpoint: "https://collector.test/v1/events",
    runtime,
    deptId: "UNTRUSTED_ORG_TEXT",
    roleId: "UNTRUSTED_ROLE_TEXT",
    registeredFeatures: ["save"],
    forms: {
      enabled,
      definitions: [
        { formId: "edit", fieldKeys: ["status", "category"] },
        { formId: "other", fieldKeys: ["status"] },
      ],
    },
    businessOperations: { enabled, operationKeys: ["save"] },
  });
  trackers.push(tracker);
  tracker.setUser("u_opaque_fixture_reference");
  return {
    tracker,
    sent,
    async events() {
      await tracker.flush();
      return sent.flatMap(
        (b) =>
          (b as { events: { event: string; payload: Record<string, unknown> }[] })
            .events,
      );
    },
  };
}
describe("R4-C controlled collection", () => {
  it("counts only registered keys; duplicate validation callback and settlement are idempotent", async () => {
    const f = fixture(),
      form = f.tracker.trackForm("edit");
    expect(f.tracker.trackForm("edit")).toBe(form);
    form.change("status");
    form.change("status");
    form.change("category");
    form.change("private-value");
    form.reset();
    const attempt = form.submit();
    attempt.validationFailed();
    attempt.validationFailed();
    form.submit();
    form.destroy();
    form.destroy();
    form.change("status");
    const events = await f.events(),
      summary = events.find((e) => e.payload.name === "form_summary")!.payload;
    expect(summary).toMatchObject({
      changeCount: 3,
      resetCount: 1,
      submitCount: 2,
      validationFailureCount: 1,
      counterOverflow: false,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /UNTRUSTED_ORG_TEXT|UNTRUSTED_ROLE_TEXT|private-value|fieldKey|inputValue|validationMessage/,
    );
    expect(events.filter((e) => e.payload.name === "form_summary")).toHaveLength(1);
    for (const batch of f.sent) expect(validateForIngestion(batch).ok).toBe(true);
  });
  it("keeps concurrent forms separate and settles before navigation and identity change", async () => {
    const f = fixture(),
      a = f.tracker.trackForm("edit"),
      b = f.tracker.trackForm("other");
    a.change("status");
    b.reset();
    window.history.pushState({}, "", `/next-${crypto.randomUUID()}`);
    f.tracker.trackForm("edit").submit();
    f.tracker.setUser("u_second_fixture_reference");
    const events = await f.events();
    expect(events.filter((e) => e.payload.name === "form_summary")).toHaveLength(3);
  });
  it("disabled collectors never emit and preserve host values", async () => {
    const f = fixture(false);
    f.tracker.trackForm("edit").destroy();
    const value = { private: "secret-host-value" };
    expect(
      await f.tracker.observeBusiness(
        "save",
        async () => value,
        () => {
          throw new Error("must not run");
        },
      ),
    ).toBe(value);
    expect(
      (await f.events()).filter(
        (e) => e.payload.name === "form_summary" || e.payload.businessAdapter,
      ),
    ).toHaveLength(0);
  });
  it("executes a synchronously throwing host exactly once when collection is disabled", async () => {
    const f = fixture(false);
    const cause = new Error("host-only");
    const execute = vi.fn((): Promise<never> => {
      throw cause;
    });
    await expect(
      f.tracker.observeBusiness("save", execute, () => "success"),
    ).rejects.toBe(cause);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("separates HTTP 200 rejection, technical outcome, cancellation and network uncertainty", async () => {
    const f = fixture(),
      response = new Response(null, { status: 200 });
    expect(
      await f.tracker.observeBusiness(
        "save",
        async () => response,
        () => "rejected",
      ),
    ).toBe(response);
    await f.tracker.observeBusiness(
      "save",
      async () => response,
      () => "technical_failure",
    );
    await f.tracker.observeBusiness(
      "save",
      async () => response,
      () => "canceled",
    );
    const cause = new Error("private-network-body");
    await expect(
      f.tracker.observeBusiness(
        "save",
        async () => {
          throw cause;
        },
        () => "rejected",
      ),
    ).rejects.toBe(cause);
    const events = await f.events();
    expect(events.some((e) => e.event === "api")).toBe(false);
    expect(
      events
        .filter((e) => e.payload.businessResult)
        .map((e) => e.payload.businessResult),
    ).toEqual(["rejected", "technical_failure", "canceled", "unknown"]);
    expect(JSON.stringify(events)).not.toContain("private-network-body");
    for (const batch of f.sent) expect(validateForIngestion(batch).ok).toBe(true);
  });
  it("classifier exceptions preserve returned value and result remains unknown", async () => {
    const f = fixture(),
      value = { ok: true };
    expect(
      await f.tracker.observeBusiness(
        "save",
        async () => value,
        () => {
          throw new Error("private");
        },
      ),
    ).toBe(value);
    expect(
      (await f.events()).find((e) => e.payload.businessResult)?.payload.businessResult,
    ).toBe("unknown");
  });
  it("bounds counters, rejects unknown forms and stops handles after destroy", async () => {
    const f = fixture(),
      form = f.tracker.trackForm("edit");
    for (let i = 0; i < 10001; i++) form.change("status");
    form.destroy();
    f.tracker.trackForm("unknown").destroy();
    expect(
      (await f.events())
        .filter((e) => e.payload.name === "form_summary")
        .map((e) => e.payload),
    ).toMatchObject([{ changeCount: 10000, counterOverflow: true }]);
    f.tracker.destroy();
    f.tracker.trackForm("edit").submit();
    expect(f.tracker.getDiagnostics().state).toBe("destroyed");
  });
  it("does not attach a business terminal to a changed user", async () => {
    const f = fixture();
    await f.tracker.observeBusiness(
      "save",
      async () => {
        f.tracker.setUser("u_changed_fixture_reference");
        return true;
      },
      () => "success",
    );
    expect((await f.events()).filter((e) => e.payload.businessResult)).toHaveLength(0);
  });
});

it("records the R4-C collector cost within the inherited 16ms host budget", async () => {
  const clock = performance.now.bind(performance);
  const f = fixture();
  const rawMs: number[] = [];
  for (let i = 0; i < 110; i++) {
    const began = clock();
    for (const formId of ["edit", "other"]) {
      const form = f.tracker.trackForm(formId);
      for (let n = 0; n < 50; n++) form.change("status");
      form.reset();
      form.submit().validationFailed();
      form.submit();
      form.destroy();
    }
    await f.tracker.observeBusiness(
      "save",
      async () => true,
      () => "success",
    );
    if (i >= 10) rawMs.push(clock() - began);
    await f.tracker.flush();
  }
  const p95 = [...rawMs].sort((a, b) => a - b)[Math.ceil(rawMs.length * 0.95) - 1]!;
  expect(p95).toBeLessThan(16);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/r4c-sdk-synchronous.json",
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA ?? null,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        measurement:
          "Node/happy-dom; two forms each with 50 changes, reset, two submits, validation and settlement plus resolved business adapter; includes promise microtasks; fetch stub outside timing; not browser production capacity",
        warmups: 10,
        sampleCount: rawMs.length,
        rawMs,
        p95,
        budgetMs: 16,
        p95Algorithm: "nearest-rank",
      },
      null,
      2,
    ),
  );
});
