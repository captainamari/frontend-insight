import test from "node:test";
import assert from "node:assert/strict";
import { findCredentialLeak } from "../src/security.mjs";

test("allows opaque account references and product event keys", () => {
  const payload = {
    events: [
      {
        accountRef: "opaque-account-123",
        projectKey: "internal-admin",
        featureKey: "export-report",
        metadata: { result: "succeeded" },
      },
    ],
  };

  assert.equal(findCredentialLeak(payload), null);
});

test("rejects sensitive fields at any nesting level", () => {
  assert.match(
    findCredentialLeak({ events: [{ metadata: { access_token: "abc" } }] }),
    /forbidden credential field/,
  );
  assert.match(
    findCredentialLeak({ events: [{ Cookie: "session=abc" }] }),
    /forbidden credential field/,
  );
});

test("rejects Bearer and JWT-like values even under neutral keys", () => {
  assert.match(
    findCredentialLeak({ metadata: { value: "Bearer secret-value" } }),
    /Bearer credential/,
  );
  assert.match(
    findCredentialLeak({ metadata: { value: "eyJabcdefgh.abcdefghijk.abcdefghijk" } }),
    /JWT-like credential/,
  );
});
