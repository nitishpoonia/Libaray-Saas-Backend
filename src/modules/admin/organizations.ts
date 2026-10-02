import type { Prisma, SubscriptionStatus } from "../../generated/prisma/client";
import type { Db } from "../../lib/db";
import { conflict, notFound } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { isInPaidPeriod, isSubscriptionUsable } from "../../middleware/subscription";
import { audit } from "./auth";

/**
 * What a platform admin sees and changes about customer accounts.
 *
 * Privacy rule: the owner's own contact details are shown (needed for support), but
 * never their students' names or phone numbers. Students appear only as counts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type OrgListQuery = {
  page: number;
  limit: number;
  search?: string;
  status?: SubscriptionStatus;
  suspended?: boolean;
};

export async function listOrganizations(q: OrgListQuery) {
  const digits = q.search?.replace(/\D/g, "") ?? "";
  const where: Prisma.OrganizationWhereInput = {
    ...(q.status ? { subscriptionStatus: q.status } : {}),
    ...(q.suspended === undefined ? {} : { suspendedAt: q.suspended ? { not: null } : null }),
    ...(q.search
      ? {
          OR: [
            { owner: { name: { contains: q.search, mode: "insensitive" } } },
            { owner: { email: { contains: q.search, mode: "insensitive" } } },
            ...(digits.length >= 3 ? [{ owner: { phone: { contains: digits } } }] : []),
            { libraries: { some: { name: { contains: q.search, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const [orgs, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true } },
        _count: { select: { libraries: true } },
      },
    }),
    prisma.organization.count({ where }),
  ]);

  // Last time the owner's app talked to us (refresh-token use), for "is this account alive?".
  const activity = await prisma.session.groupBy({
    by: ["userId"],
    where: { userId: { in: orgs.map((o) => o.ownerId) } },
    _max: { lastUsedAt: true },
  });
  const lastActive = new Map(activity.map((a) => [a.userId, a._max.lastUsedAt]));

  return {
    total,
    rows: orgs.map((o) => ({
      id: o.id,
      owner: o.owner,
      status: o.subscriptionStatus,
      suspended: o.suspendedAt !== null,
      trialEndsAt: o.trialEndsAt,
      currentPeriodEnd: o.currentPeriodEnd,
      branches: o._count.libraries,
      billedBranches: o.billedBranches,
      createdAt: o.createdAt,
      lastActiveAt: lastActive.get(o.ownerId) ?? null,
    })),
  };
}

export async function organizationDetail(id: number, now = new Date()) {
  const org = await prisma.organization.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, email: true, phone: true, createdAt: true } },
      libraries: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          address: true,
          createdAt: true,
          _count: { select: { staff: true } },
        },
      },
      billingPayments: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!org) throw notFound("Organization not found");

  const libraryIds = org.libraries.map((l) => l.id);
  const [seats, students, activeSessions, recentActions] = await Promise.all([
    prisma.seat.groupBy({ by: ["libraryId"], where: { libraryId: { in: libraryIds }, archivedAt: null }, _count: true }),
    prisma.student.groupBy({ by: ["libraryId"], where: { libraryId: { in: libraryIds }, archivedAt: null }, _count: true }),
    prisma.session.count({ where: { userId: org.ownerId, revokedAt: null, expiresAt: { gt: now } } }),
    prisma.adminAuditLog.findMany({
      where: { targetType: "organization", targetId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { admin: { select: { name: true } } },
    }),
  ]);
  const seatCount = new Map(seats.map((s) => [s.libraryId, s._count]));
  const studentCount = new Map(students.map((s) => [s.libraryId, s._count]));

  return {
    id: org.id,
    owner: org.owner,
    status: org.subscriptionStatus,
    usable: isSubscriptionUsable(org, now),
    suspended: org.suspendedAt !== null,
    suspendedAt: org.suspendedAt,
    suspendReason: org.suspendReason,
    trialEndsAt: org.trialEndsAt,
    currentPeriodEnd: org.currentPeriodEnd,
    billedBranches: org.billedBranches,
    unpaidBranches: isInPaidPeriod(org, now) ? Math.max(0, org.libraries.length - org.billedBranches) : 0,
    createdAt: org.createdAt,
    activeOwnerSessions: activeSessions,
    branches: org.libraries.map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      createdAt: l.createdAt,
      seats: seatCount.get(l.id) ?? 0,
      students: studentCount.get(l.id) ?? 0,
      staff: l._count.staff,
    })),
    payments: org.billingPayments.map((p) => ({
      id: p.id,
      kind: p.kind,
      plan: p.plan,
      branches: p.branches,
      amountPaise: p.amountPaise,
      status: p.status,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
    })),
    recentAdminActions: recentActions.map((a) => ({
      id: a.id,
      action: a.action,
      admin: a.admin.name,
      reason: a.reason,
      before: a.before,
      after: a.after,
      createdAt: a.createdAt,
    })),
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type ActionContext = { adminId: number; reason: string; ip?: string };

/** Locks the organization row for the rest of the transaction, then reads it. */
async function lockOrganization(tx: Db, id: number) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM organizations WHERE id = ${id} FOR UPDATE`;
  if (!rows[0]) throw notFound("Organization not found");
  return tx.organization.findUniqueOrThrow({ where: { id } });
}

/**
 * Gives a trialing account more free days, or reopens a trial that ran out before the
 * owner ever paid. An account that has paid is refused: it needs a plan, not a trial.
 */
export function extendTrial(id: number, days: number, ctx: ActionContext, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, id);
    const neverPaid = org.currentPeriodEnd === null;
    if (!(org.subscriptionStatus === "TRIALING" || (org.subscriptionStatus === "EXPIRED" && neverPaid))) {
      throw conflict("Only an account that hasn't paid yet can get trial days", "NOT_IN_TRIAL");
    }

    const from = Math.max(org.trialEndsAt.getTime(), now.getTime());
    const trialEndsAt = new Date(from + days * DAY_MS);
    const before = { subscriptionStatus: org.subscriptionStatus, trialEndsAt: org.trialEndsAt.toISOString() };
    const after = { subscriptionStatus: "TRIALING" as const, trialEndsAt: trialEndsAt.toISOString() };

    await tx.organization.update({ where: { id }, data: { subscriptionStatus: "TRIALING", trialEndsAt } });
    await audit(tx, {
      adminId: ctx.adminId,
      action: "organization.extend_trial",
      targetType: "organization",
      targetId: id,
      before,
      after: { ...after, days },
      reason: ctx.reason,
      ip: ctx.ip,
    });
    return after;
  });
}

/** Blocks every change in the account (reads stay open) until unsuspended. */
export function suspend(id: number, ctx: ActionContext, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, id);
    if (org.suspendedAt) throw conflict("This account is already suspended", "ALREADY_SUSPENDED");
    await tx.organization.update({ where: { id }, data: { suspendedAt: now, suspendReason: ctx.reason } });
    await audit(tx, {
      adminId: ctx.adminId,
      action: "organization.suspend",
      targetType: "organization",
      targetId: id,
      before: { suspended: false },
      after: { suspended: true },
      reason: ctx.reason,
      ip: ctx.ip,
    });
    return { suspended: true, suspendedAt: now };
  });
}

export function unsuspend(id: number, ctx: ActionContext) {
  return prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, id);
    if (!org.suspendedAt) throw conflict("This account isn't suspended", "NOT_SUSPENDED");
    await tx.organization.update({ where: { id }, data: { suspendedAt: null, suspendReason: null } });
    await audit(tx, {
      adminId: ctx.adminId,
      action: "organization.unsuspend",
      targetType: "organization",
      targetId: id,
      before: { suspended: true, suspendReason: org.suspendReason },
      after: { suspended: false },
      reason: ctx.reason,
      ip: ctx.ip,
    });
    return { suspended: false };
  });
}

/** Logs the owner out on every device (e.g. a lost phone). Their access tokens expire within minutes. */
export function revokeOwnerSessions(id: number, ctx: ActionContext, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, id);
    const { count } = await tx.session.updateMany({
      where: { userId: org.ownerId, revokedAt: null },
      data: { revokedAt: now },
    });
    await audit(tx, {
      adminId: ctx.adminId,
      action: "organization.revoke_sessions",
      targetType: "organization",
      targetId: id,
      after: { sessionsRevoked: count },
      reason: ctx.reason,
      ip: ctx.ip,
    });
    return { sessionsRevoked: count };
  });
}
