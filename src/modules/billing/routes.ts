import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { sendData } from "../../lib/http";
import { logger } from "../../lib/logger";
import { authMiddleware } from "../../middleware/auth";
import { requireUser } from "../../middleware/libraryAccess";
import { getGateway } from "./razorpay";
import { billingSummary, createOrder, markOrderPaid, verifyCheckout } from "./service";

const orderBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PLAN"), plan: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]) }),
  z.object({ kind: z.literal("BRANCH_ADDON") }),
]);

const verifyBody = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

async function summary(req: Request, res: Response) {
  sendData(res, await billingSummary(requireUser(req).id));
}

async function order(req: Request, res: Response) {
  const body = orderBody.parse(req.body);
  sendData(res, await createOrder(requireUser(req).id, body), undefined, 201);
}

async function verify(req: Request, res: Response) {
  const user = requireUser(req);
  await verifyCheckout(user.id, verifyBody.parse(req.body));
  sendData(res, await billingSummary(user.id));
}

/** Owner billing: /v1/billing */
export const billingRouter = Router();
billingRouter.use(authMiddleware);
billingRouter.get("/", summary);
billingRouter.post("/orders", order);
billingRouter.post("/verify", verify);

type WebhookEvent = {
  event: string;
  payload?: {
    order?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string; order_id?: string } };
  };
};

/**
 * Razorpay webhook (Dashboard > Webhooks, event `order.paid`). Backs up the app's
 * verify call for when the app closes before it can confirm. The signature is over
 * the raw body, so this route reads the body itself instead of through express.json.
 */
export const billingWebhook = Router();
billingWebhook.post("/", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
  const signature = req.header("x-razorpay-signature") ?? "";
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!getGateway().verifyWebhookSignature(raw, signature)) {
    res.status(400).json({ error: { code: "INVALID_SIGNATURE", message: "Bad signature" } });
    return;
  }

  const event = JSON.parse(raw.toString("utf8")) as WebhookEvent;
  if (event.event === "order.paid") {
    const orderId = event.payload?.order?.entity?.id ?? event.payload?.payment?.entity?.order_id;
    const paymentId = event.payload?.payment?.entity?.id;
    if (orderId && paymentId) {
      try {
        await markOrderPaid(orderId, paymentId);
      } catch (err) {
        // Orders from another system on the same Razorpay account aren't ours: acknowledge them.
        if (err instanceof AppError && err.code === "ORDER_NOT_FOUND") {
          req.log.warn({ orderId }, "Webhook for an unknown order");
        } else {
          // Anything else (database down, a restart mid-request) answers 500, so Razorpay
          // retries later instead of the owner's payment never being applied.
          throw err;
        }
      }
    }
  } else {
    logger.debug({ event: event.event }, "Ignored Razorpay webhook event");
  }
  res.status(200).json({ received: true });
});
