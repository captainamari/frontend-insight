import { describe, expect, it } from "vitest";
import {
  generateObjectReferenceKey,
  mintBusinessObjectReference,
  verifyBusinessObjectReference,
  type ObjectReferenceKey,
} from "../src/object-reference.js";
const day = 86400000,
  projectId = "11111111-1111-4111-8111-111111111111";
const allKeys = Array.from({ length: 9 }, (_, i) => generateObjectReferenceKey(97 + i));
const ring = (epoch: number): ObjectReferenceKey[] =>
  allKeys.filter((k) => k.epoch <= epoch && k.epoch > epoch - 4);
const issue = (at = 100 * day + 1000, extra = {}) =>
  mintBusinessObjectReference({
    projectId,
    env: "dev",
    objectType: "order",
    rawObjectId: "RAW_BUSINESS_ID_SENTINEL",
    issuedAt: at,
    keys: ring(Math.floor(at / day)),
    ...extra,
  });
const context = (at = 100 * day + 1000) => ({
  projectId,
  env: "dev",
  allowedObjectTypes: ["order"],
  eventAt: at,
  receivedAt: at,
  keys: ring(Math.floor(at / day)),
});
describe("C04 trusted-backend rotating object reference", () => {
  it("keeps the raw ID and secrets out of the browser ticket and validates a scoped signature", () => {
    const ticket = issue(),
      body = verifyBusinessObjectReference(ticket, context());
    expect(ticket.length).toBeLessThanOrEqual(2048);
    expect(body.aliases).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain("RAW_BUSINESS_ID_SENTINEL");
    for (const k of allKeys)
      expect(JSON.stringify(body)).not.toContain(Buffer.from(k.secret).toString("hex"));
    expect(() =>
      verifyBusinessObjectReference(ticket, {
        ...context(),
        projectId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow("OBJECT_REFERENCE_SCOPE_MISMATCH");
    expect(() =>
      verifyBusinessObjectReference(ticket, { ...context(), env: "prod" }),
    ).toThrow("OBJECT_REFERENCE_SCOPE_MISMATCH");
    expect(() =>
      verifyBusinessObjectReference(ticket, {
        ...context(),
        allowedObjectTypes: ["invoice"],
      }),
    ).toThrow("OBJECT_REFERENCE_SCOPE_MISMATCH");
  });
  it("bridges rotation across midnight and up to 72h issue-time separation without changing the rolling 24h metric window", () => {
    const a = verifyBusinessObjectReference(issue(), context());
    for (let days = 1; days <= 3; days++) {
      const at = (100 + days) * day + 1000;
      const b = verifyBusinessObjectReference(issue(at), context(at));
      expect(
        a.aliases.some((x) =>
          b.aliases.some((y) => x.epoch === y.epoch && x.digest === y.digest),
        ),
      ).toBe(true);
    }
    const at = 104 * day + 1000;
    const b = verifyBusinessObjectReference(issue(at), context(at));
    expect(a.aliases.some((x) => b.aliases.some((y) => x.digest === y.digest))).toBe(
      false,
    );
  });
  it("separates object types and objects even with the same project key", () => {
    const a = verifyBusinessObjectReference(issue(), context());
    const b = verifyBusinessObjectReference(
      issue(undefined, { rawObjectId: "OTHER" }),
      context(),
    );
    const c = verifyBusinessObjectReference(
      issue(undefined, { objectType: "invoice" }),
      { ...context(), allowedObjectTypes: ["invoice"] },
    );
    expect(
      a.aliases.some((x) =>
        [...b.aliases, ...c.aliases].some((y) => y.digest === x.digest),
      ),
    ).toBe(false);
  });
  it("rejects tampering, short keys, missing overlap keys and expired or incompatible clocks", () => {
    const ticket = issue();
    const [body, signature] = ticket.split(".");
    const replacement = signature!.startsWith("a") ? "b" : "a";
    expect(() =>
      verifyBusinessObjectReference(
        body + "." + replacement + signature!.slice(1),
        context(),
      ),
    ).toThrow("OBJECT_REFERENCE_SIGNATURE_INVALID");
    expect(() => issue(undefined, { keys: [generateObjectReferenceKey(100)] })).toThrow(
      "OBJECT_REFERENCE_OVERLAP_KEYS_MISSING",
    );
    expect(() =>
      issue(undefined, { keys: [{ epoch: 100, secret: new Uint8Array(4) }] }),
    ).toThrow("OBJECT_REFERENCE_KEYS_INVALID");
    const c = {
      ...context(),
      eventAt: 101 * day + 1000,
      receivedAt: 102 * day + 1000,
      keys: ring(102),
    };
    expect(() => verifyBusinessObjectReference(ticket, c)).not.toThrow();
    expect(() =>
      verifyBusinessObjectReference(ticket, { ...c, receivedAt: c.receivedAt + 1 }),
    ).toThrow("OBJECT_REFERENCE_EXPIRED_OR_CLOCK_INVALID");
    expect(() =>
      verifyBusinessObjectReference("RAW_BUSINESS_ID_SENTINEL", context()),
    ).toThrow("OBJECT_REFERENCE_INVALID");
  });
});
