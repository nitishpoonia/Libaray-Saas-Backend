import dayjs from "dayjs";
import { env } from "../../config/env";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import type { Db } from "../../lib/db";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isSubscriptionUsable } from "../../middleware/subscription";
import { branchAddonPrice, PLANS, planPrice, type Plan } from "./pricing";
import { getGateway } from "./razorpay";

const prices = () => ({
  baseMonthly: env.PLAN_BASE_MONTHLY_PAISE,
  extraBranchMonthly: env.PLAN_EXTRA_BRANCH_MONTHLY_PAISE,
});

async function ownedOrganization(userId: number) {
  const org = await prisma.organization.findUnique({ where: { ownerId: userId } });
  if (!org) throw forbidden("Only the account owner can manage billing", "NOT_AN_OWNER");
  return org;
}

/** True while a paid period is running (not during the trial). */
function inPaidPeriod(org: { subscriptionStatus: string; currentPeriodEnd: Date | null }, now: Date) {
  return org.subscriptionStatus === "ACTIVE" && org.currentPeriodEnd !== null && org.currentPeriodEnd > now;
}

export async function billingSummary(userId: number, now = new Date()) {
  const org = await ownedOrganization(userId);
  const [branches, history] = await Promise.all([
    prisma.library.count({ where: { organizationId: org.id } }),
    prisma.subscriptionPayment.findMany({
      where: { organizationId: org.id, status: "PAID" },
      orderBy: { paidAt: "desc" },
      take: 20,
    }),
  ]);
  const billable = Math.max(1, branches);
  // A plan paid for fewer branches than exist (the owner added branches between
  // opening checkout and paying): these still need a branch add-on each.
  const unpaidBranches = inPaidPeriod(org, now) ? Math.max(0, branches - org.billedBranches) : 0;

  let keyId: string | null = null;
  try {
    keyId = getGateway().keyId;
  } catch {
    keyId = null;
  }

  return {
    status: org.subscriptionStatus,
    usable: isSubscriptionUsable(org, now),
    trialEndsAt: org.trialEndsAt,
    currentPeriodEnd: org.currentPeriodEnd,
    branches,
    billedBranches: org.billedBranches,
    unpaidBranches,
    plans: (Object.keys(PLANS) as Plan[]).map((plan) => ({
      plan,
      months: PLANS[plan].months,
      amountPaise: planPrice(plan, billable, prices()),
    })),
    branchAddon:
      inPaidPeriod(org, now) && org.currentPeriodEnd
        ? { amountPaise: branchAddonPrice(org.currentPeriodEnd, now, prices()), until: org.currentPeriodEnd }
        : null,
    razorpayKeyId: keyId,
    history: history.map((p) => ({
      id: p.id,
      kind: p.kind,
      plan: p.plan,
      branches: p.branches,
      amountPaise: p.amountPaise,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      paidAt: p.paidAt,
    })),
  };
}

export type OrderRequest = { kind: "PLAN"; plan: Plan } | { kind: "BRANCH_ADDON" };

/**
 * Creates a Razorpay order. The amount is always worked out here, never taken
 * from the app, so it can't be tampered with.
 */
export async function createOrder(userId: number, request: OrderRequest, now = new Date()) {
  const org = await ownedOrganization(userId);
  const gateway = getGateway();

  let amountPaise: number;
  let branches: number;
  let months: number | null = null;
  let plan: Plan | null = null;

  if (request.kind === "PLAN") {
    branches = Math.max(1, await prisma.library.count({ where: { organizationId: org.id } }));
    plan = request.plan;
    months = PLANS[plan].months;
    amountPaise = planPrice(plan, branches, prices());
  } else {
    if (!inPaidPeriod(org, now) || !org.currentPeriodEnd) {
      throw conflict("Extra branches are included in the trial; buy a plan instead", "NO_PAID_PERIOD");
    }
    branches = 1;
    amountPaise = branchAddonPrice(org.currentPeriodEnd, now, prices());
  }

  const order = await gateway.createOrder({
    amountPaise,
    receipt: `org${org.id}-${now.getTime()}`,
    notes: { organizationId: String(org.id), kind: request.kind, ...(plan ? { plan } : {}) },
  });

  const payment = await prisma.subscriptionPayment.create({
    data: {
      organizationId: org.id,
      kind: request.kind,
      plan,
      months,
      branches,
      amountPaise,
      razorpayOrderId: order.id,
    },
  });

  return {
    subscriptionPaymentId: payment.id,
    orderId: order.id,
    amountPaise,
    currency: "INR",
    keyId: gateway.keyId,
  };
}

