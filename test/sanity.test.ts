import { describe, it, expect } from "vitest";

describe("pipeline sanity", () => {
  it("runs the test gate green", () => {
    expect(1 + 1).toBe(2);
  });
});
