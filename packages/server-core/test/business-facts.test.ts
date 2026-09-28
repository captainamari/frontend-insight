import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { BusinessFactStore } from "../src/business-facts.js";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";

it("R4-A serializes one batched revision query and preserves whole-window UV, zero and gaps", async () => {
  const requests: URL[] = [];
  const row = (windowIndex: number, pageIndex: number, pv: number, uv: number) => ({
    windowIndex,
    pageIndex,
    events: 4,
    pv,
    uv,
    unidentified: 1,
    unclassified: 1,
    excluded: 1,
    firstDataAt: "2026-09-15 00:00:00.000",
    lastDataAt: "2026-09-15 00:00:00.000",
  });
  const server = createServer((req, res) => {
    requests.push(new URL(req.url!, "http://localhost"));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        meta: [],
        data: [row(-1, -1, 4, 2), row(-1, 0, 2, 2), row(-1, 1, 2, 2), row(1, -1, 0, 0)],
        statistics: { rows_read: 4, bytes_read: 100, elapsed: 0.01 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("TEST_SERVER_ADDRESS");
  const store = new BusinessFactStore({
    url: `http://127.0.0.1:${address.port}`,
    username: "default",
    password: "",
    database: "test",
  });
  try {
    const query = resolveProjectCalendar(
      {
        range: "custom",
        env: "prod",
        from: "2026-09-14T00:00:00Z",
        to: "2026-09-16T00:00:00Z",
      },
      "UTC",
    );
    const count = vi.fn();
    const result = await store.read(
      "11111111-1111-4111-8111-111111111111",
      "module",
      "prod",
      query.buckets,
      [0, 1].map((i) => ({
        pageId: String(i),
        pageRoute: "/quote'" + i,
        name: "page",
        moduleId: "module",
        pageRevisionId: "revision" + i,
        moduleRevisionId: "revision",
        from: query.from,
        to: query.to,
        included: true,
        reason: "INCLUDED",
      })),
      count,
    );
    expect(requests).toHaveLength(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(requests[0]!.searchParams.get("param_pages")).toMatch(/^\[\('/);
    expect(requests[0]!.searchParams.get("param_pages")).toContain("\\'");
    expect(result.window.uv).toBe(2);
    expect(result.pages.reduce((n, p) => n + (p.observation.uv ?? 0), 0)).toBe(4);
    expect(result.buckets[0]!.pv).toBeNull();
    expect(result.buckets[1]!.pv).toBe(0);
    expect(result.statistics.rowsRead).toBe(4);
    expect(JSON.stringify(result)).not.toContain("user_id");
  } finally {
    await store.close();
    server.close();
    await once(server, "close");
  }
});
