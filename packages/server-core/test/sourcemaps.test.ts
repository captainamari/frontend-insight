import { describe, it, expect } from "vitest";
import {
  canonicalAsset,
  parseSourceMap,
  SOURCEMAP_LIMITS,
} from "../src/sourcemap-parser.js";
const source =
  '// 中文😀\r\nexport function source() {\r\n  throw new Error("自有源码");\r\n}';
const map = JSON.stringify({
  version: 3,
  sources: ["源码.ts"],
  sourceRoot: "webpack:///src/",
  sourcesContent: [source],
  names: ["source"],
  mappings: "AAEEA",
});
describe("D5 bounded parsing and exact assets", () => {
  it("maps 1-based browser coordinates and bounded unicode CRLF source without fetching sourceRoot", async () => {
    const result = await parseSourceMap(map, [{ line: 1, column: 1 }]);
    expect(result.frames[0]).toMatchObject({
      state: "mapped",
      original: {
        file: "webpack:///src/源码.ts",
        function: "source",
        line: 3,
        column: 3,
      },
    });
    expect(result.frames[0]?.snippet?.[2]?.text).toContain("自有源码");
    expect((await parseSourceMap(map, [{ line: 2, column: 1 }])).frames[0]?.state).toBe(
      "mapping_not_found",
    );
  });
  it("supports unnamed frames and no sourcesContent; never opens file sources", async () => {
    const m = JSON.stringify({
      version: 3,
      sources: ["file:///etc/passwd"],
      names: [],
      mappings: "AAAA",
    });
    expect((await parseSourceMap(m, [{ line: 1, column: 1 }])).frames[0]).toEqual({
      state: "no_sources_content",
      original: { file: "file:///etc/passwd", function: null, line: 1, column: 1 },
    });
  });
  it("rejects indexed maps including remote section URLs and malformed formats", async () => {
    for (const m of [
      JSON.stringify({
        version: 3,
        sections: [{ url: "https://never.invalid/x.map" }],
      }),
      JSON.stringify({ version: 2 }),
    ])
      expect((await parseSourceMap(m)).state).toBe("unsupported_format");
    for (const m of [
      "invalid",
      JSON.stringify({ version: 3, sources: [], names: [], mappings: "AAAA" }),
      JSON.stringify({ version: 3, sources: ["x"], names: [], mappings: "?" }),
    ])
      expect((await parseSourceMap(m)).state).toBe("parse_failed");
  });
  it("enforces file, complexity, frame and snippet limits", async () => {
    expect(
      (await parseSourceMap(" ".repeat(SOURCEMAP_LIMITS.mapBytes + 1))).state,
    ).toBe("parse_budget");
    expect(
      (
        await parseSourceMap(
          map,
          Array.from({ length: 33 }, () => ({ line: 1, column: 1 })),
        )
      ).state,
    ).toBe("parse_budget");
    expect(
      (
        await parseSourceMap(
          JSON.stringify({
            version: 3,
            sources: ["x"],
            names: [],
            mappings: "AAAA," + "AAAA,".repeat(100001),
          }),
        )
      ).state,
    ).toBe("parse_budget");
    const large = JSON.stringify({
      version: 3,
      sources: ["x"],
      sourcesContent: ["x".repeat(5000)],
      names: [],
      mappings: "AAAA",
    });
    expect(
      (await parseSourceMap(large, [{ line: 1, column: 1 }])).frames[0]?.state,
    ).toBe("output_budget");
  });
  it("retains CDN origin and query and requires explicit base for relative assets", () => {
    expect(canonicalAsset("/assets/a.js?v=1", "https://cdn.invalid/")).toBe(
      "https://cdn.invalid/assets/a.js?v=1",
    );
    expect(canonicalAsset("https://cdn.invalid/a.js?v=1#x")).not.toBe(
      canonicalAsset("https://other.invalid/a.js?v=1"),
    );
    expect(canonicalAsset("https://cdn.invalid/a.js?v=1")).not.toBe(
      canonicalAsset("https://cdn.invalid/a.js?v=2"),
    );
    for (const s of [
      "../a.js",
      "/a.js",
      "file:///tmp/a.js",
      "https://u:pw@x/a",
      "https://x/../a",
      "https://x/%2e%2e/a",
      "https://x/a\\b",
    ])
      expect(() => canonicalAsset(s)).toThrow();
  });
});
