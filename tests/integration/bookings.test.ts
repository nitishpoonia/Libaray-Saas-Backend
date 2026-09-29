import { beforeEach, describe, expect, it } from "vitest";
import { addDays, todayIn } from "../../src/lib/dates";
import { addStudent, api, auth, createLibrary, resetDb, signupOwner } from "./helpers";

beforeEach(resetDb);

const today = () => todayIn("Asia/Kolkata");

describe("seat booking (REVIEW B1, B2, B5)", () => {
  it("refuses a clashing slot and allows a free one", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const seat = lib.seats[0]!.id;

    expect((await addStudent(owner.token, lib.id, { seatId: seat, startTime: "09:00", endTime: "14:00" })).status).toBe(201);

    const clash = await addStudent(owner.token, lib.id, { seatId: seat, startTime: "13:00", endTime: "18:00" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SEAT_UNAVAILABLE");

    const after = await addStudent(owner.token, lib.id, { seatId: seat, startTime: "14:00", endTime: "20:00" });
    expect(after.status).toBe(201);
  });

  it("catches clashes across midnight", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const seat = lib.seats[0]!.id;

    await addStudent(owner.token, lib.id, { seatId: seat, startTime: "22:00", endTime: "02:00" });
    const evening = await addStudent(owner.token, lib.id, { seatId: seat, startTime: "10:00", endTime: "23:00" });
    const morning = await addStudent(owner.token, lib.id, { seatId: seat, startTime: "01:00", endTime: "03:00" });
    expect(evening.status).toBe(409);
    expect(morning.status).toBe(409);
  });

  it("lets only one of two simultaneous bookings take a seat", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const seat = lib.seats[0]!.id;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => addStudent(owner.token, lib.id, { seatId: seat })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);

    const list = await api().get(`/v1/libraries/${lib.id}/students`).set(auth(owner.token));
    expect(list.body.meta.total).toBe(1);
  });

  it("availability agrees with booking, for paid and unpaid students", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner, 3);
    // Seat 1 fully paid, seat 2 unpaid: both are taken.
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id });
    await addStudent(owner.token, lib.id, { seatId: lib.seats[1]!.id, payment: null });

    const res = await api()
      .get(`/v1/libraries/${lib.id}/seats/availability`)
      .query({ days: 30, startTime: "10:00", endTime: "12:00" })
      .set(auth(owner.token));
    expect(res.body.data.map((s: { available: boolean }) => s.available)).toEqual([false, false, true]);
    expect(res.body.meta.availableCount).toBe(1);
  });

  it("rolls back the student when the booking fails", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const tooMuch = await addStudent(owner.token, lib.id, {
      seatId: lib.seats[0]!.id,
      fee: 500,
      payment: { amount: 800, mode: "UPI" },
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe("OVERPAYMENT");
    const list = await api().get(`/v1/libraries/${lib.id}/students?status=all`).set(auth(owner.token));
    expect(list.body.meta.total).toBe(0);
  });
});

