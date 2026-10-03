import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import { addDays, toDbDate, type IsoDate } from "../../lib/dates";
import { pageMeta, sendData } from "../../lib/http";
import { money, toRupees } from "../../lib/money";
import { prisma } from "../../lib/prisma";
import {
  id,
  indianMobile,
  isoDate,
  pagination,
  personName,
  positiveRupees,
  rupees,
  timeOfDay,
} from "../../lib/validation";
import { requireAccess, requireUser } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";
import { syncLifecycle } from "../memberships/lifecycle";
import {
  assertStudentBelongs,
  bookPeriod,
  cancelLivePeriods,
  membershipView,
  renew,
} from "../memberships/service";
import { receiptFor } from "../payments/receipts";
import { paymentView, recordPayment } from "../payments/service";

// ─── Input ──────────────────────────────────────────────────────────────────

const paymentInput = z.object({
  amount: positiveRupees,
  mode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER"]),
  notes: z.string().trim().max(500).optional(),
});

const periodInput = {
  days: z.coerce.number().int().min(1).max(366),
  fee: rupees.refine((n) => n >= 0, "Fee can't be negative"),
};

const createBody = z.object({
  name: personName,
  phone: indianMobile,
  membership: z.object({
    seatId: id,
    startDate: isoDate.optional(),
    startTime: timeOfDay,
    endTime: timeOfDay,
    ...periodInput,
  }),
  /** First payment. Leave out when the student hasn't paid anything yet. */
  payment: paymentInput.optional(),
});

const updateBody = z
  .object({ name: personName.optional(), phone: indianMobile.optional() })
  .refine((b) => b.name !== undefined || b.phone !== undefined, "Nothing to update");

const renewBody = z
  .object({
    ...periodInput,
    startDate: isoDate.optional(),
    seatId: id.optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    payment: paymentInput.optional(),
  })
  .refine((b) => (b.startTime === undefined) === (b.endTime === undefined), {
    message: "Send both startTime and endTime, or neither",
    path: ["endTime"],
  });

/**
 * current  - has an ACTIVE or OVERDUE period (default)
 * active   - has an ACTIVE period that has started
 * overdue  - period ended without renewal; seat still held
 * pending  - any period with fees left to pay
 * expiring - ACTIVE period ending within 7 days, not yet renewed
 * inactive - no ACTIVE or OVERDUE period
 * archived - removed by the owner
 * all      - everyone not archived
 */
const listQuery = pagination.extend({
  status: z
    .enum(["current", "active", "overdue", "pending", "expiring", "inactive", "archived", "all"])
    .default("current"),
  search: z.string().trim().max(100).optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusFilter(status: z.infer<typeof listQuery>["status"], today: IsoDate): Prisma.StudentWhereInput {
  const todayDb = toDbDate(today);
  const live = { status: { in: ["ACTIVE", "OVERDUE"] as Array<"ACTIVE" | "OVERDUE"> } };
  switch (status) {
    case "current":
      return { archivedAt: null, memberships: { some: live } };
    case "active":
      return { archivedAt: null, memberships: { some: { status: "ACTIVE", startDate: { lte: todayDb } } } };
    case "overdue":
      return { archivedAt: null, memberships: { some: { status: "OVERDUE" } } };
    case "pending":
      // Compares two columns of the same row: amount_paid < fee.
      return { memberships: { some: { amountPaid: { lt: prisma.membership.fields.fee } } } };
    case "expiring":
      return {
        archivedAt: null,
        memberships: {
          some: {
            status: "ACTIVE",
            endDate: { gte: todayDb, lte: toDbDate(addDays(today, 6)) },
            next: { is: null },
          },
        },
      };
    case "inactive":
      return { archivedAt: null, memberships: { none: live } };
    case "archived":
      return { archivedAt: { not: null } };
    case "all":
      return { archivedAt: null };
  }
}

function searchFilter(search?: string): Prisma.StudentWhereInput {
  if (!search) return {};
  const digits = search.replace(/\D/g, "");
  return {
    OR: [
      { name: { contains: search, mode: "insensitive" } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
    ],
  };
}

type PeriodForView = Parameters<typeof membershipView>[0] & { startDate: Date; endDate: Date };

/** The period to show on a student card: today's, else the overdue one, else the next one. */
function currentPeriod<T extends PeriodForView>(periods: T[], today: IsoDate): T | null {
  const todayDb = toDbDate(today);
  const live = periods.filter((p) => p.status === "ACTIVE" || p.status === "OVERDUE");
  return (
    live.find((p) => p.status === "ACTIVE" && p.startDate <= todayDb && p.endDate >= todayDb) ??
    live.find((p) => p.status === "OVERDUE") ??
    live.sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0] ??
    null
  );
}

async function findStudent(libraryId: number, studentId: number) {
  return assertStudentBelongs(
    await prisma.student.findFirst({ where: { id: studentId, libraryId } }),
  );
}

async function studentDetail(libraryId: number, studentId: number, today: IsoDate) {
  const student = await findStudent(libraryId, studentId);
  const periods = await prisma.membership.findMany({
    where: { libraryId, studentId },
    include: {
      seat: { select: { label: true } },
      payments: { orderBy: { paidAt: "desc" } },
    },
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });

  const pending = periods.reduce((sum, p) => sum.plus(p.fee.minus(p.amountPaid)), money(0));
  const current = currentPeriod(periods, today);

  return {
    id: student.id,
    name: student.name,
    phone: student.phone,
    archived: student.archivedAt !== null,
    createdAt: student.createdAt,
    pendingAmount: toRupees(pending),
    current: current ? membershipView(current, today) : null,
    memberships: periods.map((p) => ({
      ...membershipView(p, today),
      payments: p.payments.map(paymentView),
    })),
  };
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function list(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const query = listQuery.parse(req.query);
  const { today } = await syncLifecycle(library);

  const where: Prisma.StudentWhereInput = {
    libraryId: library.id,
    ...statusFilter(query.status, today),
    ...searchFilter(query.search),
  };

  // The filter runs in the database, so the page and the total agree (REVIEW B4).
  const [students, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        memberships: {
          where: { status: { in: ["ACTIVE", "OVERDUE"] } },
          include: { seat: { select: { label: true } } },
        },
      },
    }),
    prisma.student.count({ where }),
  ]);

  const dues = await prisma.membership.groupBy({
    by: ["studentId"],
    where: { libraryId: library.id, studentId: { in: students.map((s) => s.id) } },
    _sum: { fee: true, amountPaid: true },
  });
  const pendingByStudent = new Map(
    dues.map((d) => [d.studentId, money(d._sum.fee ?? 0).minus(d._sum.amountPaid ?? 0)]),
  );

  const rows = students.map((s) => {
    const current = currentPeriod(s.memberships, today);
    const pending = pendingByStudent.get(s.id) ?? money(0);
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      archived: s.archivedAt !== null,
      current: current ? membershipView(current, today) : null,
      pendingAmount: toRupees(pending),
      // e.g. ["OVERDUE", "FEES_PENDING"]: everything the card should flag.
      flags: [
        ...(current?.status === "OVERDUE" ? ["OVERDUE"] : []),
        ...(pending.gt(0) ? ["FEES_PENDING"] : []),
      ],
    };
  });

  sendData(res, rows, pageMeta(query.page, query.limit, total));
}

