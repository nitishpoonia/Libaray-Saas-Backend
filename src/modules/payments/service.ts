import type { Db } from "../../lib/db";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { money, toRupees } from "../../lib/money";
import type { PaymentMode } from "../../generated/prisma/client";

/**
 * Next receipt number for the branch, e.g. RCP-000042 (REVIEW B13).
 * The UPDATE ... RETURNING runs inside the payment transaction and locks the branch
 * row, so two payments at the same moment get different numbers, and a rolled-back
 * payment doesn't use one up.
 */
async function nextReceiptNumber(tx: Db, libraryId: number): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ seq: number }>>`
    UPDATE libraries SET next_receipt_seq = next_receipt_seq + 1
    WHERE id = ${libraryId}
    RETURNING next_receipt_seq - 1 AS seq`;
  return `RCP-${String(rows[0]!.seq).padStart(6, "0")}`;
}

async function lockMembership(tx: Db, libraryId: number, membershipId: number) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM memberships WHERE id = ${membershipId} AND library_id = ${libraryId} FOR UPDATE`;
  if (!rows[0]) throw notFound("Membership not found", "MEMBERSHIP_NOT_FOUND");
  return tx.membership.findUniqueOrThrow({
    where: { id: membershipId },
    select: { id: true, studentId: true, fee: true, amountPaid: true },
  });
}

/**
 * Records money against one membership period. Payments on cancelled periods are
 * allowed: a student can still clear old dues.
 * Must run inside a transaction.
 */
export async function recordPayment(
  tx: Db,
  input: {
    libraryId: number;
    membershipId: number;
    amount: number;
    mode: PaymentMode;
    notes?: string;
    recordedById: number;
  },
) {
  const membership = await lockMembership(tx, input.libraryId, input.membershipId);
  const pending = membership.fee.minus(membership.amountPaid);
  const amount = money(input.amount);

  if (pending.lte(0)) throw conflict("Nothing is pending for this membership", "NOTHING_PENDING");
  if (amount.gt(pending)) {
    throw badRequest(`Amount is more than the pending ₹${toRupees(pending)}`, "OVERPAYMENT", {
      pending: toRupees(pending),
    });
  }

  const receiptNumber = await nextReceiptNumber(tx, input.libraryId);
  const payment = await tx.payment.create({
    data: {
      libraryId: input.libraryId,
      membershipId: membership.id,
      studentId: membership.studentId,
      amount,
      mode: input.mode,
      notes: input.notes,
      receiptNumber,
      recordedById: input.recordedById,
    },
  });
  await tx.membership.update({
    where: { id: membership.id },
    data: { amountPaid: membership.amountPaid.plus(amount) },
  });
  return payment;
}

/** Cancels a payment entered by mistake. The receipt number stays used and traceable. */
export async function voidPayment(
  tx: Db,
  input: { libraryId: number; paymentId: number; reason: string },
) {
  const payment = await tx.payment.findFirst({
    where: { id: input.paymentId, libraryId: input.libraryId },
  });
  if (!payment) throw notFound("Payment not found", "PAYMENT_NOT_FOUND");
  if (payment.voidedAt) throw conflict("This payment is already voided", "ALREADY_VOIDED");

  const membership = await lockMembership(tx, input.libraryId, payment.membershipId);
  await tx.membership.update({
    where: { id: membership.id },
    data: { amountPaid: membership.amountPaid.minus(payment.amount) },
  });
  return tx.payment.update({
    where: { id: payment.id },
    data: { voidedAt: new Date(), voidReason: input.reason },
  });
}

export function paymentView(p: {
  id: number;
  membershipId: number;
  amount: { toFixed(n: number): string };
  mode: PaymentMode;
  paidAt: Date;
  receiptNumber: string;
  notes: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
}) {
  return {
    id: p.id,
    membershipId: p.membershipId,
    amount: Number(p.amount.toFixed(2)),
    mode: p.mode,
    paidAt: p.paidAt,
    receiptNumber: p.receiptNumber,
    notes: p.notes,
    voided: p.voidedAt !== null,
    voidedAt: p.voidedAt,
    voidReason: p.voidReason,
  };
}
