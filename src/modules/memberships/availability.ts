import { addDays, fromDbDate, toDbDate, type IsoDate } from "../../lib/dates";
import type { Db } from "../../lib/db";
import { conflict, notFound } from "../../lib/errors";
import { crossesMidnight, formatSlot, slotsOverlap, type Slot } from "./slots";

export type Booking = { startDate: IsoDate; endDate: IsoDate } & Slot;

export type Conflict = {
  membershipId: number;
  seatId: number;
  startDate: IsoDate;
  endDate: IsoDate;
  timing: string;
};

/**
 * Last calendar day a booking actually occupies. A slot that crosses midnight
 * spills into the morning after its end date (22:00-02:00 ending 10 Jan still
 * holds the seat until 02:00 on 11 Jan).
 */
function lastOccupiedDay(b: Booking): IsoDate {
  return crossesMidnight(b) ? addDays(b.endDate, 1) : b.endDate;
}

/**
 * Memberships that clash with `booking` on the given seats.
 *
 * Two bookings clash when their days overlap AND their daily slots overlap. The day
 * check uses lastOccupiedDay, so it can report a clash on the single boundary day
 * of two midnight-crossing slots that don't truly touch. That errs on the side of
 * never double-booking.
 *
 * ACTIVE and OVERDUE memberships hold the seat. An OVERDUE one keeps holding it,
 * in its usual daily slot, until graceEndsOn. COMPLETED periods are in the past and
 * CANCELLED ones released the seat.
 */
export async function findConflicts(
  db: Db,
  libraryId: number,
  seatIds: number[],
  booking: Booking,
  excludeMembershipId?: number,
): Promise<Conflict[]> {
  if (seatIds.length === 0) return [];

  const existing = await db.membership.findMany({
    where: {
      libraryId,
      seatId: { in: seatIds },
      status: { in: ["ACTIVE", "OVERDUE"] },
      startDate: { lte: toDbDate(lastOccupiedDay(booking)) },
      OR: [
        // One day of slack for existing slots that spill past midnight; filtered precisely below.
        { endDate: { gte: toDbDate(addDays(booking.startDate, -1)) } },
        { status: "OVERDUE" },
      ],
      ...(excludeMembershipId ? { id: { not: excludeMembershipId } } : {}),
    },
    select: {
      id: true,
      seatId: true,
      startDate: true,
      endDate: true,
      startMinute: true,
      endMinute: true,
      status: true,
      graceEndsOn: true,
    },
  });

  return existing
    .map((m) => {
      const endDate = fromDbDate(m.endDate);
      const grace = m.graceEndsOn ? fromDbDate(m.graceEndsOn) : null;
      // While overdue, the seat is held through the grace period.
      const heldUntil = m.status === "OVERDUE" && grace && grace > endDate ? grace : endDate;
      return {
        id: m.id,
        seatId: m.seatId,
        startMinute: m.startMinute,
        endMinute: m.endMinute,
        startDate: fromDbDate(m.startDate),
        endDate,
        heldUntil,
      };
    })
    .filter(
      (m) =>
        m.startDate <= lastOccupiedDay(booking) &&
        lastOccupiedDay({ ...m, endDate: m.heldUntil }) >= booking.startDate &&
        slotsOverlap(m, booking),
    )
    .map((m) => ({
      membershipId: m.id,
      seatId: m.seatId,
      startDate: m.startDate,
      endDate: m.endDate,
      timing: formatSlot(m),
    }));
}

/**
 * Locks the seat row until the transaction ends (REVIEW B2). Every booking on a seat
 * takes this lock first, so two people booking the same seat at the same moment are
 * handled one after the other, and the second one sees the first booking.
 */
export async function lockSeat(tx: Db, libraryId: number, seatId: number) {
  const rows = await tx.$queryRaw<Array<{ id: number; label: string; archived_at: Date | null }>>`
    SELECT id, label, archived_at FROM seats
    WHERE id = ${seatId} AND library_id = ${libraryId}
    FOR UPDATE`;
  const seat = rows[0];
  if (!seat) throw notFound("Seat not found", "SEAT_NOT_FOUND");
  if (seat.archived_at) throw conflict("This seat has been removed", "SEAT_REMOVED");
  return { id: seat.id, label: seat.label };
}

/** Lock the seat, then refuse if the booking clashes with anything on it. */
export async function assertSeatFree(
  tx: Db,
  libraryId: number,
  seatId: number,
  booking: Booking,
  excludeMembershipId?: number,
) {
  const seat = await lockSeat(tx, libraryId, seatId);
  const conflicts = await findConflicts(tx, libraryId, [seatId], booking, excludeMembershipId);
  if (conflicts.length > 0) {
    throw conflict(`Seat ${seat.label} is already booked for this time`, "SEAT_UNAVAILABLE", {
      conflicts,
    });
  }
  return seat;
}
