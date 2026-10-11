import { describe, expect, it } from "vitest";
import { parseErrorStack, diagnosticErrorView } from "../src/error-stack.js";
describe("D1 compiled stack projection (Firefox fixture, not real browser)", () => {
  it.each([
    [
      "    at renderChart (/assets/app.js:10:20)",
      "renderChart",
      "/assets/app.js",
      10,
      20,
    ],
    [
      "    at async renderChart (https://fixture.invalid/app.js?token=synthetic:12:34)",
      "async renderChart",
      "https://fixture.invalid/app.js?token=synthetic",
      12,
      34,
    ],
    [
      "renderChart@http://fixture.invalid/app.js:9:8",
      "renderChart",
      "http://fixture.invalid/app.js",
      9,
      8,
    ],
    ["@./assets/app.js:7:6", null, "./assets/app.js", 7, 6],
    ["    at app.js:5:4", null, "app.js", 5, 4],
    [
      "    at eval (eval at render (/assets/app.js:1:2), <anonymous>:3:4)",
      "eval",
      "<anonymous>",
      3,
      4,
    ],
  ])("parses %s", (raw, fn, file, line, column) => {
    expect(parseErrorStack(raw).frames[0]).toMatchObject({
      raw,
      function: fn,
      file,
      line,
      column,
    });
  });
  it("preserves native frames, no-stack and failed/partial parse states", () => {
    expect(parseErrorStack("map@[native code]").frames[0]?.native).toBe(true);
    expect(parseErrorStack("").state).toBe("unavailable");
    expect(parseErrorStack("UNRECOGNIZED token=synthetic").state).toBe("parse_failed");
    expect(parseErrorStack("Error: x\n at fn (/app.js:1:2)\nunknown").state).toBe(
      "partial",
    );
    const raw = { error: { stack: "UNRECOGNIZED token=synthetic" } };
    expect(diagnosticErrorView(raw).error.stack).toBe(raw.error.stack);
    expect(
      diagnosticErrorView({ error: { resourceUrl: "/file?token=synthetic" } }).stack
        .state,
    ).toBe("not_applicable");
  });
});
