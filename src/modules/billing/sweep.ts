import { daysBetween, todayIn } from "../../lib/dates";
import { prisma } from "../../lib/prisma";
import type { PushSender } from "../notifications/channels";
import { deliverOnce, type Delivery } from "../notifications/deliver";

const REMINDER_DAYS = new Set([7, 3, 1]);
const TZ = "Asia/Kolkata";

/**
 * Daily subscription housekeeping:
 *   - trials and paid periods that have ended become EXPIRED
 *   - owners get a push 7, 3 and 1 days before their trial or plan ends
 */
export async function runSubscriptionSweep(push: PushSender, now = new Date()) {
  const expired = await prisma.$transaction([
    prisma.organization.updateMany({
      where: { subscriptionStatus: "TRIALING", trialEndsAt: { lte: now } },
      data: { subscriptionStatus: "EXPIRED" },
    }),
    prisma.organization.updateMany({
      where: { subscriptionStatus: "ACTIVE", currentPeriodEnd: { lte: now } },
      data: { subscriptionStatus: "EXPIRED" },
    }),
  ]);

  const today = todayIn(TZ, now);
  const orgs = await prisma.organization.findMany({
    where: { subscriptionStatus: { in: ["TRIALING", "ACTIVE"] }, suspendedAt: null },
    select: {
      ownerId: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      owner: { select: { notificationsEnabled: true } },
      libraries: { select: { id: true, name: true }, orderBy: { id: "asc" }, take: 1 },
    },
  });

  const reminders: Record<Delivery, number> = { SENT: 0, SKIPPED: 0, FAILED: 0, ALREADY_DONE: 0 };
  for (const org of orgs) {
    const endsAt = org.subscriptionStatus === "TRIALING" ? org.trialEndsAt : org.currentPeriodEnd;
    const firstLibrary = org.libraries[0];
    if (!endsAt || !firstLibrary || !org.owner.notificationsEnabled) continue;

    const daysLeft = daysBetween(today, todayIn(TZ, endsAt));
    if (!REMINDER_DAYS.has(daysLeft)) continue;

    const what = org.subscriptionStatus === "TRIALING" ? "free trial" : "plan";
    const result = await deliverOnce(
      {
        libraryId: firstLibrary.id,
        membershipId: null,
        type: "SUBSCRIPTION_REMINDER",
        channel: "PUSH",
        recipient: `user:${org.ownerId}`,
        referenceDate: today,
      },
      () =>
        push.send(org.ownerId, {
          title: `Your ${what} ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
          body: "Renew from Menu > Subscription to keep adding students and collecting fees.",
          data: { screen: "billing" },
        }),
    );
    reminders[result] += 1;
  }

  return { expired: expired[0].count + expired[1].count, reminders };
}
