import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { toDbDate } from "../../lib/dates";
import { conflict, notFound } from "../../lib/errors";
import { sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { id, isoDate, timeOfDay } from "../../lib/validation";
import { requireAccess, requireRole } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";
import { findConflicts } from "../memberships/availability";
import { syncLifecycle } from "../memberships/lifecycle";
import { periodEnd } from "../memberships/rules";

const label = z.string().trim().min(1).max(20);

const addBody = z.union([
  // Add N seats numbered after the current highest number.
  z.object({ count: z.coerce.number().int().min(1).max(500), hasLocker: z.boolean().optional() }),
  // Add one seat with a custom label, e.g. "A1".
  z.object({ label, hasLocker: z.boolean().optional() }),
]);

const updateBody = z
  .object({ label: label.optional(), hasLocker: z.boolean().optional() })
  .refine((b) => b.label !== undefined || b.hasLocker !== undefined, "Nothing to update");

const availabilityQuery = z.object({
  startDate: isoDate.optional(),
  days: z.coerce.number().int().min(1).max(366),
  startTime: timeOfDay,
  endTime: timeOfDay,
});

const seatSelect = { id: true, label: true, position: true, hasLocker: true } as const;

async function list(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const seats = await prisma.seat.findMany({
    where: { libraryId: library.id, archivedAt: null },
    select: seatSelect,
    orderBy: { position: "asc" },
  });
  sendData(res, seats);
}

/**
 * Which seats are free for a given period and daily time.
 * Used by the add-student and renewal screens before booking.
 */
async function availability(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const query = availabilityQuery.parse(req.query);
  const { today } = await syncLifecycle(library);

  const startDate = query.startDate ?? today;
  const booking = {
    startDate,
    endDate: periodEnd(startDate, query.days),
    startMinute: query.startTime,
    endMinute: query.endTime,
  };

  const seats = await prisma.seat.findMany({
    where: { libraryId: library.id, archivedAt: null },
    select: seatSelect,
    orderBy: { position: "asc" },
  });
  const conflicts = await findConflicts(prisma, library.id, seats.map((s) => s.id), booking);
  const taken = new Set(conflicts.map((c) => c.seatId));

  sendData(
    res,
    seats.map((s) => ({ ...s, available: !taken.has(s.id) })),
    {
      period: { startDate: booking.startDate, endDate: booking.endDate },
      totalSeats: seats.length,
      availableCount: seats.length - taken.size,
    },
  );
}

async function add(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const body = addBody.parse(req.body);

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.seat.findMany({
      where: { libraryId: library.id },
      select: { label: true, position: true },
    });
    let position = Math.max(0, ...existing.map((s) => s.position));

    if ("count" in body) {
      const taken = new Set(existing.map((s) => s.label));
      let n = Math.max(0, ...existing.map((s) => Number(s.label)).filter(Number.isInteger));
      const labels: string[] = [];
      while (labels.length < body.count) {
        n += 1;
        if (!taken.has(String(n))) labels.push(String(n));
      }
      await tx.seat.createMany({
        data: labels.map((l) => ({
          libraryId: library.id,
          label: l,
          position: ++position,
          hasLocker: body.hasLocker ?? false,
        })),
      });
      return tx.seat.findMany({
        where: { libraryId: library.id, label: { in: labels } },
        select: seatSelect,
        orderBy: { position: "asc" },
      });
    }

    // A duplicate label is a 409 from the unique constraint.
    return [
      await tx.seat.create({
        data: {
          libraryId: library.id,
          label: body.label,
          position: position + 1,
          hasLocker: body.hasLocker ?? false,
        },
        select: seatSelect,
      }),
    ];
  });

  sendData(res, created, undefined, 201);
}

async function update(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const seatId = id.parse(req.params.seatId);
  const body = updateBody.parse(req.body);
  const { count } = await prisma.seat.updateMany({
    where: { id: seatId, libraryId: library.id, archivedAt: null },
    data: body,
  });
  if (!count) throw notFound("Seat not found", "SEAT_NOT_FOUND");
  sendData(res, await prisma.seat.findUniqueOrThrow({ where: { id: seatId }, select: seatSelect }));
}

/**
 * Removes a seat. It's archived, not deleted, so past memberships keep pointing at it.
 * Refused while any current or future booking uses it (REVIEW B19: past bookings
 * no longer block removal).
 */
async function remove(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const seatId = id.parse(req.params.seatId);
  const { today } = await syncLifecycle(library);

  const seat = await prisma.seat.findFirst({
    where: { id: seatId, libraryId: library.id, archivedAt: null },
  });
  if (!seat) throw notFound("Seat not found", "SEAT_NOT_FOUND");

  const inUse = await prisma.membership.count({
    where: {
      seatId,
      status: { in: ["ACTIVE", "OVERDUE"] },
      endDate: { gte: toDbDate(today) },
    },
  });
  const overdueHolding = await prisma.membership.count({ where: { seatId, status: "OVERDUE" } });
  if (inUse + overdueHolding > 0) {
    throw conflict(`Seat ${seat.label} has current or upcoming bookings`, "SEAT_IN_USE");
  }

  await prisma.seat.update({ where: { id: seatId }, data: { archivedAt: new Date() } });
  res.status(204).end();
}

const router = Router({ mergeParams: true });
router.get("/", list);
router.get("/availability", availability);
router.post("/", requireRole("MANAGER"), requireActiveSubscription, add);
router.patch("/:seatId", requireRole("MANAGER"), requireActiveSubscription, update);
router.delete("/:seatId", requireRole("MANAGER"), requireActiveSubscription, remove);

export default router;
