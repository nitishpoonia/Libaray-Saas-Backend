import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { normalizeIndianMobile } from "../lib/phone";

// Tests make many requests from one IP; limits are covered by the library itself.
const skip = () => env.NODE_ENV === "test";

const limitReached = {
  error: { code: "RATE_LIMITED", message: "Too many requests, please try again later." },
};

/**
 * Login and signup, per IP: 30 per 10 minutes.
 * Indian mobile networks put many users behind one public IP (CGNAT), so a tight
 * per-IP limit would lock out a whole neighbourhood. This one only stops a single
 * machine hammering the endpoints; loginAccountLimiter protects each account.
 */
export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  message: limitReached,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
});

/** The account a login attempt is for, normalised so "+91 98765 43210" and "9876543210" match. */
export function loginAccountKey(identifier: unknown): string {
  const value = String(identifier ?? "").trim().toLowerCase();
  if (value.includes("@")) return `email:${value}`;
  return `phone:${normalizeIndianMobile(value) ?? value}`;
}

/** Login, per account: 5 wrong-or-right attempts per 10 minutes, from any IP. */
export const loginAccountLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => loginAccountKey(req.body?.identifier),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many login attempts for this account. Try again in 10 minutes.",
    },
  },
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
});

/** Everything else: 300 requests per IP per 10 minutes. */
export const generalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  message: limitReached,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
});
