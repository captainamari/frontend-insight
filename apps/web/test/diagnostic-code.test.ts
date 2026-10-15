import { describe, expect, it } from "vitest";
import { diagnosticCodeText, tokenizeDiagnosticCode } from "../src/diagnostic-code";

describe("diagnostic code rendering", () => {
  it("formats structured values without changing their content", () => {
    expect(diagnosticCodeText({ html: "<svg onload=alert(1)>", count: 2 })).toBe(
      '{\n  "html": "<svg onload=alert(1)>",\n  "count": 2\n}',
    );
  });

  it("tokenizes JSON while preserving the exact source text", () => {
    const source = '  "html": "<script>alert(1)</script>", "ok": true, "n": 12';
    const tokens = tokenizeDiagnosticCode(source, "json");
    expect(tokens.map((item) => item.text).join("")).toBe(source);
    expect(
      tokens.filter((item) => item.kind === "property").map((item) => item.text),
    ).toEqual(['"html"', '"ok"', '"n"']);
    expect(
      tokens.some((item) => item.kind === "string" && item.text.includes("script")),
    ).toBe(true);
    expect(tokens.some((item) => item.kind === "keyword" && item.text === "true")).toBe(
      true,
    );
  });

  it("separates stack function, path and coordinates without rewriting the frame", () => {
    const source = "    at renderChart (/assets/app.js:10:20)";
    const tokens = tokenizeDiagnosticCode(source, "stack");
    expect(tokens.map((item) => item.text).join("")).toBe(source);
    expect(tokens).toContainEqual({ kind: "function", text: "renderChart" });
    expect(tokens).toContainEqual({ kind: "path", text: "/assets/app.js" });
    expect(tokens).toContainEqual({ kind: "number", text: ":10:20" });
  });

  it("keeps arbitrary text as one inert token", () => {
    const source = '<img src=x onerror="globalThis.pwned=true">';
    expect(tokenizeDiagnosticCode(source, "text")).toEqual([
      { kind: "text", text: source },
    ]);
  });
});
