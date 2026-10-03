import type { RequestHandler } from "express";
import { unauthorized } from "../lib/errors";
import { verifyAccessToken } from "../lib/tokens";

/**
 * Verifies the short-lived access token. It doesn't hit the database: a revoked
 * session keeps working until its access token expires (15 minutes by default),
 * after which the refresh call fails and the app logs out.
 */
export const authMiddleware: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();

  try {
    const { sub, sid } = verifyAccessToken(header.slice("Bearer ".length));
    req.user = { id: sub, sessionId: sid };
  } catch {
    throw unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }
  next();
};
