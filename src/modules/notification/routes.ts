import express from "express";
import { authMiddleware } from "../../middleware/auth";
import {
  notifyLibraryOwnersForExpiringMemberships,
  registerNotificationToken,
} from "./notificationController";

const router = express.Router();
router.use(authMiddleware);

router.post("/register-notification-token", registerNotificationToken);
router.post("/test-notification", notifyLibraryOwnersForExpiringMemberships);
export default router;
