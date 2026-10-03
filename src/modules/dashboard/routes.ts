import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { addDays, localDayBounds, monthRange, toDbDate } from "../../lib/dates";
import { sendData } from "../../lib/http";
import { money, toRupees } from "../../lib/money";
import { prisma } from "../../lib/prisma";
import { requireAccess } from "../../middleware/libraryAccess";
import { isSubscriptionUsable } from "../../middleware/subscription";
import { syncLifecycle } from "../memberships/lifecycle";

const query = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM").optional(),
});

/**
 * One call for the home screen (REVIEW B9).
 * Finance figures are for one month (default: this month) and only shown to
 * managers and the owner.
 */
async function dashboard(req: Request, res: Response) {
  const { library, role } = requireAccess(req);
  const { month } = query.parse(req.query);
  const { today } = await syncLifecycle(library);
  const todayDb = toDbDate(today);
  const selectedMonth = month ?? today.slice(0, 7);
  const range = monthRange(selectedMonth);

  const holdsSeatToday = {
    libraryId: library.id,
    OR: [
      { status: "ACTIVE" as const, startDate: { lte: todayDb }, endDate: { gte: todayDb } },
      { status: "OVERDUE" as const },
    ],
  };

  const [
    totalSeats,
    seatsInUse,
    activeStudents,
    overdue,
    expiringSoon,
    dues,
    org,
  ] = await Promise.all([
    prisma.seat.count({ where: { libraryId: library.id, archivedAt: null } }),
    prisma.membership.findMany({ where: holdsSeatToday, distinct: ["seatId"], select: { seatId: true } }),
    prisma.membership.findMany({
      where: { libraryId: library.id, status: "ACTIVE", startDate: { lte: todayDb }, endDate: { gte: todayDb } },
      distinct: ["studentId"],
      select: { studentId: true },
    }),
    prisma.membership.count({ where: { libraryId: library.id, status: "OVERDUE" } }),
    prisma.membership.count({
      where: {
        libraryId: library.id,
        status: "ACTIVE",
        endDate: { gte: todayDb, lte: toDbDate(addDays(today, 6)) },
        next: { is: null },
      },
    }),
    prisma.membership.groupBy({
      by: ["studentId"],
      where: { libraryId: library.id, amountPaid: { lt: prisma.membership.fields.fee } },
      _sum: { fee: true, amountPaid: true },
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: library.organizationId },
      select: { subscriptionStatus: true, trialEndsAt: true, currentPeriodEnd: true },
    }),
  ]);

  const pendingTotal = dues.reduce(
    (sum, d) => sum.plus(money(d._sum.fee ?? 0).minus(d._sum.amountPaid ?? 0)),
    money(0),
  );

  let finance = null;
  if (role !== "STAFF") {
    const [revenue, expenses] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          libraryId: library.id,
          voidedAt: null,
          paidAt: localDayBounds(range.first, range.last, library.timezone),
        },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { libraryId: library.id, spentOn: { gte: toDbDate(range.first), lte: toDbDate(range.last) } },
        _sum: { amount: true },
      }),
    ]);
    const revenueTotal = money(revenue._sum.amount ?? 0);
    const expenseTotal = money(expenses._sum.amount ?? 0);
    finance = {
      month: selectedMonth,
      revenue: toRupees(revenueTotal),
      expenses: toRupees(expenseTotal),
      balance: toRupees(revenueTotal.minus(expenseTotal)),
    };
  }

  const now = new Date();
  const endsAt = org.subscriptionStatus === "TRIALING" ? org.trialEndsAt : org.currentPeriodEnd;

  sendData(res, {
    library: { id: library.id, name: library.name },
    role,
    today,
    seats: {
      total: totalSeats,
      // Seats with at least one booking holding them today (any time slot).
      inUse: seatsInUse.length,
      free: Math.max(0, totalSeats - seatsInUse.length),
    },
    students: {
      active: activeStudents.length,
      overdue,
      expiringSoon,
      withPendingFees: dues.length,
    },
    pendingFees: toRupees(pendingTotal),
    finance,
    subscription: {
      status: org.subscriptionStatus,
      usable: isSubscriptionUsable(org, now),
      endsAt,
      daysRemaining: endsAt
        ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000))
        : 0,
    },
  });
}

const router = Router({ mergeParams: true });
router.get("/", dashboard);

export default router;
