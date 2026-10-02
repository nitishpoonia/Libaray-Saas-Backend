import { addDays, fromDbDate, toDbDate, todayIn } from "../../lib/dates";
import { logger } from "../../lib/logger";
import { money, toRupees } from "../../lib/money";
import { prisma } from "../../lib/prisma";
import { isSubscriptionUsable } from "../../middleware/subscription";
import { runSubscriptionSweep } from "../billing/sweep";
import { syncLifecycle } from "../memberships/lifecycle";
import type { PushSender, TextSender } from "./channels";
import { deliverOnce, type Delivery } from "./deliver";
import { cancellationWarning, dailyDigest, overdueNotice } from "./templates";

export type Senders = { text: TextSender; push: PushSender };

export type LibraryRunStats = {
  libraryId: number;
  lifecycle: { overdue: number; completed: number; cancelled: number };
  notices: Record<Delivery, number>;
};

const emptyCounts = (): Record<Delivery, number> => ({ SENT: 0, SKIPPED: 0, FAILED: 0, ALREADY_DONE: 0 });

/**
 * One branch's daily work:
 *   1. Bring membership statuses up to date (overdue, completed, cancelled).
 *   2. Text students: overdue notice once per period, warning on the last reserved day.
 *   3. Push the owner and managers one digest.
 * Every step is safe to repeat; re-running the job the same day sends nothing twice.
 */
export async function runDailyForLibrary(
  library: { id: number; name: string; timezone: string; gracePeriodDays: number; organizationId: number },
  senders: Senders,
  now: Date,
): Promise<LibraryRunStats> {
  const lifecycle = await syncLifecycle(library, now);
  const today = lifecycle.today;
  const notices = emptyCounts();
  const count = (d: Delivery) => (notices[d] += 1);

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: library.organizationId },
    select: { ownerId: true, subscriptionStatus: true, trialEndsAt: true, currentPeriodEnd: true },
  });
  // SMS costs money per message: only for branches whose subscription is usable.
  const textsAllowed = isSubscriptionUsable(org, now);

  const overdue = await prisma.membership.findMany({
    where: { libraryId: library.id, status: "OVERDUE" },
    include: { student: { select: { name: true, phone: true } }, seat: { select: { label: true } } },
    orderBy: { graceEndsOn: "asc" },
  });

  const cancelTomorrow: string[] = [];
  for (const m of overdue) {
    const graceEndsOn = m.graceEndsOn ? fromDbDate(m.graceEndsOn) : today;
    const period = {
      studentName: m.student.name,
      libraryName: library.name,
      seatLabel: m.seat.label,
      startMinute: m.startMinute,
      endMinute: m.endMinute,
      endDate: fromDbDate(m.endDate),
      graceEndsOn,
      pendingAmount: toRupees(m.fee.minus(m.amountPaid)),
    };
    const isLastDay = graceEndsOn === today;
    if (isLastDay) cancelTomorrow.push(m.student.name);
    if (!textsAllowed) continue;

    const base = {
      libraryId: library.id,
      membershipId: m.id,
      channel: senders.text.channel,
      recipient: m.student.phone,
    } as const;

    count(
      await deliverOnce({ ...base, type: "OVERDUE_NOTICE", referenceDate: period.endDate }, () =>
        senders.text.send(m.student.phone, overdueNotice(period)),
      ),
    );
    if (isLastDay) {
      count(
        await deliverOnce({ ...base, type: "CANCELLATION_WARNING", referenceDate: graceEndsOn }, () =>
          senders.text.send(
            m.student.phone,
            cancellationWarning({ ...period, cancelDate: addDays(graceEndsOn, 1) }),
          ),
        ),
      );
    }
  }

  // ── Digest for the owner and managers ──
  const todayDb = toDbDate(today);
  const [newlyCancelled, endingSoon, dues, managers] = await Promise.all([
    prisma.membership.findMany({
      where: {
        libraryId: library.id,
        status: "CANCELLED",
        cancelReason: "NOT_RENEWED",
        cancelledAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
      select: { student: { select: { name: true } } },
    }),
    prisma.membership.aggregate({
      where: {
        libraryId: library.id,
        status: "ACTIVE",
        endDate: { gte: todayDb, lte: toDbDate(addDays(today, 2)) },
        next: { is: null },
      },
      _count: true,
      // Each period has its own fee now, so this is the real renewal amount (REVIEW B12).
      _sum: { fee: true },
    }),
    prisma.membership.aggregate({
      where: { libraryId: library.id, amountPaid: { lt: prisma.membership.fields.fee } },
      _sum: { fee: true, amountPaid: true },
    }),
    prisma.libraryStaff.findMany({
      where: { libraryId: library.id, role: "MANAGER" },
      select: { userId: true },
    }),
  ]);

  const digest = dailyDigest({
    libraryName: library.name,
    cancelTomorrow,
    newlyCancelled: newlyCancelled.map((m) => m.student.name),
    overdueCount: overdue.length,
    endingSoonCount: endingSoon._count,
    endingSoonFees: toRupees(money(endingSoon._sum.fee ?? 0)),
    pendingFees: toRupees(money(dues._sum.fee ?? 0).minus(dues._sum.amountPaid ?? 0)),
  });

  if (digest) {
    const recipientIds = [org.ownerId, ...managers.map((m) => m.userId)];
    const recipients = await prisma.user.findMany({
      where: { id: { in: recipientIds }, notificationsEnabled: true },
      select: { id: true },
    });
    for (const user of recipients) {
      count(
        await deliverOnce(
          {
            libraryId: library.id,
            membershipId: null,
            type: "DAILY_DIGEST",
            channel: "PUSH",
            recipient: `user:${user.id}`,
            referenceDate: today,
          },
          () => senders.push.send(user.id, { ...digest, data: { libraryId: String(library.id), screen: "dashboard" } }),
        ),
      );
    }
  }

  return {
    libraryId: library.id,
    lifecycle: {
      overdue: lifecycle.overdue.length,
      completed: lifecycle.completed.length,
      cancelled: lifecycle.cancelled.length,
    },
    notices,
  };
}

