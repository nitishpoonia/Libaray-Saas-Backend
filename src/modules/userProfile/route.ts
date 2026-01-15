import express from "express";
import { authMiddleware } from "../../middleware/auth";
import {
  changePassword,
  getUserProfile,
  updateUserProfile,
} from "./controller";

const router = express.Router();
router.use(authMiddleware);

router.get("/my-profile", getUserProfile);
router.patch("/update-profile", updateUserProfile);
router.patch("/change-password", changePassword);
export default router;
