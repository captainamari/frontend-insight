import { describe, it, expect } from "vitest";
import {
  directoryAt,
  validateDirectory,
  type DirectoryVersion,
} from "../src/organization-directory.js";
const first: DirectoryVersion = {
  id: "one",
  env: "dev",
  sourceKey: "fixture",
  coverage: "complete",
  status: "published",
  from: "2026-09-01T00:00:00Z",
  until: "2026-10-01T00:00:00Z",
  entries: [],
};
describe("R4-C temporal directory", () => {
  it("matches event time, not current membership, and never resurrects expired predecessors", () => {
    const second = {
      ...first,
      id: "two",
      from: "2026-09-10T00:00:00Z",
      until: "2026-09-20T00:00:00Z",
    };
    const at = (time: string, env = "dev") =>
      directoryAt(
        [first, second],
        env,
        Date.parse(time),
        Date.parse("2026-09-30T00:00:00Z"),
      )?.id ?? null;
    expect(at("2026-09-09T23:59:59.999Z")).toBe("one");
    expect(at(second.from)).toBe("two");
    expect(at(second.until)).toBeNull();
    expect(at(first.from!, "prod")).toBeNull();
    expect(
      directoryAt([first], "dev", Date.parse(first.from!), Date.parse(first.from!) - 1),
    ).toBeNull();
  });
  it("requires opaque identities, unique members, controlled org IDs and bounded future expiry", () => {
    const now = Date.parse("2026-09-29T00:00:00Z");
    const input = {
      env: "dev" as const,
      sourceKey: "fixture",
      coverage: "unknown" as const,
      validUntil: "2026-10-01T00:00:00Z",
      entries: [
        {
          userId: "u_opaque_fixture_0001",
          deptId: "dept_fixture",
          roleId: "role_fixture",
          eligible: true,
        },
      ],
    };
    expect(() => validateDirectory(input, now)).not.toThrow();
    expect(() =>
      validateDirectory(
        { ...input, entries: [...input.entries, ...input.entries] },
        now,
      ),
    ).toThrow("DIRECTORY_ENTRY_INVALID");
    expect(() =>
      validateDirectory(
        {
          ...input,
          entries: [{ ...input.entries[0]!, userId: "employee@example.com" }],
        },
        now,
      ),
    ).toThrow("DIRECTORY_ENTRY_INVALID");
    expect(() =>
      validateDirectory(
        { ...input, entries: [{ ...input.entries[0]!, deptId: "Finance Department" }] },
        now,
      ),
    ).toThrow("DIRECTORY_ENTRY_INVALID");
    expect(() =>
      validateDirectory({ ...input, validUntil: "2026-09-28T00:00:00Z" }, now),
    ).toThrow("DIRECTORY_INVALID");
    expect(() =>
      validateDirectory(
        {
          ...input,
          entries: Array.from({ length: 501 }, (_, i) => ({
            ...input.entries[0]!,
            userId: `u_opaque_fixture_${i}`,
          })),
        },
        now,
      ),
    ).toThrow("DIRECTORY_INVALID");
  });
});
