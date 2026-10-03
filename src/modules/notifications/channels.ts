import { env } from "../../config/env";
import { getMessaging } from "../../lib/firebase";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import type { TextMessage } from "./templates";

/**
 * Where a message ends up. Each sender reports what happened; it never throws for a
 * delivery problem, so one failed message doesn't stop the rest of the job.
 */
export type SendResult =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: string };

/** Sends a registered template with its values (see templates.ts). */
export interface TextSender {
  channel: "SMS" | "WHATSAPP";
  send(toPhone: string, message: TextMessage): Promise<SendResult>;
}

export interface PushSender {
  send(userId: number, message: { title: string; body: string; data?: Record<string, string> }): Promise<SendResult>;
}

/**
 * Placeholder until an SMS / WhatsApp provider is connected. Logs the text so it can
 * be checked, and records the notice as SKIPPED.
 */
export class LoggingTextSender implements TextSender {
  constructor(public readonly channel: "SMS" | "WHATSAPP") {}

  async send(toPhone: string, message: TextMessage): Promise<SendResult> {
    logger.info(
      { channel: this.channel, toPhone, template: message.template, text: message.text },
      "Text notice (no provider configured)",
    );
    return { status: "SKIPPED", reason: "No SMS/WhatsApp provider configured" };
  }
}

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** Push to every phone a user is logged in on, through Firebase Cloud Messaging. */
export class FcmPushSender implements PushSender {
  async send(userId: number, message: { title: string; body: string; data?: Record<string, string> }): Promise<SendResult> {
    const messaging = getMessaging();
    if (!messaging) return { status: "SKIPPED", reason: "Push is not configured" };

    const devices = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true } });
    if (devices.length === 0) return { status: "SKIPPED", reason: "No registered devices" };

    try {
      const result = await messaging.sendEachForMulticast({
        tokens: devices.map((d) => d.token),
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: "high", notification: { sound: "default" } },
      });

      // Tokens of uninstalled apps are dropped so they aren't retried every day.
      const dead = result.responses
        .map((r, i) => (!r.success && DEAD_TOKEN_CODES.has(r.error?.code ?? "") ? devices[i]!.token : null))
        .filter((t): t is string => t !== null);
      if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });

      return result.successCount > 0
        ? { status: "SENT" }
        : { status: "FAILED", reason: result.responses[0]?.error?.message ?? "All devices failed" };
    } catch (err) {
      return { status: "FAILED", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function defaultSenders(): { text: TextSender; push: PushSender } {
  return {
    text: new LoggingTextSender(env.STUDENT_NOTICE_CHANNEL),
    push: new FcmPushSender(),
  };
}
