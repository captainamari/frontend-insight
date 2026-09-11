import test from "node:test";
import assert from "node:assert/strict";
import { corsHeadersFor } from "../src/cors.mjs";
import { validateEventBatch } from "../src/event.mjs";

const allowedOrigin = "http://localhost:4173";

function event(overrides = {}) {
  return {
    eventId: "00000000-0000-4000-8000-000000000001",
    eventType: "feature_action_succeeded",
    projectKey: "admin",
    featureKey: "export-data",
    accountRef: "opaque-account-ref",
    sessionId: "session-01",
    occurredAt: "2026-07-19T12:34:56.789Z",
    ...overrides,
  };
}

test("CORS allows only the exact configured browser origin", () => {
  assert.equal(corsHeadersFor(undefined, allowedOrigin), null);
  assert.equal(corsHeadersFor("http://localhost:4174", allowedOrigin), null);
  assert.equal(
    corsHeadersFor(allowedOrigin, allowedOrigin)[
      "access-control-allow-origin"
    ],
    allowedOrigin,
  );
});

test("accepts a minimal product event batch", () => {
  assert.equal(validateEventBatch({ events: [event()] }), null);
});

test("rejects empty, oversized and malformed event batches", () => {
  assert.match(validateEventBatch({ events: [] }), /non-empty/);
  assert.match(
    validateEventBatch({ events: Array.from({ length: 101 }, () => event()) }),
    /at most 100/,
  );
  assert.match(
    validateEventBatch({ events: [event({ occurredAt: "not-a-date" })] }),
    /ISO-8601/,
  );
  assert.match(
    validateEventBatch({ events: [event({ eventId: "not-a-uuid" })] }),
    /UUID/,
  );
});
