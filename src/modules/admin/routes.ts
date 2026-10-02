import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pageMeta, sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { id, pagination } from "../../lib/validation";
import { adminLogin, adminLoginLimiters, adminLogout, requireAdmin, requireAdminUser } from "./auth";
import {
  extendTrial,
  listOrganizations,
  organizationDetail,
  revokeOwnerSessions,
  suspend,
  unsuspend,
} from "./organizations";

/**
 * Platform admin API, mounted at /admin/v1. Only for the people who run the SaaS;
 * see auth.ts for how it's kept apart from the customer API.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
});

/** Every action needs a reason; it goes into the audit log. */
const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) });
const extendTrialBody = reasonBody.extend({ days: z.coerce.number().int().min(1).max(60) });

const orgListQuery = pagination.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "EXPIRED", "CANCELLED"]).optional(),
  suspended: z.enum(["true", "false"]).optional(),
});

const ordersQuery = pagination.extend({ status: z.enum(["CREATED", "PAID"]).optional() });
const notificationsQuery = pagination.extend({
  status: z.enum(["FAILED", "SKIPPED", "SENT"]).default("FAILED"),
});
const auditQuery = pagination.extend({
  targetType: z.string().trim().max(50).optional(),
  targetId: id.optional(),
});

/** "+919876543210" → "+91******3210". Student numbers never appear in full here. */
export const maskPhone = (value: string) =>
  value.startsWith("user:") ? value : value.replace(/^(\+?\d{2})\d+(\d{4})$/, "$1******$2");

const ctx = (req: Request, reason: string) => ({ adminId: requireAdminUser(req).id, reason, ip: req.ip });

// ─── Auth ───────────────────────────────────────────────────────────────────

async function login(req: Request, res: Response) {
  sendData(res, await adminLogin(loginBody.parse(req.body), req.ip));
}

async function logout(req: Request, res: Response) {
  await adminLogout(requireAdminUser(req).sessionId);
  res.status(204).end();
}

async function me(req: Request, res: Response) {
  const admin = await prisma.adminUser.findUniqueOrThrow({
    where: { id: requireAdminUser(req).id },
    select: { id: true, email: true, name: true, lastLoginAt: true },
  });
  sendData(res, admin);
}

// ─── Overview ───────────────────────────────────────────────────────────────

async function overview(_req: Request, res: Response) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [byStatus, suspended, signups7, signups30, trialsEnded, paidOrgs, revenue30, activePlans, lastJob, failedNotices] =
    await Promise.all([
      prisma.organization.groupBy({ by: ["subscriptionStatus"], _count: true }),
      prisma.organization.count({ where: { suspendedAt: { not: null } } }),
      prisma.organization.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.organization.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.organization.count({ where: { trialEndsAt: { lte: now } } }),
      prisma.organization.count({
        where: { trialEndsAt: { lte: now }, billingPayments: { some: { status: "PAID", kind: "PLAN" } } },
      }),
      prisma.subscriptionPayment.aggregate({
        where: { status: "PAID", paidAt: { gte: monthAgo } },
        _sum: { amountPaise: true },
      }),
      // Latest paid plan of each account on a running paid period.
      prisma.subscriptionPayment.findMany({
        where: {
          status: "PAID",
          kind: "PLAN",
          organization: { subscriptionStatus: "ACTIVE", currentPeriodEnd: { gt: now } },
        },
        orderBy: [{ organizationId: "asc" }, { paidAt: "desc" }],
        distinct: ["organizationId"],
        select: { amountPaise: true, months: true },
      }),
      prisma.jobRun.findFirst({ where: { name: "daily" }, orderBy: { runDate: "desc" } }),
      prisma.notificationLog.count({ where: { status: "FAILED", createdAt: { gte: weekAgo } } }),
    ]);

  // Monthly recurring revenue: each plan's price spread over its months (a yearly plan
  // counts as a twelfth). Branch add-ons are one-off top-ups and aren't included.
  const mrrPaise = Math.round(activePlans.reduce((sum, p) => sum + p.amountPaise / (p.months ?? 1), 0));

  sendData(res, {
    organizations: {
      byStatus: Object.fromEntries(byStatus.map((s) => [s.subscriptionStatus, s._count])),
      suspended,
      signupsLast7Days: signups7,
      signupsLast30Days: signups30,
    },
    // Of the accounts whose trial has ended, how many ever bought a plan.
    trialConversion: { trialsEnded, paid: paidOrgs, rate: trialsEnded ? paidOrgs / trialsEnded : null },
    revenue: { mrrPaise, collectedLast30DaysPaise: revenue30._sum.amountPaise ?? 0 },
    ops: {
      lastDailyRun: lastJob
        ? { runDate: lastJob.runDate, status: lastJob.status, finishedAt: lastJob.finishedAt, error: lastJob.error }
        : null,
      failedNoticesLast7Days: failedNotices,
    },
  });
}