async function create(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const user = requireUser(req);
  const body = createBody.parse(req.body);
  const { today } = await syncLifecycle(library);

  // recordPayment refuses an amount above the fee, which rolls the whole student back.
  const { studentId, paymentId } = await prisma.$transaction(async (tx) => {
    const student = await tx.student.create({
      data: { libraryId: library.id, name: body.name, phone: body.phone },
    });
    const period = await bookPeriod(tx, {
      libraryId: library.id,
      studentId: student.id,
      seatId: body.membership.seatId,
      startDate: body.membership.startDate ?? today,
      days: body.membership.days,
      slot: { startMinute: body.membership.startTime, endMinute: body.membership.endTime },
      fee: body.membership.fee,
      createdById: user.id,
    });
    const payment = body.payment
      ? await recordPayment(tx, {
          libraryId: library.id,
          membershipId: period.id,
          ...body.payment,
          recordedById: user.id,
        })
      : null;
    return { studentId: student.id, paymentId: payment?.id ?? null };
  });

  const student = await studentDetail(library.id, studentId, today);
  const receipt = paymentId ? await receiptFor(library, paymentId, today) : null;
  sendData(res, { student, receipt }, undefined, 201);
}

async function get(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const { today } = await syncLifecycle(library);
  sendData(res, await studentDetail(library.id, id.parse(req.params.studentId), today));
}

async function update(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const studentId = id.parse(req.params.studentId);
  const body = updateBody.parse(req.body);
  await findStudent(library.id, studentId);
  await prisma.student.update({ where: { id: studentId }, data: body });
  const { today } = await syncLifecycle(library);
  sendData(res, await studentDetail(library.id, studentId, today));
}

/** Removes a student: live periods are cancelled (seat freed), history and dues stay. */
async function remove(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const studentId = id.parse(req.params.studentId);
  await findStudent(library.id, studentId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await cancelLivePeriods(tx, library.id, studentId, now);
    await tx.student.update({ where: { id: studentId }, data: { archivedAt: now } });
  });
  res.status(204).end();
}

async function renewMembership(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const user = requireUser(req);
  const studentId = id.parse(req.params.studentId);
  const body = renewBody.parse(req.body);
  await findStudent(library.id, studentId);
  const { today } = await syncLifecycle(library);

  const paymentId = await prisma.$transaction(async (tx) => {
    const period = await renew(tx, {
      libraryId: library.id,
      studentId,
      today,
      days: body.days,
      fee: body.fee,
      seatId: body.seatId,
      slot:
        body.startTime !== undefined && body.endTime !== undefined
          ? { startMinute: body.startTime, endMinute: body.endTime }
          : undefined,
      startDate: body.startDate,
      createdById: user.id,
    });
    if (!body.payment) return null;
    const payment = await recordPayment(tx, {
      libraryId: library.id,
      membershipId: period.id,
      ...body.payment,
      recordedById: user.id,
    });
    return payment.id;
  });

  const student = await studentDetail(library.id, studentId, today);
  const receipt = paymentId ? await receiptFor(library, paymentId, today) : null;
  sendData(res, { student, receipt }, undefined, 201);
}

const router = Router({ mergeParams: true });
router.get("/", list);
router.post("/", requireActiveSubscription, create);
router.get("/:studentId", get);
router.patch("/:studentId", requireActiveSubscription, update);
router.delete("/:studentId", requireActiveSubscription, remove);
router.post("/:studentId/renewals", requireActiveSubscription, renewMembership);

export default router;
