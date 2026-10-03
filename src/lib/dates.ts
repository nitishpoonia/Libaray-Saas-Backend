import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/**
 * Calendar dates travel through the app as "YYYY-MM-DD" strings. A calendar date has
 * no time and no timezone, so a string avoids the classic bug where midnight in IST
 * turns into the previous day in UTC.
 *
 * Postgres DATE columns come back from Prisma as a JS Date at 00:00 UTC, so the
 * converters below read and write them in UTC.
 */
export type IsoDate = string;

const ISO_DATE = "YYYY-MM-DD";

export function isIsoDate(value: string): boolean {
  return dayjs(value, ISO_DATE, true).isValid();
}

/** Today's date in the given timezone, e.g. the library's "Asia/Kolkata". */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return dayjs(now).tz(timeZone).format(ISO_DATE);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return dayjs.utc(date, ISO_DATE).add(days, "day").format(ISO_DATE);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return dayjs.utc(to, ISO_DATE).diff(dayjs.utc(from, ISO_DATE), "day");
}

export function toDbDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function fromDbDate(date: Date): IsoDate {
  return dayjs.utc(date).format(ISO_DATE);
}

/** First and last day of a month ("YYYY-MM"), as calendar dates. */
export function monthRange(month: string): { first: IsoDate; last: IsoDate } {
  const start = dayjs.utc(`${month}-01`, ISO_DATE);
  return { first: start.format(ISO_DATE), last: start.endOf("month").format(ISO_DATE) };
}

/** Start and end instants of a range of local calendar days, for timestamp columns. */
export function localDayBounds(
  first: IsoDate,
  last: IsoDate,
  timeZone: string,
): { gte: Date; lt: Date } {
  return {
    gte: dayjs.tz(first, timeZone).toDate(),
    lt: dayjs.tz(addDays(last, 1), timeZone).toDate(),
  };
}
