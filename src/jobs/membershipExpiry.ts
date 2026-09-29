import cron from "node-cron";
import { logger } from "../lib/logger";
import { processExpiringMembershipNotifications } from "../modules/notification/notificationController";

export const startMembershipExpiryJob = () => {
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        await processExpiringMembershipNotifications();
      } catch (error) {
        logger.error({ err: error }, "Membership expiry job failed");
      }
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
};
