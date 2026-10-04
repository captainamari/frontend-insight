import { describe, it, expect } from "vitest";
import { mintBusinessObjectReference } from "../src/object-reference.js";
import {
  objectReferenceKeys,
  verifyObjectOperation,
  parseObjectOperations,
  repeatedProofs,
} from "../src/repeated-projection.js";
import { readRepeatedRate } from "../src/repeated-read-model.js";
import type { BusinessPageWindow } from "../src/business-facts.js";
const day = 86400000,
  at = 100 * day,
  project = "11111111-1111-4111-8111-111111111111",
  secret = "s".repeat(32);
const fact = (i: number, raw = "same") => {
  const time = at + i * 1000;
  const ticket = mintBusinessObjectReference({
    projectId: project,
    env: "dev",
    objectType: "order",
    rawObjectId: raw,
    issuedAt: time,
    keys: objectReferenceKeys(secret, project, "dev", time),
  });
  return verifyObjectOperation(
    ticket,
    {
      project,
      env: "dev",
      user: "a".repeat(64),
      session: `ses_${i}`,
      instance: `op_${i}`,
      operation: "save",
      at: time,
      received: time,
    },
    secret,
  );
};
const facts = [fact(0), fact(1), fact(2), fact(3, "second"), fact(4, "third")];
const events = facts.map((f) => ({
  at: f.at,
  received: f.received,
  user: f.user,
  session: f.session,
  page: "/",
  payload: {
    name: "feature_started",
    featureKey: f.operation,
    operationInstanceId: f.instance,
    repeatedEligible: true,
  },
}));
const context = {
  from: at,
  to: at + day,
  asOf: at + 3 * day,
  moduleId: "m",
  pages: [
    {
      included: true,
      pageRoute: "/",
      moduleId: "m",
      from: new Date(at - day).toISOString(),
      to: new Date(at + day).toISOString(),
    } as BusinessPageWindow,
  ],
};
describe("R4-C short channel to reference-free session proofs", () => {
  it("projects 3 of 5 related cohorts and keeps object identifiers out of durable proofs and API", () => {
    const proofs = repeatedProofs(facts, at + day);
    const result = readRepeatedRate(events, proofs, context);
    expect(result).toMatchObject({
      value: 0.6,
      numerator: 3,
      denominator: 5,
      status: "available",
    });
    expect(JSON.stringify(proofs)).not.toContain(facts[0]!.aliases[0]!.digest);
    expect(JSON.stringify(result)).not.toContain("op_");
  });
  it("is replay/order independent and rejects conflicting operation instances", () => {
    const proofs = repeatedProofs([...facts].reverse().concat(facts[0]!), at + day);
    expect(
      readRepeatedRate(events.concat(events[0]!), proofs.concat(proofs), context).value,
    ).toBe(0.6);
    expect(() =>
      repeatedProofs(facts.concat({ ...facts[0]!, user: "b".repeat(64) }), at),
    ).toThrow("REPEATED_INSTANCE_CONFLICT");
  });
  it("keeps missing receipts, open lookahead, retention and historical asOf unavailable", () => {
    const proofs = repeatedProofs(facts, at + day);
    expect(readRepeatedRate(events, [], context).reason).toBe(
      "REPEATED_PROJECTION_INCOMPLETE",
    );
    expect(
      readRepeatedRate(events, proofs, { ...context, asOf: at + day }).reason,
    ).toBe("REPEATED_LATENESS_WINDOW_OPEN");
    expect(
      readRepeatedRate(events, proofs, { ...context, asOf: at + 91 * day }).reason,
    ).toBe("FACT_RETENTION_RANGE_NOT_COVERED");
    expect(
      readRepeatedRate(events, proofs, { ...context, asOf: at + 5000 }).reason,
    ).toBe("REPEATED_PROJECTION_INCOMPLETE");
  });
  it("rejects expired, forged and unbounded short envelopes without echoing values", () => {
    expect(() => parseObjectOperations(facts, at + day)).not.toThrow();
    expect(() => parseObjectOperations(facts, at + 2 * day)).toThrow(
      "OBJECT_ENVELOPE_INVALID_OR_EXPIRED",
    );
    expect(() =>
      parseObjectOperations(
        [{ ...facts[0]!, aliases: [{ epoch: 100, digest: "RAW_OBJECT_ID" }] }],
        at,
      ),
    ).toThrow();
    expect(() => parseObjectOperations(Array(51).fill(facts[0]), at)).toThrow(
      "OBJECT_ENVELOPE_INVALID",
    );
    expect(() => verifyObjectOperation("RAW_OBJECT_ID", facts[0]!, secret)).toThrow(
      "OBJECT_REFERENCE_INVALID",
    );
  });
});
