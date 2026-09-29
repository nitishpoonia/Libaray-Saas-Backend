/**
 * Prepaid plans for the whole owner account, priced by branch count.
 * All amounts are in paise (Razorpay's unit): 99_900 = ₹999.
 *
 *   monthly price = base + extra × (branches - 1)
 *   MONTHLY   = 1 month
 *   QUARTERLY = 3 months
 *   YEARLY    = 12 months for the price of 10
 */
export type Plan = "MONTHLY" | "QUARTERLY" | "YEARLY";

export const PLANS: Record<Plan, { months: number; billedMonths: number }> = {
  MONTHLY: { months: 1, billedMonths: 1 },
  QUARTERLY: { months: 3, billedMonths: 3 },
  YEARLY: { months: 12, billedMonths: 10 },
};

export type Prices = { baseMonthly: number; extraBranchMonthly: number };

export function monthlyPrice(branches: number, prices: Prices): number {
  return prices.baseMonthly + prices.extraBranchMonthly * Math.max(0, branches - 1);
}

export function planPrice(plan: Plan, branches: number, prices: Prices): number {
  return monthlyPrice(branches, prices) * PLANS[plan].billedMonths;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adding a branch in the middle of a paid period: the extra-branch price for the days
 * left, rounded up to whole rupees, with a minimum of ₹1 (Razorpay's minimum order).
 */
export function branchAddonPrice(periodEnd: Date, now: Date, prices: Prices): number {
  const daysLeft = Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / DAY_MS));
  const paise = (prices.extraBranchMonthly * daysLeft) / 30;
  return Math.max(100, Math.ceil(paise / 100) * 100);
}
