import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { encryptSecret, newTotpSecret, stepAt, totpAt } from "../../src/lib/totp";
import { hashAdminPassword } from "../../src/modules/admin/auth";
import { addStudent, api, auth, createLibrary, nextPhone, resetDb, signupOwner } from "./helpers";

beforeEach(resetDb);

const TOTP_KEY = process.env.ADMIN_TOTP_KEY!;
const PASSWORD = "correct horse battery";

/** An admin straight in the database, with a 2FA secret the test can make codes from. */
async function makeAdmin(overrides: { disabled?: boolean } = {}) {
  const secret = newTotpSecret();
  const admin = await prisma.adminUser.create({
    data: {
      email: "ops@example.com",
      name: "Ops",
      passwordHash: await hashAdminPassword(PASSWORD),
      totpSecret: encryptSecret(secret, TOTP_KEY),
      disabledAt: overrides.disabled ? new Date() : null,
    },
  });
  // `offset` picks a code 30 s later, for a second login inside the same test.
  const code = (offset = 0) => totpAt(secret, stepAt(new Date()) + offset);
  return { admin, code };
}

const login = (body: { email?: string; password?: string; code: string }) =>
  api().post("/admin/v1/auth/login").send({ email: "ops@example.com", password: PASSWORD, ...body });

