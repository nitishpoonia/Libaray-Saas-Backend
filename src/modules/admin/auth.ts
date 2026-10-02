import bcrypt from "bcrypt";
import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../lib/db";
import { AppError, unauthorized } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { decryptSecret, verifyTotp } from "../../lib/totp";

/**
 * Platform admin authentication. Kept apart from customer auth on purpose:
 *   - admins live in their own table and are only made by `npm run admin:create`
 *   - tokens are signed with ADMIN_JWT_SECRET and audience "admin", so a customer
 *     token can't pass here and an admin token can't pass on /v1
 *   - every login needs password + a 6-digit authenticator code
 *   - every request checks the session row, so revoking it cuts access at once
 */

const AUDIENCE = "admin";
const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so timing doesn't reveal which admins exist.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

export type AdminConfig = { jwtSecret: string; totpKey: string; sessionHours: number };

/** The admin settings, or 503 when the admin API isn't switched on. */
export function adminConfig(): AdminConfig {
  if (!env.ADMIN_JWT_SECRET || !env.ADMIN_TOTP_KEY) {
    throw new AppError(503, "ADMIN_DISABLED", "The admin API is not configured");
  }
  return { jwtSecret: env.ADMIN_JWT_SECRET, totpKey: env.ADMIN_TOTP_KEY, sessionHours: env.ADMIN_SESSION_HOURS };
}

export const hashAdminPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

const badLogin = () => unauthorized("Incorrect email, password or code", "INVALID_CREDENTIALS");

export async function adminLogin(
  input: { email: string; password: string; code: string },
  ip: string | undefined,
  now = new Date(),
) {
  const config = adminConfig();
  const admin = await prisma.adminUser.findUnique({ where: { email: input.email } });
  const passwordOk = await bcrypt.compare(input.password, admin?.passwordHash ?? DUMMY_HASH);
  // One answer for every failure, so it never says which part was wrong.
  if (!admin || admin.disabledAt || !passwordOk) throw badLogin();

  const step = verifyTotp(decryptSecret(admin.totpSecret, config.totpKey), input.code, now, admin.lastTotpStep);
  if (step === null) throw badLogin();

  return prisma.$transaction(async (tx) => {
    // Claim the code: of two logins with the same code, only one gets through.
    const { count } = await tx.adminUser.updateMany({
      where: { id: admin.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step, lastLoginAt: now },
    });
    if (count === 0) throw badLogin();

    const expiresAt = new Date(now.getTime() + config.sessionHours * 60 * 60 * 1000);
    const session = await tx.adminSession.create({ data: { adminId: admin.id, expiresAt, ip } });
    await audit(tx, { adminId: admin.id, action: "auth.login", ip });

    const token = jwt.sign({ sid: session.id }, config.jwtSecret, {
      subject: String(admin.id),
      audience: AUDIENCE,
      expiresIn: config.sessionHours * 60 * 60,
    });
    return {
      token,
      expiresAt,
      admin: { id: admin.id, email: admin.email, name: admin.name },
    };
  });
}

export async function adminLogout(sessionId: number) {
  await prisma.adminSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Guards every admin route except login. */
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  const config = adminConfig();
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();

  let adminId: number;
  let sessionId: number;
  try {
    const payload = jwt.verify(header.slice("Bearer ".length), config.jwtSecret, {
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    adminId = Number(payload.sub);
    sessionId = Number(payload.sid);
    if (!Number.isInteger(adminId) || !Number.isInteger(sessionId)) throw new Error("malformed");
  } catch {
    throw unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }

  const session = await prisma.adminSession.findFirst({
    where: { id: sessionId, adminId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { admin: { select: { email: true, disabledAt: true } } },
  });
  if (!session || session.admin.disabledAt) {
    throw unauthorized("Session ended, please log in again", "SESSION_EXPIRED");
  }

  req.admin = { id: adminId, sessionId, email: session.admin.email };
  next();
};

export function requireAdminUser(req: Request) {
  if (!req.admin) throw new Error("requireAdmin did not run for this route");
  return req.admin;
}

/** Records one admin action. Call it inside the same transaction as the change. */
export async function audit(
  db: Db,
  entry: {
    adminId: number;
    action: string;
    targetType?: string;
    targetId?: number;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
    ip?: string;
  },
) {
  await db.adminAuditLog.create({ data: entry });
}

const skip = () => env.NODE_ENV === "test";
const limitReached = {
  error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again in 15 minutes." },
};

/** Admin login: 10 per IP and 5 per email per 15 minutes. */
export const adminLoginLimiters = [
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: limitReached, standardHeaders: "draft-8", legacyHeaders: false, skip }),
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyGenerator: (req) => `admin:${String(req.body?.email ?? "").trim().toLowerCase()}`,
    message: limitReached,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip,
  }),
];
