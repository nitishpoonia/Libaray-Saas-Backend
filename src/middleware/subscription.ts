import type { RequestHandler } from "express";
import type { Db } from "../lib/db";
import { AppError, forbidden } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { branchAddonPrice, configuredPrices } from "../modules/billing/pricing";
import { requireAccess } from "./libraryAccess";

type OrgBilling = {
  subscriptionStatus: string;
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
  billedBranches: number;
  suspendedAt: Date | null;
};

/**
 * Blocks writes when the organization's trial or paid period is over, or when this
 * branch isn't covered by what's been paid for. Reads stay open so an owner can
 * always see and export their data.
 */
export const requireActiveSubscription: RequestHandler = async (req, _res, next) => {
  const { library } = requireAccess(req);
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: library.organizationId },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      billedBranches: true,
      suspendedAt: true,
    },
  });
  const now = new Date();

  if (org.suspendedAt) {
    throw forbidden(
      "This account is suspended. Contact support to restore it.",
      "ACCOUNT_SUSPENDED",
    );
  }
  if (!isSubscriptionUsable(org, now)) {
    throw forbidden(
      "Your subscription has ended. Renew it to make changes.",
      "SUBSCRIPTION_INACTIVE",
    );
  }

  if (!(await isBranchCovered(prisma, org, library, now))) {
    throw new AppError(
      402,
      "BRANCH_PAYMENT_REQUIRED",
      "This branch isn't covered by your plan yet. Pay for it to make changes.",
      {
        amountPaise: branchAddonPrice(org.currentPeriodEnd!, now, configuredPrices()),
        until: org.currentPeriodEnd,
      },
    );
  }
  next();
};

/**
 * Whether the account can make changes and send texts right now. A suspended account
 * can't, whatever it has paid; `suspendedAt` is required so no caller forgets it.
 */
export function isSubscriptionUsable(
  org: { subscriptionStatus: string; trialEndsAt: Date; currentPeriodEnd: Date | null; suspendedAt: Date | null },
  now: Date,
): boolean {
  if (org.suspendedAt) return false;
  if (org.subscriptionStatus === "TRIALING") return org.trialEndsAt > now;
  if (org.subscriptionStatus === "ACTIVE") {
    return org.currentPeriodEnd !== null && org.currentPeriodEnd > now;
  }
  return false;
}

/** True while a paid period is running (not during the trial). */
export function isInPaidPeriod(
  org: { subscriptionStatus: string; currentPeriodEnd: Date | null },
  now: Date,
): boolean {
  return org.subscriptionStatus === "ACTIVE" && org.currentPeriodEnd !== null && org.currentPeriodEnd > now;
}

/**
 * Whether a branch is paid for. During the trial every branch is. During a paid period
 * branches are covered oldest first, up to billedBranches; a branch added after the
 * plan's price was fixed (and not yet paid with a branch add-on) is not.
 */
export async function isBranchCovered(
  db: Db,
  org: OrgBilling,
  library: { id: number; organizationId: number },
  now: Date,
): Promise<boolean> {
  if (!isInPaidPeriod(org, now)) return true;
  const olderBranches = await db.library.count({
    where: { organizationId: library.organizationId, id: { lt: library.id } },
  });
  return olderBranches < org.billedBranches;
}
