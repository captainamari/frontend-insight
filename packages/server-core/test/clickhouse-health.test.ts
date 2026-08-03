import { describe, expect, it } from "vitest";
import { assertClickHouseReady } from "../src/clickhouse-health.js";

describe("ClickHouse readiness", () => {
  it("uses an authenticated SELECT ping", async () => {
    const calls: Array<{ select: true }> = [];
    await assertClickHouseReady({
      async ping(params) {
        calls.push(params);
        return { success: true };
      },
    });
    expect(calls).toEqual([{ select: true }]);
  });

  it("turns the client's non-throwing failure result into a readiness error", async () => {
    const failure = new Error("ClickHouse unavailable");
    await expect(
      assertClickHouseReady({
        async ping() {
          return { success: false, error: failure };
        },
      }),
    ).rejects.toBe(failure);
  });
});
