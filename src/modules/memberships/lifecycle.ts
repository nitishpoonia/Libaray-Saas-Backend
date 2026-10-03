import { fromDbDate, todayIn, toDbDate, type IsoDate } from "../../lib/dates";
import { prisma } from "../../lib/prisma";
import type { Db } from "../../lib/db";
import { nextLifecycleChange } from "./rules";

export type LibraryClock = { id: number; timezone: string; gracePeriodDays: number };

export type LifecycleResult = {
  today: IsoDate;
  completed: number[];
  overdue: number[];
  cancelled: number[];
};

/**
 * Moves the branch's memberships to the status they should have today
 * (ACTIVE -> OVERDUE / COMPLETED, OVERDUE -> CANCELLED). See rules.ts for the rule.
 *
 * Safe to call any number of times: each update only applies if the row still has
 * the status it was read with. The daily job calls it to send notices, and reads
 * call it first so lists and seat availability are correct even if the job was late.
 */
export async function syncLifecycle(library: LibraryClock, now = new Date(), db: Db = prisma): Promise<LifecycleResult> {
  const today = todayIn(library.timezone, now);
  const todayDb = toDbDate(today);

  const candidates = await db.membership.findMany({
    where: {
      libraryId: library.id,
      OR: [
        { status: "ACTIVE", endDate: { lt: todayDb } },
        { status: "OVERDUE", graceEndsOn: { lt: todayDb } },
        { status: "OVERDUE", next: { isNot: null } },
      ],
    },
    select: {
      id: true,
      status: true,
      endDate: true,
      graceEndsOn: true,
      next: { select: { status: true } },
    },
  });

  const result: LifecycleResult = { today, completed: [], overdue: [], cancelled: [] };

  for (const m of candidates) {
    const change = nextLifecycleChange(
      {
        status: m.status,
        endDate: fromDbDate(m.endDate),
        graceEndsOn: m.graceEndsOn ? fromDbDate(m.graceEndsOn) : null,
        renewed: m.next !== null && m.next.status !== "CANCELLED",
      },
      today,
      library.gracePeriodDays,
    );
    if (!change) continue;

    const guard = { id: m.id, status: m.status };
    if (change.to === "COMPLETED") {
      const { count } = await db.membership.updateMany({
        where: guard,
        data: { status: "COMPLETED", graceEndsOn: null },
      });
      if (count) result.completed.push(m.id);
    } else if (change.to === "OVERDUE") {
      const { count } = await db.membership.updateMany({
        where: guard,
        data: { status: "OVERDUE", graceEndsOn: toDbDate(change.graceEndsOn) },
      });
      if (count) result.overdue.push(m.id);
    } else {
      const { count } = await db.membership.updateMany({
        where: guard,
        data: { status: "CANCELLED", cancelReason: "NOT_RENEWED", cancelledAt: now },
      });
      if (count) result.cancelled.push(m.id);
    }
  }

  return result;
}
