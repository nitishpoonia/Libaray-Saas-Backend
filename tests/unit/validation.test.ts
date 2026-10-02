import { describe, expect, it } from "vitest";
import { loginAccountKey } from "../../src/middleware/rateLimiters";
import { hasAtMostTwoDecimals, positiveRupees } from "../../src/lib/validation";

describe("rupee amounts", () => {
  it("accepts amounts that floating point can't represent exactly", () => {
    // 1.15 * 100 is 114.99999999999999 in JavaScript.
    for (const amount of [1.15, 4.35, 0.29, 0.07, 100.29, 1234.56, 999, 10_000_000]) {
      expect(positiveRupees.safeParse(amount).success, String(amount)).toBe(true);
    }
    expect(positiveRupees.safeParse("4.35").success).toBe(true);
  });

  it("rejects more than 2 decimal places", () => {
    for (const amount of [1.155, 0.001, 99.999]) {
      expect(hasAtMostTwoDecimals(amount), String(amount)).toBe(false);
    }
  });
});

describe("login account key", () => {
  it("treats every way of writing the same mobile number as one account", () => {
    const key = loginAccountKey("9876543210");
    expect(loginAccountKey("+91 98765 43210")).toBe(key);
    expect(loginAccountKey("09876543210")).toBe(key);
  });

  it("ignores case and spaces in emails", () => {
    expect(loginAccountKey("  Asha@Example.com ")).toBe(loginAccountKey("asha@example.com"));
  });
});
