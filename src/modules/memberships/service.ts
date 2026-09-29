import type { Db } from "../../lib/db";
import { addDays, fromDbDate, toDbDate, type IsoDate } from "../../lib/dates";
import { badRequest, notFound } from "../../lib/errors";
import { money, toRupees } from "../../lib/money";
import type { Membership } from "../../generated/prisma/client";
import { assertSeatFree } from "./availability";
import { daysRemaining, periodEnd } from "./rules";
import { formatSlot, type Slot } from "./slots";

export type NewPeriod = {
  libraryId: number;
  studentId: number;
  seatId: number;
  startDate: IsoDate;
  days: number;
  slot: Slot;
  fee: number;
  previousId?: number;
  createdById: number;
};

/**
 * Books a seat for a period. A renewal passes its previous period as previousId,
 * which is left out of the clash check: an overdue student's seat is held for them,
 * not against them.
 *
 * Must run inside a transaction (the seat lock needs one).
 */
export async function bookPeriod(tx: Db, input: NewPeriod) {
  const endDate = periodEnd(input.startDate, input.days);
  await assertSeatFree(
    tx,
    input.libraryId,
    input.seatId,
    { startDate: input.startDate, endDate, ...input.slot },
    input.previousId,
  );

  return tx.membership.create({
    data: {
      libraryId: input.libraryId,
      studentId: input.studentId,
      seatId: input.seatId,
      previousId: input.previousId,
      startDate: toDbDate(input.startDate),
      endDate: toDbDate(endDate),
      startMinute: input.slot.startMinute,
      endMinute: input.slot.endMinute,
      fee: money(input.fee),
      createdById: input.createdById,
    },
  });
}

export type RenewalInput = {
  libraryId: number;
  studentId: number;
  today: IsoDate;
  days: number;
  fee: number;
  seatId?: number;
  slot?: Slot;
  startDate?: IsoDate;
  createdById: number;
};

/**
 * Renews a student's membership as a new period (REVIEW D2: history is kept).
 *
 * If the student's latest period is still ACTIVE or OVERDUE, the new period continues
 * straight after it (their seat was held for them), unless a later startDate is given.
 * An OVERDUE period that gets renewed becomes COMPLETED right away.
 *
 * If they have no live period (never booked, cancelled or removed), the new period
 * starts on startDate or today, and seat and time default to their last booking.
 */
export async function renew(tx: Db, input: RenewalInput) {
  const latest = await tx.membership.findFirst({
    where: { libraryId: input.libraryId, studentId: input.studentId },
    orderBy: [{ endDate: "desc" }, { id: "desc" }],
  });

  const continuing = latest !== null && (latest.status === "ACTIVE" || latest.status === "OVERDUE");
  const earliestStart = continuing ? addDays(fromDbDate(latest.endDate), 1) : null;

  let startDate: IsoDate;
  if (earliestStart) {
    startDate = input.startDate ?? earliestStart;
    if (startDate < earliestStart) {
      throw badRequest(
        `The current period runs until ${fromDbDate(latest!.endDate)}; a renewal can start from ${earliestStart}`,
        "RENEWAL_OVERLAPS_CURRENT",
      );
    }
  } else {
    startDate = input.startDate ?? input.today;
  }

  const seatId = input.seatId ?? latest?.seatId;
  const slot = input.slot ?? (latest ? { startMinute: latest.startMinute, endMinute: latest.endMinute } : undefined);
  if (!seatId || !slot) {
    throw badRequest("Choose a seat and timing for this student", "SEAT_AND_TIMING_REQUIRED");
  }

  const period = await bookPeriod(tx, {
    libraryId: input.libraryId,
    studentId: input.studentId,
    seatId,
    startDate,
    days: input.days,
    slot,
    fee: input.fee,
    previousId: continuing ? latest!.id : undefined,
    createdById: input.createdById,
  });

  if (continuing && latest!.status === "OVERDUE") {
    await tx.membership.update({
      where: { id: latest!.id },
      data: { status: "COMPLETED", graceEndsOn: null },
    });
  }
  await tx.student.update({ where: { id: input.studentId }, data: { archivedAt: null } });

  return period;
}

/** Ends every live period of a student who leaves; the seat is free immediately. */
export async function cancelLivePeriods(tx: Db, libraryId: number, studentId: number, now: Date) {
  const { count } = await tx.membership.updateMany({
    where: { libraryId, studentId, status: { in: ["ACTIVE", "OVERDUE"] } },
    data: { status: "CANCELLED", cancelReason: "REMOVED", cancelledAt: now, graceEndsOn: null },
  });
  return count;
}

export function assertStudentBelongs<T>(student: T | null): T {
  if (!student) throw notFound("Student not found", "STUDENT_NOT_FOUND");
  return student;
}

/** How a membership period is shown in the API. */
export function membershipView(
  m: Pick<
    Membership,
    | "id"
    | "seatId"
    | "startDate"
    | "endDate"
    | "startMinute"
    | "endMinute"
    | "fee"
    | "amountPaid"
    | "status"
    | "graceEndsOn"
    | "cancelReason"
    | "previousId"
  > & { seat?: { label: string } },
  today: IsoDate,
) {
  const pending = m.fee.minus(m.amountPaid);
  const endDate = fromDbDate(m.endDate);
  const graceEnds = m.graceEndsOn ? fromDbDate(m.graceEndsOn) : null;
  return {
    id: m.id,
    seatId: m.seatId,
    seatLabel: m.seat?.label,
    startDate: fromDbDate(m.startDate),
    endDate,
    timing: formatSlot(m),
    startTime: formatSlot(m).slice(0, 5),
    endTime: formatSlot(m).slice(6),
    status: m.status,
    fee: toRupees(m.fee),
    amountPaid: toRupees(m.amountPaid),
    pendingAmount: toRupees(pending),
    paymentStatus: pending.gt(0) ? ("PENDING" as const) : ("PAID" as const),
    daysRemaining: m.status === "ACTIVE" ? daysRemaining(endDate, today) : 0,
    /** While OVERDUE: last day the seat is held, and days left before cancellation. */
    graceEndsOn: graceEnds,
    graceDaysLeft: m.status === "OVERDUE" && graceEnds ? daysRemaining(graceEnds, today) : null,
    cancelReason: m.cancelReason,
    renewsId: m.previousId,
  };
}
