import { describe, expect, it } from "vitest";
import { branchAddonPrice, monthlyPrice, planPrice } from "../../src/modules/billing/pricing";

const prices = { baseMonthly: 99_900, extraBranchMonthly: 49_900 };

describe("pricing (₹999 + ₹499 per extra branch)", () => {
  it("prices by branch count", () => {
    expect(monthlyPrice(1, prices)).toBe(99_900);
    expect(monthlyPrice(3, prices)).toBe(199_700);
  });

  it("gives two months free on yearly", () => {
    expect(planPrice("MONTHLY", 1, prices)).toBe(99_900);
    expect(planPrice("QUARTERLY", 1, prices)).toBe(299_700);
    expect(planPrice("YEARLY", 1, prices)).toBe(999_000);
    expect(planPrice("YEARLY", 2, prices)).toBe(1_498_000);
  });

  it("charges a branch added mid-period for the days left, in whole rupees", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(branchAddonPrice(new Date("2026-01-31T00:00:00Z"), now, prices)).toBe(49_900);
    expect(branchAddonPrice(new Date("2026-01-16T00:00:00Z"), now, prices)).toBe(25_000);
    expect(branchAddonPrice(new Date("2026-01-01T01:00:00Z"), now, prices)).toBe(1_700);
  });
});
