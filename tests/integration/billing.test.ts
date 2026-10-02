import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "../../src/lib/dates";
import { prisma } from "../../src/lib/prisma";
import type { PaymentGateway } from "../../src/modules/billing/razorpay";
import { RazorpayGateway, setGateway } from "../../src/modules/billing/razorpay";
import { runDailyJob } from "../../src/modules/notifications/daily";
import type { PushSender, SendResult, TextSender } from "../../src/modules/notifications/channels";
import { api, auth, createLibrary, resetDb, signupOwner } from "./helpers";

const SECRET = "test_key_secret";
const WEBHOOK_SECRET = "test_webhook_secret";

/** The real gateway's signature checks, with order creation faked (no network). */
class FakeGateway extends RazorpayGateway implements PaymentGateway {
  private n = 0;
  constructor() {
    super("rzp_test_key", SECRET, WEBHOOK_SECRET);
  }
  override async createOrder(input: { amountPaise: number }) {
    this.n += 1;
    return { id: `order_${this.n}`, amount: input.amountPaise, currency: "INR" };
  }
}

const sign = (orderId: string, paymentId: string) =>
  createHmac("sha256", SECRET).update(`${orderId}|${paymentId}`).digest("hex");

beforeEach(async () => {
  await resetDb();
  setGateway(new FakeGateway());
});
afterAll(() => setGateway(null));

async function buy(token: string, body: object, paymentId: string) {
  const order = await api().post("/v1/billing/orders").set(auth(token)).send(body);
  expect(order.status).toBe(201);
  const verify = await api()
    .post("/v1/billing/verify")
    .set(auth(token))
    .send({ orderId: order.body.data.orderId, paymentId, signature: sign(order.body.data.orderId, paymentId) });
  return { order, verify };
}

