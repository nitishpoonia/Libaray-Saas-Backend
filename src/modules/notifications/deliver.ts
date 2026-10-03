import type { NotificationChannel, NotificationType } from "../../generated/prisma/client";
import { toDbDate, type IsoDate } from "../../lib/dates";
import { prisma } from "../../lib/prisma";
import type { SendResult } from "./channels";

export type NoticeKey = {
  libraryId: number;
  membershipId: number | null;
  type: NotificationType;
  channel: NotificationChannel;
  recipient: string;
  /** The date the notice is about, e.g. a membership's end date. */
  referenceDate: IsoDate;
};

export type Delivery = "SENT" | "SKIPPED" | "FAILED" | "ALREADY_DONE";

/**
 * Sends a notice at most once per key (REVIEW B11). A notice that was SENT or SKIPPED
 * is never repeated; one that FAILED is retried on the next run.
 */
export async function deliverOnce(key: NoticeKey, send: () => Promise<SendResult>): Promise<Delivery> {
  const where = { ...key, referenceDate: toDbDate(key.referenceDate) };
  const existing = await prisma.notificationLog.findFirst({ where, select: { id: true, status: true } });
  if (existing && existing.status !== "FAILED") return "ALREADY_DONE";

  const result = await send();
  const data = { status: result.status, error: result.status === "SENT" ? null : result.reason };

  if (existing) {
    await prisma.notificationLog.update({ where: { id: existing.id }, data });
  } else {
    await prisma.notificationLog.create({ data: { ...where, ...data } });
  }
  return result.status;
}
