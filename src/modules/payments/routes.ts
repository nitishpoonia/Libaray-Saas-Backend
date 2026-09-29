import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import { localDayBounds } from "../../lib/dates";
import { notFound } from "../../lib/errors";
import { pageMeta, sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { id, isoDate, pagination, positiveRupees } from "../../lib/validation";
import { requireAccess, requireRole, requireUser } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";
import { syncLifecycle } from "../memberships/lifecycle";
import { receiptFor } from "./receipts";
import { paymentView, recordPayment, voidPayment } from "./service";

const recordBody = z.object({
  amount: positiveRupees,
  mode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER"]),
  notes: z.string().trim().max(500).optional(),
});

const listQuery = pagination.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  studentId: id.optional(),
  includeVoided: z.enum(["true", "false"]).default("false"),
});

/** Collect fees against a membership period: POST /memberships/:membershipId/payments */
async function record(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const user = requireUser(req);
  const membershipId = id.parse(req.params.membershipId);
  const body = recordBody.parse(req.body);

  const payment = await prisma.$transaction((tx) =>
    recordPayment(tx, { libraryId: library.id, membershipId, ...body, recordedById: user.id }),
  );
  const { today } = await syncLifecycle(library);
  sendData(res, await receiptFor(library, payment.id, today), undefined, 201);
}

async function list(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const query = listQuery.parse(req.query);

  const where: Prisma.PaymentWhereInput = {
    libraryId: library.id,
    ...(query.includeVoided === "true" ? {} : { voidedAt: null }),
    ...(query.studentId ? { studentId: query.studentId } : {}),
    ...(query.from || query.to
      ? { paidAt: localDayBounds(query.from ?? "2000-01-01", query.to ?? "2100-01-01", library.timezone) }
      : {}),
  };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { student: { select: { id: true, name: true } } },
      orderBy: { paidAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.payment.count({ where }),
  ]);

  sendData(
    res,
    payments.map((p) => ({ ...paymentView(p), student: p.student })),
    pageMeta(query.page, query.limit, total),
  );
}

/** Receipt data for re-sharing a receipt later or from another phone (REVIEW FU8). */
async function receipt(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const paymentId = id.parse(req.params.paymentId);
  const exists = await prisma.payment.count({ where: { id: paymentId, libraryId: library.id } });
  if (!exists) throw notFound("Payment not found", "PAYMENT_NOT_FOUND");
  const { today } = await syncLifecycle(library);
  sendData(res, await receiptFor(library, paymentId, today));
}

async function voidOne(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const paymentId = id.parse(req.params.paymentId);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const payment = await prisma.$transaction((tx) =>
    voidPayment(tx, { libraryId: library.id, paymentId, reason }),
  );
  sendData(res, paymentView(payment));
}

/** Mounted at /libraries/:libraryId/memberships */
export const membershipPaymentsRouter = Router({ mergeParams: true });
membershipPaymentsRouter.post("/:membershipId/payments", requireActiveSubscription, record);

/** Mounted at /libraries/:libraryId/payments */
export const paymentsRouter = Router({ mergeParams: true });
paymentsRouter.get("/", list);
paymentsRouter.get("/:paymentId/receipt", receipt);
paymentsRouter.post("/:paymentId/void", requireRole("MANAGER"), requireActiveSubscription, voidOne);
