import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { EventConsumerRuntime } from "../src/index.js";
import { REPEATED_TOPIC } from "@frontend-insight/server-core";
import type { ConsumerRunConfig } from "kafkajs";

// Exercise the locked KafkaJS implementation's filtering/resolution boundary.
const require = createRequire(import.meta.url);
const Batch = require("kafkajs/src/consumer/batch");
const Runner = require("kafkajs/src/consumer/runner");
const first = "9007199254740993";
const message = (offset: string, isControlRecord = false) => ({
  offset,
  value: Buffer.from("invalid"),
  isControlRecord,
});

async function harness(topic: string, messages: ReturnType<typeof message>[]) {
  const run = vi.fn<(config: ConsumerRunConfig) => Promise<void>>().mockResolvedValue();
  const deadLetter = vi.fn(async () => {});
  const runtime = Object.assign(Object.create(EventConsumerRuntime.prototype), {
    environment: {
      KAFKA_EVENTS_TOPIC: "frontend-insight.events.v1",
      CONSUMER_BATCH_SIZE: 1,
      CONSUMER_MAX_RETRIES: 3,
    },
    startHealthServer: vi.fn(),
    consumer: { connect: vi.fn(), subscribe: vi.fn(), run },
    dlqProducer: { connect: vi.fn() },
    attempts: new Map(),
    metrics: { processedEvents: 0, insertedBatches: 0, retries: 0 },
    deadLetter,
  });
  await runtime.start();
  const config = run.mock.calls[0]![0];
  const resolveOffset = vi.fn();
  const commit = vi.fn(async () => {});
  const runner = Object.assign(Object.create(Runner.prototype), config, {
    running: true,
    consumerGroup: {
      resolveOffset,
      commitOffsets: commit,
      commitOffsetsIfNecessary: commit,
    },
    heartbeat: vi.fn(),
    instrumentationEmitter: { emit: vi.fn() },
    logger: { error: vi.fn() },
  });
  const batch = new Batch(topic, first, {
    partition: 2,
    highWatermark: (BigInt(messages.at(-1)!.offset) + 1n).toString(),
    abortedTransactions: [],
    messages,
  });
  return { runtime, runner, batch, deadLetter, resolveOffset, commit, config };
}

describe("R8 durable consumer offsets", () => {
  it.each(["frontend-insight.events.v1", REPEATED_TOPIC])(
    "%s resolves only the durable slice and leaves an unread suffix",
    async (topic) => {
      const h = await harness(topic, [
        message(first),
        message("9007199254740994"),
        message("9007199254740995", true),
      ]);
      await h.runner.handleBatch(h.batch);
      expect(h.deadLetter).toHaveBeenCalledTimes(1);
      expect(h.resolveOffset).toHaveBeenCalledExactlyOnceWith({
        topic,
        partition: 2,
        offset: first,
      });
      expect(h.deadLetter.mock.invocationCallOrder[0]).toBeLessThan(
        h.resolveOffset.mock.invocationCallOrder[0]!,
      );
      expect(h.resolveOffset.mock.invocationCallOrder[0]).toBeLessThan(
        h.commit.mock.invocationCallOrder[0]!,
      );
      h.resolveOffset.mockClear();
      h.deadLetter.mockRejectedValueOnce(new Error("DLQ_UNAVAILABLE"));
      await expect(h.runner.handleBatch(h.batch)).rejects.toThrow("DLQ_UNAVAILABLE");
      expect(h.resolveOffset).not.toHaveBeenCalled();
    },
  );

  it("includes a hidden transactional tail after the last visible durable message", async () => {
    const h = await harness(REPEATED_TOPIC, [
      message(first),
      message("9007199254740994", true),
    ]);
    await h.runner.handleBatch(h.batch);
    expect(h.resolveOffset).toHaveBeenCalledExactlyOnceWith({
      topic: REPEATED_TOPIC,
      partition: 2,
      offset: "9007199254740994",
    });
    expect(h.commit).toHaveBeenCalledWith();
    expect(h.config.autoCommitThreshold).toBe(1);
  });

  it("persists a control-only batch even when KafkaJS never invokes eachBatch", async () => {
    const h = await harness(REPEATED_TOPIC, [message(first, true)]);
    await h.runner.handleBatch(h.batch);
    expect(h.deadLetter).not.toHaveBeenCalled();
    expect(h.resolveOffset).toHaveBeenCalledExactlyOnceWith({
      topic: REPEATED_TOPIC,
      partition: 2,
      offset: first,
    });
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it("does not advance past an earlier failed insert because a later message reached DLQ", async () => {
    const h = await harness("frontend-insight.events.v1", [
      message(first),
      message("9007199254740994"),
    ]);
    h.runtime.environment.CONSUMER_BATCH_SIZE = 2;
    h.runtime.parseEnvelope = vi
      .fn()
      .mockReturnValueOnce({
        projectId: "test",
        receivedAt: "2026-10-08T00:00:00Z",
        batch: { events: [] },
        enrichments: [],
      })
      .mockImplementationOnce(() => {
        throw new Error("INVALID");
      });
    h.runtime.rows = () => [{}];
    h.runtime.clickhouse = { insert: vi.fn().mockRejectedValue(new Error("CH_DOWN")) };
    await expect(h.runner.handleBatch(h.batch)).rejects.toThrow("CH_DOWN");
    expect(h.deadLetter).toHaveBeenCalledTimes(1);
    expect(h.resolveOffset).not.toHaveBeenCalled();
  });
});
