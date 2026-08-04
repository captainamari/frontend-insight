import { describe, expect, it } from "vitest";
import { observabilityGroupId } from "../src/index.js";

describe("observability error grouping", () => {
  it("keeps dynamic numbers out of a stable JS error group", () => {
    const first = observabilityGroupId("error_js", {
      errorName: "TypeError",
      errorMessage: "Cannot render device 123456",
      stackTopFrame: "at render (/assets/app.aabbccddeeff0011.js:10:20)",
    });
    const second = observabilityGroupId("error_js", {
      errorName: "TypeError",
      errorMessage: "Cannot render device 987654",
      stackTopFrame: "at render (/assets/app.1122334455667788.js:90:4)",
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("groups API errors by method, normalized path and status class", () => {
    const first = observabilityGroupId("error_api", {
      requestMethod: "GET",
      requestPath: "/api/devices/:id",
      statusCode: 500,
    });
    const second = observabilityGroupId("error_api", {
      requestMethod: "GET",
      requestPath: "/api/devices/:id",
      statusCode: 503,
    });
    const notFound = observabilityGroupId("error_api", {
      requestMethod: "GET",
      requestPath: "/api/devices/:id",
      statusCode: 404,
    });
    expect(second).toBe(first);
    expect(notFound).not.toBe(first);
  });
});
