import { expect, test } from "@playwright/test";

// UI-only contract: mock transport so a fixed clock can check URL/request boundaries.
// The companion demo test covers real ingestion, storage and environment isolation.
test("quality refresh advances presets, preserves custom ranges and resets cursors", async ({
  page,
}) => {
  const now = new Date("2026-10-09T01:30:00.000Z");
  await page.clock.setFixedTime(now);
  const queries: URLSearchParams[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/auth/refresh") {
      body = {
        accessToken: "ui-test-only",
        user: { id: "ui", displayName: "UI fixture", globalRole: "admin" },
      };
    } else if (url.pathname.endsWith("/access")) {
      body = { id: "ui", name: "UI fixture", timezone: "Asia/Shanghai" };
    } else if (url.pathname.endsWith("/observability/occurrences")) {
      queries.push(url.searchParams);
      body = {
        items: [],
        routes: [],
        nextCursor: null,
        availableFrom: null,
        asOf: now.toISOString(),
        totalGroups: 0,
        totalOccurrences: 0,
        dataState: "no_data",
        timezone: "Asia/Shanghai",
        pipeline: { state: "healthy" },
      };
    } else throw new Error(`Unexpected UI fixture request: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  const oldFrom = "2026-10-01T00:00:00.000Z";
  const oldTo = "2026-10-08T07:44:34.231Z";
  const groupId = "a".repeat(64);
  for (const range of ["7d", "30d", "90d", "180d", "365d", "custom"]) {
    const query = new URLSearchParams({
      env: "dev",
      range,
      from: oldFrom,
      to: oldTo,
      pageRoute: "/observability",
      category: "js",
      mode: "all",
      groupId,
      cursor: "old-snapshot",
      scoreFrom: oldFrom,
      scoreTo: oldTo,
    });
    await page.goto(`/projects/ui/pages?${query}`);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    const before = queries.length;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    const current = queries.at(-1)!;
    expect(current.get("to")).toBe(range === "custom" ? oldTo : now.toISOString());
    if (range === "custom") expect(current.get("from")).toBe(oldFrom);
    else expect(current.get("from")).not.toBe(oldFrom);
    for (const [key, value] of Object.entries({
      env: "dev",
      range,
      pageRoute: "/observability",
      category: "js",
      mode: "all",
      groupId,
    }))
      expect(current.get(key)).toBe(value);
    expect(current.has("cursor")).toBe(false);
    const location = new URL(page.url()).searchParams;
    expect(location.get("to")).toBe(current.get("to"));
    if (range !== "custom") {
      expect(location.has("scoreFrom")).toBe(false);
      expect(location.has("scoreTo")).toBe(false);
    }
    // A second refresh at the same clock instant must still request fresh data.
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    const previous = queries.length;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => queries.length).toBeGreaterThan(previous);
  }
});
