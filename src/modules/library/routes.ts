import express from "express";
import { authMiddleware } from "../../middleware/auth.js";
import {
  createLibrary,
  getLibraries,
  getLibraryOverview,
} from "./controller.js";
import { subscriptionCheck } from "../../middleware/subscriptionCheck.js";

const router = express.Router();
router.use(authMiddleware);
router.get("/my-libraries", getLibraries);
router.get("/:id/overview", getLibraryOverview);

router.post("/", subscriptionCheck, createLibrary);

export default router;
