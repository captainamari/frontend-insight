import { describe, expect, it } from "vitest";
import {
  generateObjectReferenceKey,
  mintBusinessObjectReference,
  verifyBusinessObjectReference,
  type ObjectReferenceKey,
} from "../src/object-reference.js";
import { repeatedOperationRate } from "../src/repeated-operation.js";
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
  it("feeds verified rotation aliases into the rolling reducer without splitting midnight or counting replay", () => {
    const times = [101 * day - 1, 101 * day, 101 * day + 1];
    const facts = times.map((at, i) => ({
      projectId,
      env: "dev",
      user: "u",
      session: `s${i}`,
      objectType: "order",
      reference: "",
      operationKey: "save",
      instanceId: `i${i}`,
      at,
      received: at,
      aliases: verifyBusinessObjectReference(issue(at), context(at)).aliases,
    }));
    const query = {
      projectId,
      env: "dev",
      from: 100 * day,
      to: 102 * day,
      asOf: 105 * day,
      scannedFrom: 99 * day,
      scannedTo: 103 * day,
      coverage: "proven" as const,
    };
    const result = repeatedOperationRate([...facts].reverse().concat(facts[0]!), query);
    expect(result).toMatchObject({
      numerator: 3,
      denominator: 3,
      observedValue: 1,
      reason: "INSUFFICIENT_SAMPLE",
    });
    expect(JSON.stringify(result)).not.toContain(facts[0]!.aliases[0]!.digest);
    expect(
      repeatedOperationRate(
        facts.map((f, i) =>
          i === 2
            ? {
                ...f,
                aliases: verifyBusinessObjectReference(
                  issue(f.at, { rawObjectId: "OTHER" }),
                  context(f.at),
                ).aliases,
              }
            : f,
        ),
        query,
      ).numerator,
    ).toBe(0);
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
