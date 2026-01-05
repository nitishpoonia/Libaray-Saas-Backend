import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import { getAllAvailableSeats } from "./controller";

const router = express.Router();
router.use(authMiddleware);

router.get("/:libraryId/available-seats", getAllAvailableSeats);

export default router;
