import { describe, expect, it, vi } from "vitest";
import { EventConsumerRuntime } from "../src/index.js";
import { REPEATED_TOPIC } from "@frontend-insight/server-core";
import type { EachBatchPayload } from "kafkajs";

describe("R8 durable consumer offsets", () => {
  it.each(["frontend-insight.events.v1", REPEATED_TOPIC])(
    "%s commits the next offset explicitly after durable dead-letter handling",
    async (topic) => {
      const deadLetter = vi.fn(async () => {});
      const runtime = Object.assign(Object.create(EventConsumerRuntime.prototype), {
        environment: { CONSUMER_BATCH_SIZE: 1, CONSUMER_MAX_RETRIES: 3 },
        attempts: new Map(),
        metrics: { processedEvents: 0, insertedBatches: 0, retries: 0 },
        deadLetter,
      }) as { eachBatch: (p: EachBatchPayload) => Promise<void> };
      const commit = vi.fn(async () => {});
      const payload = {
        batch: {
          topic,
          partition: 2,
          highWatermark: "9007199254740995",
          messages: [
            { offset: "9007199254740993", value: Buffer.from("invalid") },
            { offset: "9007199254740994", value: Buffer.from("unprocessed") },
          ],
        },
        resolveOffset: vi.fn(),
        heartbeat: vi.fn(async () => {}),
        commitOffsetsIfNecessary: commit,
        isRunning: () => true,
        pause: vi.fn(),
      } as unknown as EachBatchPayload;
      await runtime.eachBatch(payload);
      expect(deadLetter).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith({
        topics: [{ topic, partitions: [{ partition: 2, offset: "9007199254740994" }] }],
      });
      expect(deadLetter.mock.invocationCallOrder[0]).toBeLessThan(
        commit.mock.invocationCallOrder[0]!,
      );
      commit.mockClear();
      deadLetter.mockRejectedValueOnce(new Error("DLQ_UNAVAILABLE"));
      await expect(runtime.eachBatch(payload)).rejects.toThrow("DLQ_UNAVAILABLE");
      expect(commit).not.toHaveBeenCalled();
    },
  );
});
