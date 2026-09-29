import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import { IngestionManager } from "../src/pipeline.js";
import type { MySqlStore } from "../src/mysql-store.js";
import type { KafkaEventEnvelope } from "../src/model.js";
describe("R4-C identity boundary before Kafka", () => {
  it("replaces forged browser claims from event-time directory and clears unknown users", async () => {
    const batch = structuredClone(contractScenarios[0]!.valid);
    batch.events = batch.events.slice(0, 1);
    const e = batch.events[0]!;
    e.deptId = "FORGED_ORG_TEXT";
    e.roleId = "FORGED_ROLE_TEXT";
    e.userId = "u_opaque_fixture_0001";
    const projectId = "11111111-1111-4111-8111-111111111111",
      key = "h".repeat(32),
      now = e.timestamp;
    const user = createHmac("sha256", key)
      .update(`${projectId}:${e.userId}`)
      .digest("hex");
    const store = {
      getIngestionProject: async () => ({
        id: projectId,
        appId: e.appId,
        status: "active",
        origins: ["https://fixture.test"],
        features: [],
      }),
      markReceived: async () => {},
      markRejected: async () => {},
    } as unknown as MySqlStore;
    const publish = vi.fn(async (_e: KafkaEventEnvelope) => {
      void _e;
    });
    const manager = new IngestionManager(store, { publish }, key, {
      directories: async () => [
        {
          id: "11111111-1111-4111-8111-111111111112",
          env: e.env,
          sourceKey: "fixture",
          status: "published",
          coverage: "complete",
          from: new Date(now - 1).toISOString(),
          until: new Date(now + 1000).toISOString(),
          entries: [
            {
              userId: user,
              deptId: "dept_fixture",
              roleId: "role_fixture",
              eligible: true,
            },
          ],
        },
      ],
    });
    await manager.accept(batch, {
      origin: "https://fixture.test",
      ip: "fixture",
      nowMs: now,
    });
    const envelope = publish.mock.calls[0]![0];
    expect(envelope.batch.events[0]).toMatchObject({
      userId: user,
      deptId: "dept_fixture",
      roleId: "role_fixture",
    });
    expect(JSON.stringify(envelope)).not.toMatch(/FORGED_|u_opaque_fixture/);
    e.userId = "u_unknown_fixture_0001";
    await manager.accept(batch, {
      origin: "https://fixture.test",
      ip: "fixture",
      nowMs: now,
    });
    expect(publish.mock.calls[1]![0].batch.events[0]).toMatchObject({
      deptId: null,
      roleId: null,
    });
  });
});
