import type { RequestHandler } from "express";
import { forbidden } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { requireAccess } from "./libraryAccess";

/**
 * Blocks writes when the organization's trial or paid period is over.
 * Reads stay open so an owner can always see and export their data.
 */
export const requireActiveSubscription: RequestHandler = async (req, _res, next) => {
  const { library } = requireAccess(req);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: library.organizationId },
    select: { subscriptionStatus: true, trialEndsAt: true, currentPeriodEnd: true },
  });

  if (!isSubscriptionUsable(org, new Date())) {
    throw forbidden(
      "Your subscription has ended. Renew it to make changes.",
      "SUBSCRIPTION_INACTIVE",
    );
  }
  next();
};

export function isSubscriptionUsable(
  org: { subscriptionStatus: string; trialEndsAt: Date; currentPeriodEnd: Date | null },
  now: Date,
): boolean {
  if (org.subscriptionStatus === "TRIALING") return org.trialEndsAt > now;
  if (org.subscriptionStatus === "ACTIVE") {
    return org.currentPeriodEnd !== null && org.currentPeriodEnd > now;
  }
  return false;
}
