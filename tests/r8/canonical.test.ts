import { describe, expect, it } from "vitest";
// @ts-expect-error The scanner is an executable ESM tool.
import { findViolations } from "../../tools/check-canonical-names.mjs";
describe("canonical cleanup guard", () => {
  it("rejects obsolete fields, storage, metric aliases and positive old contracts", () => {
    for (const text of [
      'projectKey: "x"',
      'eventName: "x"',
      "visitor_id String",
      "page_views: 1",
      "schemaVersion: 2",
      'event: "feature_started"',
      "businessDomain: {}",
    ])
      expect(findViolations(text).length).toBeGreaterThan(0);
  });
  it("keeps technical routing, schema properties and canonical custom payload names", () => {
    expect(
      findViolations(
        'const route = useRoute(); const schema = { properties: {} }; const e = {schemaVersion: 3, event: "custom", payload: {name: "feature_started"}};',
      ),
    ).toEqual([]);
  });
});