async function adminToken() {
  const { code } = await makeAdmin();
  const res = await login({ code: code() });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

describe("admin login", () => {
  it("needs the password and a current authenticator code", async () => {
    const { code } = await makeAdmin();
    const wrongCode = await login({ code: code() === "000000" ? "111111" : "000000" });
    expect(wrongCode.status).toBe(401);
    const wrongPassword = await login({ password: "nope", code: code() });
    expect(wrongPassword.status).toBe(401);
    // The same answer for every failure, so it never says which part was wrong.
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongCode.body.error.message).toBe(wrongPassword.body.error.message);

    const ok = await login({ code: code() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.admin.email).toBe("ops@example.com");
  });

  it("refuses a code that was already used", async () => {
    const { code } = await makeAdmin();
    const used = code();
    expect((await login({ code: used })).status).toBe(200);
    expect((await login({ code: used })).status).toBe(401);
    // The next 30-second code still works.
    expect((await login({ code: code(1) })).status).toBe(200);
  });

  it("refuses a disabled admin", async () => {
    const { code } = await makeAdmin({ disabled: true });
    expect((await login({ code: code() })).status).toBe(401);
  });

  it("keeps admin and customer tokens apart", async () => {
    const token = await adminToken();
    const owner = await signupOwner();
    expect((await api().get("/admin/v1/me").set(auth(owner.token))).status).toBe(401);
    expect((await api().get("/v1/me").set(auth(token))).status).toBe(401);
    expect((await api().get("/admin/v1/me").set(auth(token))).status).toBe(200);
  });

  it("ends access at once on logout or when the admin is disabled", async () => {
    const { code } = await makeAdmin();
    const first = (await login({ code: code() })).body.data.token;
    expect((await api().post("/admin/v1/auth/logout").set(auth(first))).status).toBe(204);
    const after = await api().get("/admin/v1/me").set(auth(first));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_EXPIRED");

    const second = (await login({ code: code(1) })).body.data.token;
    expect((await api().get("/admin/v1/me").set(auth(second))).status).toBe(200);
    await prisma.adminUser.update({ where: { email: "ops@example.com" }, data: { disabledAt: new Date() } });
    expect((await api().get("/admin/v1/me").set(auth(second))).status).toBe(401);
  });
});

describe("admin: organizations", () => {
  async function ownerWithStudent() {
    const owner = await signupOwner("Asha Verma");
    const lib = await createLibrary(owner);
    await addStudent(owner.token, lib.id, { seatId: lib.seats[0]!.id, name: "Private Student" });
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: owner.userId } });
    return { owner, lib, orgId: org.id };
  }

  it("lists and searches accounts, with counts but no student details", async () => {
    const token = await adminToken();
    const { orgId } = await ownerWithStudent();
    await signupOwner("Someone Else");

    const list = await api().get("/admin/v1/organizations").set(auth(token));
    expect(list.body.meta.total).toBe(2);
    const found = await api().get("/admin/v1/organizations?search=asha").set(auth(token));
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].branches).toBe(1);

    const detail = await api().get(`/admin/v1/organizations/${orgId}`).set(auth(token));
    expect(detail.body.data.branches[0].students).toBe(1);
    expect(detail.body.data.owner.name).toBe("Asha Verma");
    expect(JSON.stringify(detail.body)).not.toContain("Private Student");
  });

  it("extends a trial and records who did it and why", async () => {
    const token = await adminToken();
    const { orgId } = await ownerWithStudent();
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

    const res = await api()
      .post(`/admin/v1/organizations/${orgId}/extend-trial`)
      .set(auth(token))
      .send({ days: 7, reason: "Asked for more time to set up" });
    expect(res.status).toBe(200);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.trialEndsAt.getTime() - before.trialEndsAt.getTime()).toBe(7 * 86_400_000);

    const log = await api().get(`/admin/v1/audit-log?targetType=organization&targetId=${orgId}`).set(auth(token));
    expect(log.body.data[0].action).toBe("organization.extend_trial");
    expect(log.body.data[0].reason).toBe("Asked for more time to set up");
    expect(log.body.data[0].admin.email).toBe("ops@example.com");
  });

  it("reopens a trial that ran out before the owner paid, and refuses one for a paying account", async () => {
    const token = await adminToken();
    const { owner, lib, orgId } = await ownerWithStudent();
    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionStatus: "EXPIRED", trialEndsAt: new Date(Date.now() - 86_400_000) },
    });
    const addSeat = () => api().post(`/v1/libraries/${lib.id}/seats`).set(auth(owner.token)).send({ count: 1 });
    expect((await addSeat()).status).toBe(403);

    await api().post(`/admin/v1/organizations/${orgId}/extend-trial`).set(auth(token)).send({ days: 3, reason: "Goodwill" });
    expect((await addSeat()).status).toBe(201);

    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
    });
    const refused = await api()
      .post(`/admin/v1/organizations/${orgId}/extend-trial`)
      .set(auth(token))
      .send({ days: 3, reason: "Goodwill" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_IN_TRIAL");
  });

  it("suspends an account: data stays readable, changes are blocked until unsuspended", async () => {
    const token = await adminToken();
    const { owner, lib, orgId } = await ownerWithStudent();
    const addSeat = () => api().post(`/v1/libraries/${lib.id}/seats`).set(auth(owner.token)).send({ count: 1 });

    const suspended = await api().post(`/admin/v1/organizations/${orgId}/suspend`).set(auth(token)).send({ reason: "Chargeback" });
    expect(suspended.status).toBe(200);
    const blocked = await addSeat();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ACCOUNT_SUSPENDED");
    const dash = await api().get(`/v1/libraries/${lib.id}/dashboard`).set(auth(owner.token));
    expect(dash.status).toBe(200);
    expect(dash.body.data.subscription.suspended).toBe(true);

    const twice = await api().post(`/admin/v1/organizations/${orgId}/suspend`).set(auth(token)).send({ reason: "Again" });
    expect(twice.status).toBe(409);

    await api().post(`/admin/v1/organizations/${orgId}/unsuspend`).set(auth(token)).send({ reason: "Resolved" });
    expect((await addSeat()).status).toBe(201);
  });

  it("logs the owner out on every device", async () => {
    const token = await adminToken();
    const phone = nextPhone();
    const signup = await api().post("/v1/auth/signup").send({ name: "Lost Phone", identifier: phone, password: "password123" });
    const org = await prisma.organization.findFirstOrThrow({ where: { ownerId: signup.body.data.userId } });

    const res = await api()
      .post(`/admin/v1/organizations/${org.id}/revoke-sessions`)
      .set(auth(token))
      .send({ reason: "Owner lost their phone" });
    expect(res.body.data.sessionsRevoked).toBe(1);
    const refresh = await api().post("/v1/auth/refresh").send({ refreshToken: signup.body.data.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("needs a reason for every action", async () => {
    const token = await adminToken();
    const { orgId } = await ownerWithStudent();
    const res = await api().post(`/admin/v1/organizations/${orgId}/suspend`).set(auth(token)).send({});
    expect(res.status).toBe(400);
  });
});

describe("admin: overview and ops", () => {
  it("counts accounts and monthly revenue, spreading a yearly plan over 12 months", async () => {
    const token = await adminToken();
    await signupOwner();
    const paying = await signupOwner();
    const org = await prisma.organization.update({
      where: { ownerId: paying.userId },
      data: { subscriptionStatus: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 300 * 86_400_000) },
    });
    await prisma.subscriptionPayment.create({
      data: {
        organizationId: org.id,
        kind: "PLAN",
        plan: "YEARLY",
        months: 12,
        branches: 1,
        amountPaise: 999_000,
        status: "PAID",
        razorpayOrderId: "order_y",
        paidAt: new Date(),
      },
    });

    const res = await api().get("/admin/v1/overview").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.organizations.signupsLast7Days).toBe(2);
    expect(res.body.data.organizations.byStatus).toEqual({ TRIALING: 1, ACTIVE: 1 });
    expect(res.body.data.revenue.mrrPaise).toBe(83_250);
    expect(res.body.data.revenue.collectedLast30DaysPaise).toBe(999_000);
  });

  it("shows failed notices with the student's number masked", async () => {
    const token = await adminToken();
    const owner = await signupOwner();
    const lib = await createLibrary(owner);
    await prisma.notificationLog.create({
      data: {
        libraryId: lib.id,
        type: "OVERDUE_NOTICE",
        channel: "SMS",
        recipient: "+919876543210",
        referenceDate: new Date("2026-10-01T00:00:00.000Z"),
        status: "FAILED",
        error: "provider down",
      },
    });
    const res = await api().get("/admin/v1/ops/notifications").set(auth(token));
    expect(res.body.data[0].recipient).toBe("+91******3210");
    expect(JSON.stringify(res.body)).not.toContain("9876543210");
  });
});

describe("CORS", () => {
  it("answers browser preflights only for the configured apps", async () => {
    const preflight = (origin: string) =>
      api()
        .options("/admin/v1/overview")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization");
    const allowed = await preflight("https://admin.example.test");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://admin.example.test");
    const other = await preflight("https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
