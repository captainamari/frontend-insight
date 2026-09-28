import { describe, expect, it, vi } from "vitest";
import { EventConsumerRuntime } from "../src/index.js";

describe("R4-B poison-envelope privacy", () => {
  it("never copies arbitrary project IDs or payload to Kafka dead letters", async () => {
    const send = vi.fn(async () => {}),
      markDeadLetter = vi.fn(async () => {});
    const runtime = Object.assign(Object.create(EventConsumerRuntime.prototype), {
      environment: { KAFKA_DLQ_TOPIC: "test-dead-letter" },
      dlqProducer: { send },
      mysql: { markDeadLetter },
      metrics: { deadLetters: 0 },
    }) as { deadLetter: (value: Buffer, metadata: unknown) => Promise<void> };
    await runtime.deadLetter(
      Buffer.from(
        JSON.stringify({
          projectId: "FI_PRIVATE_TOKEN",
          payload: { body: "FI_PRIVATE_BODY", query: "FI_PRIVATE_QUERY" },
        }),
      ),
      {
        topic: "test-events",
        partition: 0,
        offset: "1",
        code: "KAFKA_ENVELOPE_INVALID",
      },
    );
    const output = JSON.stringify(send.mock.calls);
    expect(output).not.toContain("FI_PRIVATE");
    expect(output).toContain("messageHash");
    expect(output).toContain("unknown-project");
    expect(markDeadLetter).not.toHaveBeenCalled();
  });
  it("rejects a noncanonical project context before persistence", () => {
    const runtime = Object.create(EventConsumerRuntime.prototype) as {
      parseEnvelope: (value: Buffer) => unknown;
    };
    expect(() =>
      runtime.parseEnvelope(
        Buffer.from(
          JSON.stringify({
            envelopeVersion: 1,
            projectId: "FI_PRIVATE_PROJECT",
            requestId: "request",
          }),
        ),
      ),
    ).toThrow("KAFKA_ENVELOPE_INVALID");
  });
});
