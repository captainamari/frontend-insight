import { describe, expect, it } from "vitest";
import { formatDuration, formatPercent, formatScore } from "../src/range.js";
describe("formal metric display boundaries", () => {
  it("keeps missing values distinct from measured zero", () => {
    for (const format of [formatDuration, formatPercent, formatScore]) {
      expect(format(null)).toBe("—");
      expect(format(0)).not.toBe("—");
    }
  });
});
