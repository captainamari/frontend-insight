import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("production daemon memory boundary", () => {
  it.each([
    ["16692449280", true], // Jesse's actual 16 GiB-class Ubuntu host
    ["16106127360", true],
    ["16106127359", false],
    ["8589934592", false],
    ["0", false],
    ["unavailable", false],
  ])("validates %s bytes without counting swap", (bytes, accepted) => {
    const result = execFileSync(
      "bash",
      [
        "-c",
        'source scripts/lib/production-capacity.sh; if production_capacity_total_ok "$1"; then echo yes; else echo no; fi',
        "capacity-test",
        bytes,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(result).toBe(accepted ? "yes" : "no");
  });
});
