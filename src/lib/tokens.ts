import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type AccessTokenPayload = { sub: number; sid: number };

export function signAccessToken(userId: number, sessionId: number): string {
  return jwt.sign({ sid: sessionId }, env.JWT_SECRET, {
    subject: String(userId),
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  });
}

/** Throws if the token is invalid or expired. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
  const sub = Number(payload.sub);
  if (!Number.isInteger(sub) || typeof payload.sid !== "number") {
    throw new Error("Malformed access token");
  }
  return { sub, sid: payload.sid };
}

/** A random opaque refresh token. Only its hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
