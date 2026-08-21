import { expect, test } from "@playwright/test";
import legacy from "../../../packages/test-fixtures/fixtures/invalid/legacy-v2.json" with { type: "json" };
import valid from "../../../packages/test-fixtures/fixtures/valid/page-usage-v3.json" with { type: "json" };

test("empty-stack smoke accepts v3 and rejects the legacy contract", async ({
  request,
}) => {
  const now = Date.now();
  const batch = structuredClone(valid);
  batch.sentAt = now;
  batch.events.forEach((event, index) => {
    event.appId = "fi_public_m1demo001";
    event.timestamp = now + index;
  });

  const accepted = await request.post("/v1/events", { data: batch });
  expect(accepted.status()).toBe(202);
  expect(await accepted.json()).toMatchObject({
    acceptedEvents: batch.events.length,
    supportedSchemaVersions: [3],
  });

  const rejected = await request.post("/v1/events", { data: legacy });
  expect(rejected.status()).toBe(400);
  expect(await rejected.json()).toMatchObject({
    code: "SCHEMA_VERSION_UNSUPPORTED",
  });
});
