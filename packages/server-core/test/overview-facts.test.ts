import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { OverviewFactStore } from "../src/overview-facts.js";
import { SafeClickHouseLogger } from "../src/clickhouse-logger.js";
import { resolveProjectCalendar } from "@frontend-insight/event-contract/project-range";

it("R3 real client serializes tuple parameters and preserves aggregate zero versus gaps", async () => {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    requests.push(new URL(req.url!, "http://localhost"));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        meta: [],
        data: [
          {
            windowIndex: -1,
            events: "1",
            pv: "0",
            lastDataAt: "2026-09-15 00:00:00.000",
            firstDataAt: "2026-09-15 00:00:00.000",
          },
          {
            windowIndex: 1,
            events: "1",
            pv: "0",
            lastDataAt: "2026-09-15 00:00:00.000",
            firstDataAt: "2026-09-15 00:00:00.000",
          },
        ],
        statistics: { rows_read: 1, bytes_read: 20, elapsed: 0.01 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("TEST_SERVER_ADDRESS");
  const store = new OverviewFactStore({
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
      ),
      count = vi.fn();
    const facts = await store.read(
      "11111111-1111-4111-8111-111111111111",
      "prod",
      query.buckets,
      [{ pageRoute: "/quote'route", from: query.from, to: query.to }],
      count,
    );
    expect(requests).toHaveLength(1);
    expect(count).toHaveBeenCalledTimes(1);
    // The ClickHouse Array(Tuple(...)) grammar requires parentheses, not nested square arrays.
    expect(requests[0]!.searchParams.get("param_buckets")).toMatch(/^\[\('/);
    expect(requests[0]!.searchParams.get("param_pages")).toContain("\\'");
    expect(facts.window.raw.pv!.value).toBe(0);
    expect(facts.window.inputs.pv!.value).toBeNull();
    expect(facts.buckets[0]!.raw.pv!.value).toBeNull();
    expect(facts.buckets[1]!.raw.pv!.value).toBe(0);
    expect(facts.statistics.rowsRead).toBe(1);
  } finally {
    await store.close();
    server.close();
    await once(server, "close");
  }
});

it("R3 storage diagnostics omit parameter values, credentials and error messages", () => {
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    new SafeClickHouseLogger().error({
      module: "Connection",
      message: "secret",
      args: {
        query_id: "11111111-1111-4111-8111-111111111111",
        token: "secret",
        query_params: "private-value",
      },
      err: Object.assign(new Error("secret SQL"), { code: "27" }),
    });
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        source: "clickhouse",
        code: "27",
        queryId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  } finally {
    output.mockRestore();
  }
});
