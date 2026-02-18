import cron from "node-cron";
import { processExpiringMembershipNotifications } from "../modules/notification/notificationController";

export const startMembershipExpiryJob = () => {
  cron.schedule(
    "35 20 * * *",
    async () => {
      console.log("Running membership expiry cron...");
      try {
        const result = await processExpiringMembershipNotifications();
        console.log("Cron job completed:", result);
      } catch (error) {
        console.error("Cron job failed:", error);
      }
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
};
