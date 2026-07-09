import { describe, it, expect } from "vitest";
import { nowIso } from "./date";

describe("nowIso", () => {
  it("returns a string", () => {
    const result = nowIso();
    expect(typeof result).toBe("string");
  });

  it("string matches ISO 8601 format (rough)", () => {
    const result = nowIso();
    // Pattern: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns current time approximately", () => {
    const before = Date.now();
    const result = nowIso();
    const after = Date.now();
    const parsed = new Date(result).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
