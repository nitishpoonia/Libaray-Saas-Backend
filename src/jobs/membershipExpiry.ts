import cron from "node-cron";
import { notifyLibraryOwnersForExpiringMemberships } from "../modules/notification/notificationController";

export const startMembershipExpiryJob = () => {
  cron.schedule(
    "35 19 * * *",
    async () => {
      console.log("Running membership expiry cron...");
      await notifyLibraryOwnersForExpiringMemberships();
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
};