const JOB_NAME = "daily";

/** A run still RUNNING after this long is treated as crashed and can be taken over. */
const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Claims today's run in one statement. Inserts the row, or takes over a run that
 * finished or crashed; returns null while another run is in progress, so a manual
 * re-run during the scheduled one can't send every text twice.
 */
async function claimRun(runDate: Date, now: Date): Promise<number | null> {
  const staleBefore = new Date(now.getTime() - STALE_RUN_MS);
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    INSERT INTO job_runs (name, run_date, status, started_at)
    VALUES (${JOB_NAME}, ${runDate}, 'RUNNING'::"JobRunStatus", ${now})
    ON CONFLICT (name, run_date) DO UPDATE
      SET status = 'RUNNING'::"JobRunStatus", started_at = EXCLUDED.started_at,
          finished_at = NULL, error = NULL
      WHERE job_runs.status <> 'RUNNING'::"JobRunStatus" OR job_runs.started_at < ${staleBefore}
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/**
 * Runs the daily work for every branch and records the run (REVIEW A3, O4).
 * One branch failing doesn't stop the others; the run is marked FAILED and the
 * next run retries whatever didn't go out.
 */
export async function runDailyJob(senders: Senders, now = new Date()) {
  const runDate = toDbDate(todayIn("Asia/Kolkata", now));
  const runId = await claimRun(runDate, now);
  if (runId === null) {
    logger.warn({ runDate }, "Daily job is already running; skipped");
    return { status: "ALREADY_RUNNING" as const, libraries: 0, subscriptions: null, results: [], failures: [] };
  }
  const run = { id: runId };

  // Before the branches, so texts are only sent for subscriptions that are still usable.
  let subscriptions: Awaited<ReturnType<typeof runSubscriptionSweep>> | null = null;
  const failures: Array<{ libraryId: number | null; error: string }> = [];
  try {
    subscriptions = await runSubscriptionSweep(senders.push, now);
  } catch (err) {
    logger.error({ err }, "Subscription sweep failed");
    failures.push({ libraryId: null, error: err instanceof Error ? err.message : String(err) });
  }

  const libraries = await prisma.library.findMany({
    select: { id: true, name: true, timezone: true, gracePeriodDays: true, organizationId: true },
    orderBy: { id: "asc" },
  });

  const results: LibraryRunStats[] = [];
  for (const library of libraries) {
    try {
      results.push(await runDailyForLibrary(library, senders, now));
    } catch (err) {
      logger.error({ err, libraryId: library.id }, "Daily job failed for library");
      failures.push({ libraryId: library.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const failedNotices = results.reduce((n, r) => n + r.notices.FAILED, 0);
  const status = failures.length || failedNotices ? "FAILED" : "SUCCEEDED";
  const stats = { libraries: libraries.length, subscriptions, results, failures };

  await prisma.jobRun.update({
    where: { id: run.id },
    data: {
      status,
      stats: JSON.parse(JSON.stringify(stats)),
      error: failures.length ? `${failures.length} step(s) failed` : failedNotices ? `${failedNotices} notice(s) failed` : null,
      finishedAt: new Date(),
    },
  });

  return { status, ...stats };
}
