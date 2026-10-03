import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIn } from "../../src/lib/dates";
import { prisma } from "../../src/lib/prisma";
import type { PushSender, SendResult, TextSender } from "../../src/modules/notifications/channels";
import { runDailyJob } from "../../src/modules/notifications/daily";
import type { TextMessage } from "../../src/modules/notifications/templates";
import { addStudent, api, auth, createLibrary, nextPhone, resetDb, signupOwner } from "./helpers";

beforeEach(resetDb);

const today = () => todayIn("Asia/Kolkata");
const endedDaysAgo = (daysAgo: number) => ({ startDate: addDays(today(), -29 - daysAgo), days: 30 });

class FakeText implements TextSender {
  channel = "SMS" as const;
  sent: Array<{ to: string; text: string }> = [];
  fail = false;
  async send(to: string, message: TextMessage): Promise<SendResult> {
    if (this.fail) return { status: "FAILED", reason: "provider down" };
    this.sent.push({ to, text: message.text });
    return { status: "SENT" };
  }
}

class FakePush implements PushSender {
  sent: Array<{ userId: number; title: string; body: string }> = [];
  async send(userId: number, m: { title: string; body: string }): Promise<SendResult> {
    this.sent.push({ userId, ...m });
    return { status: "SENT" };
  }
}

describe("daily job", () => {
  it("texts overdue students once, warns on day 6, and pushes one digest", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner, 5);
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, name: "Day One", ...endedDaysAgo(1), payment: { amount: 600, mode: "CASH" } });
    await addStudent(owner.token, lib.id, { seatId: lib.seats[1]!.id, name: "Day Six", ...endedDaysAgo(6) });
    await addStudent(owner.token, lib.id, { seatId: lib.seats[2]!.id, name: "Day Seven", ...endedDaysAgo(7) });
    await addStudent(owner.token, lib.id, { seatId: lib.seats[3]!.id, name: "Ends Soon", days: 2, fee: 800 });

    const text = new FakeText();
    const push = new FakePush();
    const result = await runDailyJob({ text, push });
    expect(result.status).toBe("SUCCEEDED");

    // Two overdue notices + one cancellation warning (Day Six). Day Seven is already cancelled.
    const texts = text.sent.map((t) => t.text);
    expect(texts).toHaveLength(3);
    expect(texts.find((t) => t.includes("Day One"))).toContain("Pending fees: Rs 400");
    expect(texts.filter((t) => t.includes("cancelled tomorrow"))).toHaveLength(1);
    expect(texts.find((t) => t.includes("cancelled tomorrow"))).toContain("Day Six");

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.userId).toBe(owner.userId);
    expect(push.sent[0]!.body).toContain("Cancelled tomorrow unless renewed: Day Six");
    expect(push.sent[0]!.body).toContain("Cancelled, seat freed: Day Seven");
    expect(push.sent[0]!.body).toContain("1 ending in 3 days (Rs 800 in renewals)");

    // Running again the same day sends nothing new.
    const again = await runDailyJob({ text, push });
    expect(again.status).toBe("SUCCEEDED");
    expect(text.sent).toHaveLength(3);
    expect(push.sent).toHaveLength(1);

    const runs = await prisma.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("SUCCEEDED");
  });

  it("retries failed texts on the next run", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, ...endedDaysAgo(2) });

    const text = new FakeText();
    text.fail = true;
    const first = await runDailyJob({ text, push: new FakePush() });
    expect(first.status).toBe("FAILED");

    text.fail = false;
    const second = await runDailyJob({ text, push: new FakePush() });
    expect(second.status).toBe("SUCCEEDED");
    expect(text.sent).toHaveLength(1);
    const logs = await prisma.notificationLog.findMany({ where: { type: "OVERDUE_NOTICE" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("SENT");
  });

  it("sends a new overdue notice for the next period after a renewal", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const added = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, ...endedDaysAgo(40) });
    const studentId = added.body.data.student.id;

    // Renewed long ago, and that renewal has itself just lapsed.
    await api()
      .post(`/v1/libraries/${lib.id}/students/${studentId}/renewals`)
      .set(auth(owner.token))
      .send({ startDate: addDays(today(), -31), days: 30, fee: 1000 });

    const text = new FakeText();
    await runDailyJob({ text, push: new FakePush() });
    expect(text.sent).toHaveLength(1);
    expect(text.sent[0]!.text).toContain("ended on");
  });

  it("includes managers in the digest but not plain staff, and skips texts without a subscription", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const managerPhone = nextPhone();
    await api().post(`/v1/libraries/${lib.id}/staff`).set(auth(owner.token)).send({ name: "Manager", phone: managerPhone, password: "password123", role: "MANAGER" });
    await api().post(`/v1/libraries/${lib.id}/staff`).set(auth(owner.token)).send({ name: "Desk", phone: nextPhone(), password: "password123", role: "STAFF" });
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, ...endedDaysAgo(2) });
    await prisma.organization.updateMany({ data: { trialEndsAt: new Date(Date.now() - 1000) } });

    const text = new FakeText();
    const push = new FakePush();
    await runDailyJob({ text, push });

    expect(text.sent).toHaveLength(0);
    const manager = await prisma.user.findUniqueOrThrow({ where: { phone: `+91${managerPhone}` } });
    expect(push.sent.map((p) => p.userId).sort()).toEqual([owner.userId, manager.id].sort());
  });

  it("skips while another run is in progress, and takes over a run that crashed", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner, 2);
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, name: "Late", ...endedDaysAgo(1) });
    const runDate = new Date(`${today()}T00:00:00.000Z`);

    // A run that started a minute ago and hasn't finished.
    await prisma.jobRun.create({
      data: { name: "daily", runDate, status: "RUNNING", startedAt: new Date(Date.now() - 60_000) },
    });
    const text = new FakeText();
    const skipped = await runDailyJob({ text, push: new FakePush() });
    expect(skipped.status).toBe("ALREADY_RUNNING");
    expect(text.sent).toHaveLength(0);

    // The same run, but started two hours ago: treated as crashed and taken over.
    await prisma.jobRun.updateMany({ data: { startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    const resumed = await runDailyJob({ text, push: new FakePush() });
    expect(resumed.status).toBe("SUCCEEDED");
    expect(text.sent).toHaveLength(1);
    expect(await prisma.jobRun.count()).toBe(1);
  });
});
