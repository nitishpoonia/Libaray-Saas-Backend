import { beforeEach, describe, expect, it } from "vitest";
import { addStudent, api, auth, createLibrary, nextPhone, resetDb, signupOwner } from "./helpers";

beforeEach(resetDb);

describe("tenant isolation (REVIEW S1, S2)", () => {
  it("hides one owner's branch and students from another owner", async () => {
    const ownerA = await signupOwner("Owner A");
    const ownerB = await signupOwner("Owner B");
    const libA = await createLibrary(ownerA);
    const added = await addStudent(ownerA.token, libA.id, { seatId: libA.seats[0]!.id });
    const studentId = added.body.data.student.id;

    // B tries A's branch directly: looks exactly like a branch that doesn't exist.
    const asB = auth(ownerB.token);
    for (const path of [
      `/v1/libraries/${libA.id}`,
      `/v1/libraries/${libA.id}/students`,
      `/v1/libraries/${libA.id}/students/${studentId}`,
      `/v1/libraries/${libA.id}/dashboard`,
    ]) {
      const res = await api().get(path).set(asB);
      expect(res.status, path).toBe(404);
    }
    expect((await api().delete(`/v1/libraries/${libA.id}/students/${studentId}`).set(asB)).status).toBe(404);

    // B uses their own branch id but A's student id: still not found.
    const libB = await createLibrary(ownerB);
    const cross = await api().get(`/v1/libraries/${libB.id}/students/${studentId}`).set(asB);
    expect(cross.status).toBe(404);
    const crossPay = await api()
      .post(`/v1/libraries/${libB.id}/memberships/${added.body.data.student.current.id}/payments`)
      .set(asB)
      .send({ amount: 10, mode: "CASH" });
    expect(crossPay.status).toBe(404);

    // A's data is untouched.
    const check = await api().get(`/v1/libraries/${libA.id}/students/${studentId}`).set(auth(ownerA.token));
    expect(check.body.data.archived).toBe(false);
  });

  it("lists only the caller's own branches", async () => {
    const ownerA = await signupOwner("Owner A");
    const ownerB = await signupOwner("Owner B");
    await createLibrary(ownerA);
    await createLibrary(ownerA);
    await createLibrary(ownerB);
    const res = await api().get("/v1/libraries").set(auth(ownerA.token));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((l: { role: string }) => l.role === "OWNER")).toBe(true);
  });
});

describe("staff roles", () => {
  async function addStaff(ownerToken: string, libraryId: number, role: "MANAGER" | "STAFF") {
    const phone = nextPhone();
    const res = await api()
      .post(`/v1/libraries/${libraryId}/staff`)
      .set(auth(ownerToken))
      .send({ name: "Reception", phone, password: "password123", role });
    expect(res.status).toBe(201);
    const login = await api().post("/v1/auth/login").send({ identifier: phone, password: "password123" });
    return login.body.data.accessToken as string;
  }

  it("lets staff run the front desk but not money or settings", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const staff = await addStaff(owner.token, lib.id, "STAFF");

    const added = await addStudent(staff, lib.id, { seatId: lib.seats[0]!.id });
    expect(added.status).toBe(201);

    const dash = await api().get(`/v1/libraries/${lib.id}/dashboard`).set(auth(staff));
    expect(dash.body.data.role).toBe("STAFF");
    expect(dash.body.data.finance).toBeNull();

    const forbidden = [
      api().get(`/v1/libraries/${lib.id}/expenses`).set(auth(staff)),
      api().patch(`/v1/libraries/${lib.id}`).set(auth(staff)).send({ name: "Mine now" }),
      api().post(`/v1/libraries/${lib.id}/seats`).set(auth(staff)).send({ count: 2 }),
      api().get(`/v1/libraries/${lib.id}/staff`).set(auth(staff)),
      api()
        .post(`/v1/libraries/${lib.id}/payments/${added.body.data.receipt.id}/void`)
        .set(auth(staff))
        .send({ reason: "mistake" }),
    ];
    for (const res of await Promise.all(forbidden)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("shows staff only the payments they recorded", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const staff = await addStaff(owner.token, lib.id, "STAFF");

    const byStaff = await addStudent(staff, lib.id, { seatId: lib.seats[0]!.id });
    const byOwner = await addStudent(owner.token, lib.id, { seatId: lib.seats[1]!.id });

    const staffList = await api().get(`/v1/libraries/${lib.id}/payments`).set(auth(staff));
    expect(staffList.body.data.map((p: { id: number }) => p.id)).toEqual([byStaff.body.data.receipt.id]);
    expect(staffList.body.meta.total).toBe(1);

    const own = `/v1/libraries/${lib.id}/payments/${byStaff.body.data.receipt.id}/receipt`;
    const others = `/v1/libraries/${lib.id}/payments/${byOwner.body.data.receipt.id}/receipt`;
    expect((await api().get(own).set(auth(staff))).status).toBe(200);
    expect((await api().get(others).set(auth(staff))).status).toBe(404);

    // The owner still sees both.
    const ownerList = await api().get(`/v1/libraries/${lib.id}/payments`).set(auth(owner.token));
    expect(ownerList.body.meta.total).toBe(2);
  });

  it("lets a manager handle money and settings but not staff", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const manager = await addStaff(owner.token, lib.id, "MANAGER");

    const dash = await api().get(`/v1/libraries/${lib.id}/dashboard`).set(auth(manager));
    expect(dash.body.data.finance).not.toBeNull();
    const expense = await api()
      .post(`/v1/libraries/${lib.id}/expenses`)
      .set(auth(manager))
      .send({ title: "Electricity", category: "Bills", amount: 2400, spentOn: dash.body.data.today });
    expect(expense.status).toBe(201);
    expect((await api().get(`/v1/libraries/${lib.id}/staff`).set(auth(manager))).status).toBe(403);
  });

  it("shows a staff member only the branches they're assigned to", async () => {
    const owner = await signupOwner();
    const lib1 = await createLibrary(owner);
    const lib2 = await createLibrary(owner);
    const staff = await addStaff(owner.token, lib1.id, "STAFF");

    const libs = await api().get("/v1/libraries").set(auth(staff));
    expect(libs.body.data.map((l: { id: number }) => l.id)).toEqual([lib1.id]);
    expect((await api().get(`/v1/libraries/${lib2.id}`).set(auth(staff))).status).toBe(404);
  });
});

describe("subscription", () => {
  it("blocks changes after the trial ends but keeps data readable", async () => {
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    const { prisma } = await import("../../src/lib/prisma");
    await prisma.organization.updateMany({ data: { trialEndsAt: new Date(Date.now() - 1000) } });

    const write = await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("SUBSCRIPTION_INACTIVE");

    const read = await api().get(`/v1/libraries/${lib.id}/dashboard`).set(auth(owner.token));
    expect(read.status).toBe(200);
    expect(read.body.data.subscription.usable).toBe(false);
  });
});
