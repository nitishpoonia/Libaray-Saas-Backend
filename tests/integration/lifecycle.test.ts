import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIn } from "../../src/lib/dates";
import { addStudent, api, auth, createLibrary, resetDb, signupOwner } from "./helpers";

beforeEach(resetDb);

const today = () => todayIn("Asia/Kolkata");

/** A 30-day membership that ended `daysAgo` days ago. */
const endedDaysAgo = (daysAgo: number) => ({ startDate: addDays(today(), -29 - daysAgo), days: 30 });

async function setup() {
  const owner = await signupOwner();
  const lib = await createLibrary(owner, 6);
  const get = (path: string) => api().get(`/v1/libraries/${lib.id}${path}`).set(auth(owner.token));
  return { owner, lib, get };
}

describe("overdue rule: 7-day grace, warning on day 6, cancelled on day 7", () => {
  it("marks an unrenewed membership overdue and keeps the seat", async () => {
    const { owner, lib, get } = await setup();
    const added = await addStudent(owner.token, lib.id, {
      seatId: lib.seats[0]!.id,
      ...endedDaysAgo(1),
      payment: { amount: 600, mode: "CASH" },
    });
    const studentId = added.body.data.student.id;

    const detail = await get(`/students/${studentId}`);
    const current = detail.body.data.current;
    expect(current.status).toBe("OVERDUE");
    expect(current.graceEndsOn).toBe(addDays(today(), 5));
    expect(current.graceDaysLeft).toBe(6);
    expect(current.pendingAmount).toBe(400);

    // Card shows both flags with the amount (owner's rule for Q1).
    const overdueList = await get("/students?status=overdue");
    expect(overdueList.body.data[0].flags).toEqual(["OVERDUE", "FEES_PENDING"]);
    expect(overdueList.body.data[0].pendingAmount).toBe(400);

    // Seat stays reserved during the grace period.
    const seatTaken = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id });
    expect(seatTaken.status).toBe(409);
  });

  it("is still overdue on day 6 and cancelled on day 7, freeing the seat", async () => {
    const { owner, lib, get } = await setup();
    const day6 = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, ...endedDaysAgo(6) });
    const day7 = await addStudent(owner.token, lib.id, { seatId: lib.seats[1]!.id, ...endedDaysAgo(7) });

    const six = (await get(`/students/${day6.body.data.student.id}`)).body.data.memberships[0];
    expect(six.status).toBe("OVERDUE");
    expect(six.graceEndsOn).toBe(today());
    expect(six.graceDaysLeft).toBe(1);

    const seven = (await get(`/students/${day7.body.data.student.id}`)).body.data.memberships[0];
    expect(seven.status).toBe("CANCELLED");
    expect(seven.cancelReason).toBe("NOT_RENEWED");

    expect((await addStudent(owner.token, lib.id, { seatId: lib.seats[1]!.id })).status).toBe(201);
  });

  it("continues an overdue membership from its end date when renewed", async () => {
    const { owner, lib, get } = await setup();
    const added = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, ...endedDaysAgo(3) });
    const studentId = added.body.data.student.id;
    const oldEnd = addDays(today(), -3);

    const renewal = await api()
      .post(`/v1/libraries/${lib.id}/students/${studentId}/renewals`)
      .set(auth(owner.token))
      .send({ days: 30, fee: 1000, payment: { amount: 1000, mode: "UPI" } });
    expect(renewal.status).toBe(201);

    const [latest, previous] = renewal.body.data.student.memberships;
    expect(previous.status).toBe("COMPLETED");
    expect(latest.status).toBe("ACTIVE");
    expect(latest.startDate).toBe(addDays(oldEnd, 1));
    expect(latest.renewsId).toBe(previous.id);
    expect(latest.seatId).toBe(lib.seats[0]!.id);
    expect(latest.timing).toBe(previous.timing);
    expect(renewal.body.data.receipt.receiptNumber).toBe("RCP-000002");

    const overdue = await get("/students?status=overdue");
    expect(overdue.body.meta.total).toBe(0);
  });

  it("renews early without overlapping the current period", async () => {
    const { owner, lib } = await setup();
    const added = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, days: 10 });
    const studentId = added.body.data.student.id;

    const tooEarly = await api()
      .post(`/v1/libraries/${lib.id}/students/${studentId}/renewals`)
      .set(auth(owner.token))
      .send({ days: 30, fee: 1000, startDate: today() });
    expect(tooEarly.body.error.code).toBe("RENEWAL_OVERLAPS_CURRENT");

    const ok = await api()
      .post(`/v1/libraries/${lib.id}/students/${studentId}/renewals`)
      .set(auth(owner.token))
      .send({ days: 30, fee: 1000 });
    expect(ok.status).toBe(201);
    const [next, current] = ok.body.data.student.memberships;
    expect(next.startDate).toBe(addDays(current.endDate, 1));
    expect(current.status).toBe("ACTIVE");

    // Renewed, so it no longer counts as expiring soon.
    const expiring = await api().get(`/v1/libraries/${lib.id}/students?status=expiring`).set(auth(owner.token));
    expect(expiring.body.meta.total).toBe(0);
  });

  it("refuses a renewal onto a seat someone else booked for that period", async () => {
    const { owner, lib } = await setup();
    const first = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, days: 10 });
    // Another student takes the same seat and time right after the first period.
    await addStudent(owner.token, lib.id, {
      seatId: lib.seats[0]!.id,
      startDate: addDays(today(), 10),
      days: 30,
    });

    const renewal = await api()
      .post(`/v1/libraries/${lib.id}/students/${first.body.data.student.id}/renewals`)
      .set(auth(owner.token))
      .send({ days: 30, fee: 1000 });
    expect(renewal.status).toBe(409);
    expect(renewal.body.error.code).toBe("SEAT_UNAVAILABLE");
  });
});

describe("dashboard (REVIEW B9)", () => {
  it("counts students, seats, dues and this month's money", async () => {
    const { owner, lib, get } = await setup();
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, fee: 1000 }); // active, paid
    await addStudent(owner.token, lib.id, {
      seatId: lib.seats[1]!.id,
      fee: 1000,
      payment: { amount: 300, mode: "CASH" },
      days: 5,
    }); // active, 700 pending, expiring
    await addStudent(owner.token, lib.id, { seatId: lib.seats[2]!.id, ...endedDaysAgo(2), payment: null }); // overdue, 1000 pending
    await addStudent(owner.token, lib.id, { seatId: lib.seats[3]!.id, ...endedDaysAgo(20) }); // cancelled

    await api()
      .post(`/v1/libraries/${lib.id}/expenses`)
      .set(auth(owner.token))
      .send({ title: "Rent", category: "Rent", amount: 500, spentOn: today() });

    const d = (await get("/dashboard")).body.data;
    expect(d.seats).toEqual({ total: 6, inUse: 3, free: 3 });
    expect(d.students).toEqual({ active: 2, overdue: 1, expiringSoon: 1, withPendingFees: 2 });
    expect(d.pendingFees).toBe(1700);
    // Payments collected today: 1000 + 300 + 1000 (the cancelled one was paid in full).
    expect(d.finance.revenue).toBe(2300);
    expect(d.finance.expenses).toBe(500);
    expect(d.finance.balance).toBe(1800);
    expect(d.subscription.status).toBe("TRIALING");
  });
});
