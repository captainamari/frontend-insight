import { describe, expect, it } from "vitest";
import {
  pageRoutePreview,
  selectorIsFragile,
  triggerConfigKey,
} from "../src/analysis-objects";

describe("R1-A analysis object presentation", () => {
  it("previews the same common dynamic route normalization as the API", () => {
    expect(pageRoutePreview("/orders/123/items/0123456789abcdef")).toBe(
      "/orders/:id/items/:id",
    );
    expect(pageRoutePreview("/orders?token=secret")).toBeNull();
  });

  it("shows a fragility warning only for ordinary class selectors", () => {
    expect(selectorIsFragile("selector", ".download-button")).toBe(true);
    expect(selectorIsFragile("selector", '[data-fi-action="download"]')).toBe(false);
    expect(triggerConfigKey("explicit_sdk")).toBe("actionKey");
  });
});