describe("billing", () => {
  it("quotes plans by branch count and needs a Razorpay key", async () => {
    const owner = await signupOwner();
    await createLibrary(owner);
    await createLibrary(owner);
    const summary = await api().get("/v1/billing").set(auth(owner.token));
    expect(summary.body.data.status).toBe("TRIALING");
    expect(summary.body.data.plans).toEqual([
      { plan: "MONTHLY", months: 1, amountPaise: 149_800 },
      { plan: "QUARTERLY", months: 3, amountPaise: 449_400 },
      { plan: "YEARLY", months: 12, amountPaise: 1_498_000 },
    ]);
    expect(summary.body.data.razorpayKeyId).toBe("rzp_test_key");

    setGateway(null);
    const noKeys = await api().post("/v1/billing/orders").set(auth(owner.token)).send({ kind: "PLAN", plan: "MONTHLY" });
    expect(noKeys.status).toBe(503);
  });

  it("starts a paid plan after the trial so no trial days are lost", async () => {
    const owner = await signupOwner();
    await createLibrary(owner);
    const { verify } = await buy(owner.token, { kind: "PLAN", plan: "QUARTERLY" }, "pay_1");
    expect(verify.status).toBe(200);

    const org = await prisma.organization.findFirstOrThrow();
    expect(org.subscriptionStatus).toBe("ACTIVE");
    const monthsAfterTrial = (org.currentPeriodEnd!.getTime() - org.trialEndsAt.getTime()) / (86_400_000 * 30);
    expect(Math.round(monthsAfterTrial)).toBe(3);
  });

  it("rejects a forged signature and someone else's order", async () => {
    const owner = await signupOwner("Owner A");
    const other = await signupOwner("Owner B");
    const order = await api().post("/v1/billing/orders").set(auth(owner.token)).send({ kind: "PLAN", plan: "MONTHLY" });
    const orderId = order.body.data.orderId;

    const forged = await api().post("/v1/billing/verify").set(auth(owner.token)).send({ orderId, paymentId: "pay_x", signature: "0".repeat(64) });
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");

    const stolen = await api().post("/v1/billing/verify").set(auth(other.token)).send({ orderId, paymentId: "pay_x", signature: sign(orderId, "pay_x") });
    expect(stolen.status).toBe(404);
    expect((await prisma.organization.findFirstOrThrow({ where: { ownerId: owner.userId } })).subscriptionStatus).toBe("TRIALING");
  });

  it("applies a payment once whether the app or the webhook confirms first", async () => {
    const owner = await signupOwner();
    const { order } = await buy(owner.token, { kind: "PLAN", plan: "MONTHLY" }, "pay_1");
    const end1 = (await prisma.organization.findFirstOrThrow()).currentPeriodEnd;

    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: order.body.data.orderId } }, payment: { entity: { id: "pay_1" } } },
    });
    const webhook = await api()
      .post("/v1/billing/webhook")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"))
      .send(body);
    expect(webhook.status).toBe(200);
    expect((await prisma.organization.findFirstOrThrow()).currentPeriodEnd).toEqual(end1);

    const badSig = await api().post("/v1/billing/webhook").set("x-razorpay-signature", "nope").set("content-type", "application/json").send(body);
    expect(badSig.status).toBe(400);
  });

  it("confirms through the webhook alone when the app never calls verify", async () => {
    const owner = await signupOwner();
    const order = await api().post("/v1/billing/orders").set(auth(owner.token)).send({ kind: "PLAN", plan: "YEARLY" });
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: order.body.data.orderId } }, payment: { entity: { id: "pay_9" } } },
    });
    await api()
      .post("/v1/billing/webhook")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"))
      .send(body);
    expect((await prisma.organization.findFirstOrThrow()).subscriptionStatus).toBe("ACTIVE");
  });

  it("answers 500 when applying the payment fails, so Razorpay retries", async () => {
    const owner = await signupOwner();
    const order = await api().post("/v1/billing/orders").set(auth(owner.token)).send({ kind: "PLAN", plan: "MONTHLY" });
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: order.body.data.orderId } }, payment: { entity: { id: "pay_7" } } },
    });
    const send = () =>
      api()
        .post("/v1/billing/webhook")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"))
        .send(body);

    // The database drops out while the payment is being applied.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection lost"));
    const failed = await send();
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect((await prisma.organization.findFirstOrThrow()).subscriptionStatus).toBe("TRIALING");

    // Razorpay's retry goes through.
    expect((await send()).status).toBe(200);
    expect((await prisma.organization.findFirstOrThrow()).subscriptionStatus).toBe("ACTIVE");
  });

  it("acknowledges webhooks for orders that aren't ours", async () => {
    const body = JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_other_app" } }, payment: { entity: { id: "pay_x" } } },
    });
    const res = await api()
      .post("/v1/billing/webhook")
      .set("content-type", "application/json")
      .set("x-razorpay-signature", createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"))
      .send(body);
    expect(res.status).toBe(200);
  });

  it("shows branches added after checkout opened as unpaid", async () => {
    const owner = await signupOwner();
    await createLibrary(owner);
    // Checkout opens for 1 branch (e.g. a UPI request the owner approves hours later)...
    const order = await api().post("/v1/billing/orders").set(auth(owner.token)).send({ kind: "PLAN", plan: "MONTHLY" });
    expect(order.body.data.amountPaise).toBe(99_900);
    // ...meanwhile, still in the trial, two more branches are added.
    await createLibrary(owner);
    await createLibrary(owner);
    const verify = await api()
      .post("/v1/billing/verify")
      .set(auth(owner.token))
      .send({ orderId: order.body.data.orderId, paymentId: "pay_1", signature: sign(order.body.data.orderId, "pay_1") });
    expect(verify.status).toBe(200);
    expect(verify.body.data.billedBranches).toBe(1);
    expect(verify.body.data.unpaidBranches).toBe(2);
    expect(verify.body.data.branchAddon.amountPaise).toBeGreaterThan(0);

    await buy(owner.token, { kind: "BRANCH_ADDON" }, "pay_2");
    const after = await api().get("/v1/billing").set(auth(owner.token));
    expect(after.body.data.unpaidBranches).toBe(1);
  });

  it("charges for an extra branch during a paid period", async () => {
    const owner = await signupOwner();
    await createLibrary(owner);
    // End the trial so the plan starts now.
    await prisma.organization.updateMany({ data: { trialEndsAt: new Date(Date.now() + 1000) } });
    await new Promise((r) => setTimeout(r, 1100));
    await buy(owner.token, { kind: "PLAN", plan: "MONTHLY" }, "pay_1");

    const blocked = await api().post("/v1/libraries").set(auth(owner.token)).send({ name: "Branch 2", address: "Hisar", seatCount: 5 });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("BRANCH_PAYMENT_REQUIRED");
    expect(blocked.body.error.details.amountPaise).toBeGreaterThan(40_000);

    await buy(owner.token, { kind: "BRANCH_ADDON" }, "pay_2");
    const allowed = await api().post("/v1/libraries").set(auth(owner.token)).send({ name: "Branch 2", address: "Hisar", seatCount: 5 });
    expect(allowed.status).toBe(201);

    // The next renewal is priced for both branches.
    const summary = await api().get("/v1/billing").set(auth(owner.token));
    expect(summary.body.data.plans[0].amountPaise).toBe(149_800);
  });

  it("keeps branches free during the trial", async () => {
    const owner = await signupOwner();
    await createLibrary(owner);
    await createLibrary(owner);
    expect((await api().get("/v1/libraries").set(auth(owner.token))).body.data).toHaveLength(2);
  });
});

describe("daily subscription sweep", () => {
  class FakePush implements PushSender {
    sent: Array<{ userId: number; title: string }> = [];
    async send(userId: number, m: { title: string }): Promise<SendResult> {
      this.sent.push({ userId, title: m.title });
      return { status: "SENT" };
    }
  }
  const text: TextSender = { channel: "SMS", send: async () => ({ status: "SENT" }) };

  it("reminds the owner 3 days before the trial ends, once, and expires ended trials", async () => {
    const owner = await signupOwner("Owner A");
    await createLibrary(owner);
    const late = await signupOwner("Owner B");
    await createLibrary(late);

    await prisma.organization.updateMany({
      where: { ownerId: owner.userId },
      // Noon IST, three calendar days from today.
      data: { trialEndsAt: new Date(`${addDays(todayIn("Asia/Kolkata"), 3)}T12:00:00+05:30`) },
    });
    await prisma.organization.updateMany({
      where: { ownerId: late.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });

    const push = new FakePush();
    await runDailyJob({ text, push });
    await runDailyJob({ text, push });

    const reminders = push.sent.filter((p) => p.title.startsWith("Your free trial"));
    expect(reminders).toEqual([{ userId: owner.userId, title: "Your free trial ends in 3 days" }]);
    const lateOrg = await prisma.organization.findFirstOrThrow({ where: { ownerId: late.userId } });
    expect(lateOrg.subscriptionStatus).toBe("EXPIRED");
  });
});
