import admin from "firebase-admin";
import { env } from "../config/env";
import { logger } from "./logger";

let messaging: admin.messaging.Messaging | null | undefined;

/**
 * Returns Firebase Messaging, or null when FIREBASE_SERVICE_ACCOUNT isn't set
 * (local development, tests). Initialised once, on first use.
 */
export function getMessaging(): admin.messaging.Messaging | null {
  if (messaging !== undefined) return messaging;

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    logger.warn("FIREBASE_SERVICE_ACCOUNT not set; push notifications are disabled");
    messaging = null;
    return messaging;
  }

  const app = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)),
  });
  messaging = app.messaging();
  return messaging;
}
