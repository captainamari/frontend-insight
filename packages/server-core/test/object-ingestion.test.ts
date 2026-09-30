import { describe, it, expect, vi } from "vitest";
import { contractScenarios } from "@frontend-insight/test-fixtures";
import { IngestionManager } from "../src/pipeline.js";
import { mintBusinessObjectReference } from "../src/object-reference.js";
import { objectReferenceKeys } from "../src/repeated-projection.js";
import type { MySqlStore } from "../src/mysql-store.js";
import type { KafkaEventEnvelope } from "../src/model.js";
import type { ObjectOperation } from "../src/repeated-projection.js";
const project = "11111111-1111-4111-8111-111111111111",
  secret = "k".repeat(32);
function setup() {
  const batch = structuredClone(contractScenarios[0]!.valid),
    original = batch.events[0]!;
  const now = original.timestamp;
  const ticket = mintBusinessObjectReference({
    projectId: project,
    env: original.env,
    objectType: "order",
    rawObjectId: "RAW_ORDER_SENTINEL",
    issuedAt: now,
    keys: objectReferenceKeys(secret, project, original.env, now),
  });
  batch.events = [
    {
      ...original,
      event: "custom",
      userId: "u_opaque_fixture_1",
      payload: {
        name: "feature_started",
        featureKey: "save",
        operationInstanceId: "op_" + "1".repeat(32),
        businessAdapter: true,
        businessSampleRate: 1,
        objectReference: ticket,
      },
    },
  ];
  const store = {
    getIngestionProject: async () => ({
      id: project,
      appId: original.appId,
      status: "active",
      origins: ["https://fixture.test"],
      features: [
        {
          id: "f",
          featureKey: "save",
          featureType: "action",
          status: "active",
          operationLifecycleEnabled: true,
        },
      ],
    }),
    markReceived: async () => {},
    markRejected: async () => {},
  } as unknown as MySqlStore;
  const publish = vi.fn(async (_e: KafkaEventEnvelope) => {
      void _e;
    }),
    publishWithObjects = vi.fn(
      async (_e: KafkaEventEnvelope, _f: ObjectOperation[]) => {
        void _e;
        void _f;
      },
    );
  return {
    batch,
    now,
    ticket,
    publish,
    publishWithObjects,
    manager: new IngestionManager(store, { publish, publishWithObjects }, secret),
  };
}
describe("R4-C object boundary and atomic publication", () => {
  it("strips signed refs from the normal channel and passes only scoped hashes to the short transaction", async () => {
    const f = setup();
    await f.manager.accept(f.batch, {
      origin: "https://fixture.test",
      ip: "fixture",
      nowMs: f.now,
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.publishWithObjects).toHaveBeenCalledTimes(1);
    const [normal, short] = f.publishWithObjects.mock.calls[0]!;
    expect(normal.batch.events[0]!.payload.repeatedEligible).toBe(true);
    expect(JSON.stringify(normal)).not.toContain("objectReference");
    expect(JSON.stringify(short)).not.toMatch(
      /RAW_ORDER_SENTINEL|or1_|u_opaque_fixture/,
    );
    expect(short[0]!.aliases).toHaveLength(4);
  });
  it("rejects forged signatures and does not trust browser eligibility flags", async () => {
    const f = setup();
    f.batch.events[0]!.payload.objectReference =
      f.ticket.slice(0, -1) + (f.ticket.endsWith("a") ? "b" : "a");
    await expect(
      f.manager.accept(f.batch, {
        origin: "https://fixture.test",
        ip: "fixture",
        nowMs: f.now,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_REFERENCE_INVALID" });
    expect(f.publishWithObjects).not.toHaveBeenCalled();
    delete f.batch.events[0]!.payload.objectReference;
    f.batch.events[0]!.payload.repeatedEligible = true;
    await f.manager.accept(f.batch, {
      origin: "https://fixture.test",
      ip: "fixture",
      nowMs: f.now,
    });
    expect(
      f.publish.mock.calls[0]![0].batch.events[0]!.payload.repeatedEligible,
    ).toBeUndefined();
  });
});
