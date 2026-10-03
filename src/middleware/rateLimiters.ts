import rateLimit from "express-rate-limit";

const limitReached = {
  error: { code: "RATE_LIMITED", message: "Too many requests, please try again later." },
};

/** Login and signup: 5 attempts per IP per 10 minutes. */
export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: limitReached,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

/** Everything else: 300 requests per IP per 10 minutes. */
export const generalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  message: limitReached,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