// ─── Organizations ──────────────────────────────────────────────────────────

async function organizations(req: Request, res: Response) {
  const q = orgListQuery.parse(req.query);
  const { rows, total } = await listOrganizations({
    ...q,
    suspended: q.suspended === undefined ? undefined : q.suspended === "true",
  });
  sendData(res, rows, pageMeta(q.page, q.limit, total));
}

async function organization(req: Request, res: Response) {
  sendData(res, await organizationDetail(id.parse(req.params.orgId)));
}

async function extendTrialAction(req: Request, res: Response) {
  const body = extendTrialBody.parse(req.body);
  sendData(res, await extendTrial(id.parse(req.params.orgId), body.days, ctx(req, body.reason)));
}

async function suspendAction(req: Request, res: Response) {
  const { reason } = reasonBody.parse(req.body);
  sendData(res, await suspend(id.parse(req.params.orgId), ctx(req, reason)));
}

async function unsuspendAction(req: Request, res: Response) {
  const { reason } = reasonBody.parse(req.body);
  sendData(res, await unsuspend(id.parse(req.params.orgId), ctx(req, reason)));
}

async function revokeSessionsAction(req: Request, res: Response) {
  const { reason } = reasonBody.parse(req.body);
  sendData(res, await revokeOwnerSessions(id.parse(req.params.orgId), ctx(req, reason)));
}

// ─── Billing, ops, audit ────────────────────────────────────────────────────

async function orders(req: Request, res: Response) {
  const q = ordersQuery.parse(req.query);
  const where = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    prisma.subscriptionPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { organization: { select: { id: true, owner: { select: { name: true } } } } },
    }),
    prisma.subscriptionPayment.count({ where }),
  ]);
  sendData(
    res,
    rows.map((p) => ({
      id: p.id,
      organizationId: p.organizationId,
      ownerName: p.organization.owner.name,
      kind: p.kind,
      plan: p.plan,
      branches: p.branches,
      amountPaise: p.amountPaise,
      status: p.status,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
    })),
    pageMeta(q.page, q.limit, total),
  );
}

async function jobRuns(_req: Request, res: Response) {
  const runs = await prisma.jobRun.findMany({ orderBy: [{ runDate: "desc" }, { id: "desc" }], take: 30 });
  sendData(res, runs);
}

async function notifications(req: Request, res: Response) {
  const q = notificationsQuery.parse(req.query);
  const where = { status: q.status };
  const [rows, total] = await Promise.all([
    prisma.notificationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { library: { select: { id: true, name: true, organizationId: true } } },
    }),
    prisma.notificationLog.count({ where }),
  ]);
  sendData(
    res,
    rows.map((n) => ({
      id: n.id,
      library: n.library,
      type: n.type,
      channel: n.channel,
      recipient: maskPhone(n.recipient),
      status: n.status,
      error: n.error,
      createdAt: n.createdAt,
    })),
    pageMeta(q.page, q.limit, total),
  );
}

async function auditLog(req: Request, res: Response) {
  const q = auditQuery.parse(req.query);
  const where = {
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { admin: { select: { id: true, name: true, email: true } } },
    }),
    prisma.adminAuditLog.count({ where }),
  ]);
  sendData(res, rows, pageMeta(q.page, q.limit, total));
}

export function adminRouter() {
  const router = Router();
  router.post("/auth/login", ...adminLoginLimiters, login);

  router.use(requireAdmin);
  router.post("/auth/logout", logout);
  router.get("/me", me);
  router.get("/overview", overview);
  router.get("/organizations", organizations);
  router.get("/organizations/:orgId", organization);
  router.post("/organizations/:orgId/extend-trial", extendTrialAction);
  router.post("/organizations/:orgId/suspend", suspendAction);
  router.post("/organizations/:orgId/unsuspend", unsuspendAction);
  router.post("/organizations/:orgId/revoke-sessions", revokeSessionsAction);
  router.get("/billing/orders", orders);
  router.get("/ops/job-runs", jobRuns);
  router.get("/ops/notifications", notifications);
  router.get("/audit-log", auditLog);
  return router;
}
