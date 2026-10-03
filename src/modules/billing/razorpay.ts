import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

export type RazorpayOrder = { id: string; amount: number; currency: string };

export interface PaymentGateway {
  keyId: string;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder>;
  /** Signature the app sends back after checkout. */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Signature on webhook calls, over the raw request body. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

function hmacMatches(secret: string, payload: string | Buffer, signature: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class RazorpayGateway implements PaymentGateway {
  constructor(
    public readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret?: string,
  ) {}

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt,
        notes: input.notes,
      }),
    });
    if (!res.ok) {
      throw new AppError(502, "PAYMENT_GATEWAY_ERROR", `Razorpay rejected the order (${res.status})`);
    }
    return (await res.json()) as RazorpayOrder;
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return hmacMatches(this.keySecret, `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string) {
    if (!this.webhookSecret) return false;
    return hmacMatches(this.webhookSecret, rawBody, signature);
  }
}

let gateway: PaymentGateway | null | undefined;

/** The configured gateway; answers 503 when Razorpay keys aren't set. */
export function getGateway(): PaymentGateway {
  if (gateway === undefined) {
    gateway =
      env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
        ? new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET)
        : null;
  }
  if (!gateway) {
    throw new AppError(503, "BILLING_NOT_CONFIGURED", "Online payment isn't set up yet");
  }
  return gateway;
}

/** Tests swap in a fake gateway. */
export function setGateway(next: PaymentGateway | null) {
  gateway = next;
}
