import { z } from "zod";
import { isIsoDate } from "./dates";
import { normalizeIndianMobile } from "./phone";
import { parseTime } from "../modules/memberships/slots";

/** Shared input rules, so the same field is validated the same way on every route. */

// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
export const password = z.string().min(8, "At least 8 characters").max(72, "At most 72 characters");

export const personName = z.string().trim().min(2, "At least 2 characters").max(100);

export const email = z.string().trim().toLowerCase().email();

export const indianMobile = z.string().transform((value, ctx) => {
  const normalized = normalizeIndianMobile(value);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "Enter a valid 10-digit Indian mobile number" });
    return z.NEVER;
  }
  return normalized;
});

/** "YYYY-MM-DD" */
export const isoDate = z.string().refine(isIsoDate, "Use the format YYYY-MM-DD");

/** "HH:MM" -> minutes from midnight */
export const timeOfDay = z.string().transform((value, ctx) => {
  const minutes = parseTime(value);
  if (minutes === null) {
    ctx.addIssue({ code: "custom", message: "Use 24-hour HH:MM, e.g. 09:00 or 22:30" });
    return z.NEVER;
  }
  return minutes;
});

/**
 * True when `n` has at most 2 decimal places. Floating point makes an exact check
 * wrong (1.15 * 100 is 114.99999999999999), so it allows a tiny error instead.
 */
export function hasAtMostTwoDecimals(n: number): boolean {
  const paise = n * 100;
  return Math.abs(paise - Math.round(paise)) < 1e-6;
}

/** Rupees with up to 2 decimals, sent as number or string. */
export const rupees = z.coerce
  .number()
  .finite()
  .refine(hasAtMostTwoDecimals, "At most 2 decimal places")
  .refine((n) => n <= 10_000_000, "Amount is too large");

export const positiveRupees = rupees.refine((n) => n > 0, "Must be more than 0");

export const id = z.coerce.number().int().positive();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
