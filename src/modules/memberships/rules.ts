import { addDays, daysBetween, type IsoDate } from "../../lib/dates";

/**
 * Product rule for unpaid renewals (confirmed with the owner):
 *
 *   A membership that ends without a renewal becomes OVERDUE. The seat stays reserved
 *   for the grace period. The day before cancellation, the student and owner are warned.
 *   On the last day of the grace period the membership is cancelled and the seat released.
 *
 * With the default grace period of 7 days and a membership ending on 10 Jan:
 *
 *   11 Jan  day 1  OVERDUE, seat reserved         (overdue notice)
 *   ...
 *   16 Jan  day 6  OVERDUE, seat reserved         (warning: "cancelled tomorrow")
 *   17 Jan  day 7  CANCELLED, seat released
 *
 * so graceEndsOn (the last reserved day) = endDate + gracePeriodDays - 1.
 */
export function graceEndsOn(endDate: IsoDate, gracePeriodDays: number): IsoDate {
  return addDays(endDate, gracePeriodDays - 1);
}

/** The warning goes out on the last reserved day. */
export function isCancellationWarningDay(grace: IsoDate, today: IsoDate): boolean {
  return grace === today;
}

export type LifecycleInput = {
  status: "ACTIVE" | "OVERDUE" | "COMPLETED" | "CANCELLED";
  endDate: IsoDate;
  graceEndsOn: IsoDate | null;
  /** A renewal period exists and isn't cancelled. */
  renewed: boolean;
};

export type LifecycleChange =
  | { to: "COMPLETED" }
  | { to: "OVERDUE"; graceEndsOn: IsoDate }
  | { to: "CANCELLED" }
  | null;

/** What the daily job should do to one membership today. Null means nothing. */
export function nextLifecycleChange(
  m: LifecycleInput,
  today: IsoDate,
  gracePeriodDays: number,
): LifecycleChange {
  if (m.status === "ACTIVE" && m.endDate < today) {
    if (m.renewed) return { to: "COMPLETED" };
    const grace = graceEndsOn(m.endDate, gracePeriodDays);
    // Grace already ran out (e.g. the job didn't run for a while): cancel directly.
    if (grace < today) return { to: "CANCELLED" };
    return { to: "OVERDUE", graceEndsOn: grace };
  }

  if (m.status === "OVERDUE") {
    if (m.renewed) return { to: "COMPLETED" };
    if (m.graceEndsOn !== null && m.graceEndsOn < today) return { to: "CANCELLED" };
  }

  return null;
}

/** The last day of a period that starts on `startDate` and runs for `days` days. */
export function periodEnd(startDate: IsoDate, days: number): IsoDate {
  return addDays(startDate, days - 1);
}

/** Days left including today (0 once the period is over). */
export function daysRemaining(endDate: IsoDate, today: IsoDate): number {
  return Math.max(0, daysBetween(today, endDate) + 1);
}
