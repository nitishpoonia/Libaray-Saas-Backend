import bcrypt from "bcrypt";
import { env } from "../../config/env";
import { conflict, unauthorized } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { hashToken, newRefreshToken, signAccessToken } from "../../lib/tokens";

const BCRYPT_ROUNDS = 12;

// Compared against when the user doesn't exist, so a wrong email takes as long as a
// wrong password and response timing doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

type Identifier = { email: string } | { phone: string };

export type AuthTokens = { accessToken: string; refreshToken: string; expiresIn: number };

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/** Creates a session row and returns the token pair for it. */
export async function startSession(userId: number): Promise<AuthTokens> {
  const refreshToken = newRefreshToken();
  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiry(),
    },
  });
  return {
    accessToken: signAccessToken(userId, session.id),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  };
}

/**
 * New owner account: the user, their organization and its free trial.
 * The first branch is created afterwards from the setup screen.
 */
export async function signup(input: { name: string; identifier: Identifier; password: string }) {
  const existing = await prisma.user.findUnique({ where: input.identifier, select: { id: true } });
  if (existing) throw conflict("This email or mobile number is already registered", "ACCOUNT_EXISTS");

  const trialEndsAt = new Date(Date.now() + env.TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const user = await prisma.user.create({
    data: {
      name: input.name,
      ...input.identifier,
      passwordHash: await hashPassword(input.password),
      ownedOrganization: { create: { trialEndsAt } },
    },
    select: { id: true },
  });

  return { userId: user.id, tokens: await startSession(user.id) };
}

export async function login(input: { identifier: Identifier; password: string }) {
  const user = await prisma.user.findUnique({
    where: input.identifier,
    select: { id: true, passwordHash: true },
  });

  const matches = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  // One message and status for both cases (REVIEW S8).
  if (!user || !matches) {
    throw unauthorized("Incorrect email/mobile or password", "INVALID_CREDENTIALS");
  }

  return { userId: user.id, tokens: await startSession(user.id) };
}

/**
 * Swaps a refresh token for a new pair. The old refresh token stops working
 * (rotation), so a leaked one can be used at most once.
 *
 * The swap is one conditional UPDATE: it only applies while the session still holds
 * the token being exchanged. If the app sends the same refresh token twice at once,
 * exactly one call gets the new pair and the other gets SESSION_EXPIRED, so the app
 * never ends up holding a token that was already replaced. The app should run one
 * refresh at a time and let other requests wait for it.
 */
export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const presentedHash = hashToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: presentedHash },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });

  const expired = () => unauthorized("Session expired, please log in again", "SESSION_EXPIRED");
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw expired();

  const nextRefreshToken = newRefreshToken();
  const { count } = await prisma.session.updateMany({
    where: { id: session.id, refreshTokenHash: presentedHash, revokedAt: null },
    data: {
      refreshTokenHash: hashToken(nextRefreshToken),
      expiresAt: refreshExpiry(),
      lastUsedAt: new Date(),
    },
  });
  if (count === 0) throw expired();

  return {
    accessToken: signAccessToken(session.userId, session.id),
    refreshToken: nextRefreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  };
}

export async function logout(userId: number, sessionId: number, deviceToken?: string) {
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    ...(deviceToken ? [prisma.deviceToken.deleteMany({ where: { token: deviceToken, userId } })] : []),
  ]);
}

/** Logs out every device, e.g. after a lost phone. */
export async function revokeAllSessions(userId: number, exceptSessionId?: number) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