/**
 * Applies a paid order to the subscription. Called by the app after checkout and by
 * Razorpay's webhook; whichever arrives second finds it already PAID and does nothing.
 *
 * A plan starts when the current trial or paid period ends (nobody loses days they
 * already have) or now if that's already past.
 */
export async function markOrderPaid(orderId: string, paymentId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM subscription_payments WHERE razorpay_order_id = ${orderId} FOR UPDATE`;
    if (!locked[0]) throw notFound("Order not found", "ORDER_NOT_FOUND");

    const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: locked[0].id } });
    if (payment.status === "PAID") return payment;

    await lockOrganization(tx, payment.organizationId);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: payment.organizationId } });

    let periodStart: Date;
    let periodEnd: Date;

    if (payment.kind === "PLAN") {
      const candidates = [now];
      if (org.subscriptionStatus === "TRIALING") candidates.push(org.trialEndsAt);
      if (org.currentPeriodEnd) candidates.push(org.currentPeriodEnd);
      periodStart = new Date(Math.max(...candidates.map((d) => d.getTime())));
      periodEnd = dayjs(periodStart).add(payment.months ?? 1, "month").toDate();
      // The price was fixed when the order was created. A UPI payment can be approved
      // hours later, after more branches were added; the gap shows as unpaidBranches.
      const branchesNow = await tx.library.count({ where: { organizationId: org.id } });
      if (branchesNow > payment.branches) {
        logger.warn(
          { organizationId: org.id, paidFor: payment.branches, branchesNow, orderId },
          "Plan paid for fewer branches than the account has",
        );
      }
      await tx.organization.update({
        where: { id: org.id },
        data: {
          subscriptionStatus: "ACTIVE",
          currentPeriodEnd: periodEnd,
          billedBranches: payment.branches,
        },
      });
    } else {
      periodStart = now;
      periodEnd = org.currentPeriodEnd ?? now;
      await tx.organization.update({
        where: { id: org.id },
        data: { billedBranches: { increment: 1 } },
      });
    }

    return tx.subscriptionPayment.update({
      where: { id: payment.id },
      data: { status: "PAID", razorpayPaymentId: paymentId, paidAt: now, periodStart, periodEnd },
    });
  });
}

/** Checkout result sent by the app: verify Razorpay's signature, then apply it. */
export async function verifyCheckout(
  userId: number,
  input: { orderId: string; paymentId: string; signature: string },
) {
  const org = await ownedOrganization(userId);
  const payment = await prisma.subscriptionPayment.findUnique({
    where: { razorpayOrderId: input.orderId },
    select: { organizationId: true },
  });
  if (!payment || payment.organizationId !== org.id) throw notFound("Order not found", "ORDER_NOT_FOUND");

  if (!getGateway().verifyPaymentSignature(input.orderId, input.paymentId, input.signature)) {
    throw badRequest("Payment could not be verified", "INVALID_SIGNATURE");
  }
  await markOrderPaid(input.orderId, input.paymentId);
}

async function lockOrganization(tx: Db, organizationId: number) {
  await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
}

/**
 * Checked before creating a branch. During the trial branches are free. During a paid
 * period each branch beyond what's been paid for needs a branch add-on first, so a
 * yearly plan bought for one branch doesn't cover five.
 */
export async function assertCanAddBranch(tx: Db, organizationId: number, now = new Date()) {
  await lockOrganization(tx, organizationId);
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });

  if (!isSubscriptionUsable(org, now)) {
    throw forbidden("Your subscription has ended. Renew it to add a branch.", "SUBSCRIPTION_INACTIVE");
  }
  if (!inPaidPeriod(org, now) || !org.currentPeriodEnd) return;

  const branches = await tx.library.count({ where: { organizationId } });
  if (branches >= org.billedBranches) {
    throw new AppError(402, "BRANCH_PAYMENT_REQUIRED", "Pay for one more branch to add it", {
      amountPaise: branchAddonPrice(org.currentPeriodEnd, now, prices()),
      until: org.currentPeriodEnd,
    });
  }
}