describe("payments and receipts (REVIEW B13)", () => {
  it("numbers receipts per branch without gaps or duplicates, even concurrently", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const added = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, fee: 1000, payment: null });
    const membershipId = added.body.data.student.current.id;

    const payments = await Promise.all(
      Array.from({ length: 4 }, () =>
        api()
          .post(`/v1/libraries/${lib.id}/memberships/${membershipId}/payments`)
          .set(auth(owner.token))
          .send({ amount: 250, mode: "CASH" }),
      ),
    );
    expect(payments.map((p) => p.status)).toEqual([201, 201, 201, 201]);
    expect(payments.map((p) => p.body.data.receiptNumber).sort()).toEqual([
      "RCP-000001",
      "RCP-000002",
      "RCP-000003",
      "RCP-000004",
    ]);

    const detail = await api().get(`/v1/libraries/${lib.id}/students/${added.body.data.student.id}`).set(auth(owner.token));
    expect(detail.body.data.pendingAmount).toBe(0);
    expect(detail.body.data.current.paymentStatus).toBe("PAID");

    // A fifth payment has nothing left to pay.
    const extra = await api()
      .post(`/v1/libraries/${lib.id}/memberships/${membershipId}/payments`)
      .set(auth(owner.token))
      .send({ amount: 1, mode: "CASH" });
    expect(extra.body.error.code).toBe("NOTHING_PENDING");

    // A second branch starts its own numbering.
    const lib2 = await createLibrary(owner);
    const other = await addStudent(owner.token, lib2.id, { seatId: lib2.seats[0]!.id });
    expect(other.body.data.receipt.receiptNumber).toBe("RCP-000001");
  });

  it("voids a payment and puts the amount back as pending", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const added = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, fee: 1000 });
    const paymentId = added.body.data.receipt.id;

    const voided = await api()
      .post(`/v1/libraries/${lib.id}/payments/${paymentId}/void`)
      .set(auth(owner.token))
      .send({ reason: "Entered twice" });
    expect(voided.body.data.voided).toBe(true);

    const detail = await api().get(`/v1/libraries/${lib.id}/students/${added.body.data.student.id}`).set(auth(owner.token));
    expect(detail.body.data.pendingAmount).toBe(1000);
  });
});

describe("student list (REVIEW B3, B4, B6)", () => {
  it("shows paid and unpaid students and filters in the database", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner, 10);
    for (let i = 0; i < 7; i++) {
      await addStudent(owner.token, lib.id, {
        seatId: lib.seats[i]!.id,
        name: `Student ${i}`,
        payment: i < 4 ? { amount: 1000, mode: "CASH" } : { amount: 400, mode: "UPI" },
      });
    }

    const page1 = await api().get(`/v1/libraries/${lib.id}/students?limit=5`).set(auth(owner.token));
    expect(page1.body.meta.total).toBe(7);
    expect(page1.body.data).toHaveLength(5);
    const page2 = await api().get(`/v1/libraries/${lib.id}/students?limit=5&page=2`).set(auth(owner.token));
    expect(page2.body.data).toHaveLength(2);

    const pending = await api().get(`/v1/libraries/${lib.id}/students?status=pending`).set(auth(owner.token));
    expect(pending.body.meta.total).toBe(3);
    expect(pending.body.data[0].flags).toEqual(["FEES_PENDING"]);
    expect(pending.body.data[0].pendingAmount).toBe(600);
  });

  it("frees the seat when a fully paid student is removed", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const seat = lib.seats[0]!.id;
    const added = await addStudent(owner.token, lib.id, { seatId: seat });
    await api().delete(`/v1/libraries/${lib.id}/students/${added.body.data.student.id}`).set(auth(owner.token));

    expect((await addStudent(owner.token, lib.id, { seatId: seat })).status).toBe(201);
    const archived = await api().get(`/v1/libraries/${lib.id}/students?status=archived`).set(auth(owner.token));
    expect(archived.body.meta.total).toBe(1);
  });
});

describe("seat management (REVIEW B19)", () => {
  it("removes a seat with only past history, not one in use", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner, 2);
    const [seat1, seat2] = lib.seats;
    await addStudent(owner.token, lib.id, { seatId: seat1!.id });
    const past = await addStudent(owner.token, lib.id, {
      seatId: seat2!.id,
      startDate: addDays(today(), -60),
      days: 30,
    });
    // Seat 2's booking ended long ago; the grace period is over, so it's cancelled.
    const detail = await api().get(`/v1/libraries/${lib.id}/students/${past.body.data.student.id}`).set(auth(owner.token));
    expect(detail.body.data.memberships[0].status).toBe("CANCELLED");

    expect((await api().delete(`/v1/libraries/${lib.id}/seats/${seat1!.id}`).set(auth(owner.token))).status).toBe(409);
    expect((await api().delete(`/v1/libraries/${lib.id}/seats/${seat2!.id}`).set(auth(owner.token))).status).toBe(204);
  });
});
