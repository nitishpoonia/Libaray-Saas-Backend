import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { unauthorized } from "../lib/errors";

export const authMiddleware: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw unauthorized();
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    if (typeof payload.id !== "number") throw unauthorized("Invalid token", "INVALID_TOKEN");
    req.user = { id: payload.id };
  } catch {
    throw unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }
  next();
};
